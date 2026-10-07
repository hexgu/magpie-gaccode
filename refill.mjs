// Ticket requests. Quota reads never enter this module's write path.
import { createHash } from "node:crypto"
import { constants } from "node:fs"
import { lstat, mkdir, open, readFile } from "node:fs/promises"
import { isAbsolute, join } from "node:path"

const SITE = "https://gaccode.com/api"
const CATEGORY = "REQUEST_TO_REFILL_CREDIT"
class RefillStop extends Error {}
const TITLES = new Set(["请求重置积分", "Request Credit Refill", "クレジット補充をお願いします"])
const hash = (value) => createHash("sha256").update(value).digest("hex")
const tokenOf = (auth) => typeof auth?.metadata?.loginToken === "string" ? auth.metadata.loginToken.trim() : ""
const validId = (value) => (typeof value === "string" && !!value.trim()) || (Number.isSafeInteger(value) && value > 0)
const emailOf = (value) => typeof value === "string" && /^[^\s@]+@[^\s@]+$/.test(value) ? value.toLowerCase() : ""

export function beijingDay(time = Date.now()) {
  return new Date(time + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

// This is deliberately narrower than generic insufficient_quota/rate_limit errors.
export async function exhaustedCredits(response) {
  // Permission/server failures must never authorize a ticket, even if their
  // body mentions credits. 429 additionally requires an explicit credit code.
  if (![402, 429].includes(response.status) || !/\bapplication\/(?:[\w.-]+\+)?json\b/i.test(response.headers.get("content-type") ?? "")) return false
  const reader = response.clone().body?.getReader()
  if (!reader) return false
  let timer
  try {
    const body = await Promise.race([
      (async () => {
        const chunks = []
        let size = 0
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          size += value.byteLength
          if (size > 64 * 1024) throw new Error("Error body too large")
          chunks.push(Buffer.from(value))
        }
        return JSON.parse(Buffer.concat(chunks).toString("utf8"))
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Error body timeout")), 1000) }),
    ])
    const error = body?.error
    if (!error) return false
    const creditCodes = ["insufficient_credits", "credits_exhausted", "credit_balance_exhausted"]
    if (response.status === 429) return creditCodes.includes(error?.code)
    const code = typeof error === "object" ? error.code ?? error.type : body.code
    if (creditCodes.includes(code)) return true
    const message = typeof error === "string" ? error : error.message
    return typeof message === "string" && /\binsufficient credits?\b|\bcredits?(?: balance)? (?:is |are )?(?:exhausted|depleted)\b|积分(?:已)?(?:耗尽|用尽|不足)/i.test(message)
  } catch { return false }
  finally {
    clearTimeout(timer)
    // Never wait for tee cancellation: that can wait on the untouched original.
    void reader.cancel().catch(() => {})
  }
}

async function siteJson(path, token, signal, payload) {
  const response = await fetch(SITE + path, {
    method: payload === undefined ? "GET" : "POST",
    redirect: "error",
    headers: {
      accept: "application/json", authorization: `Bearer ${token}`, "accept-language": "zh",
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    signal,
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  })
  if (!response.ok) throw new RefillStop(`网站请求 HTTP ${response.status}`)
  return response.json()
}

async function existingTicket(token, signal, categoryId, day) {
  const ids = new Set()
  let total, pages
  for (let page = 1; page <= 50; page++) {
    const body = await siteJson(`/tickets?page=${page}&limit=20`, token, signal)
    const rows = body?.tickets
    const p = body?.pagination
    // No inference from a short page: require the public frontend's pagination.
    if (!Array.isArray(rows) || !p || p.page !== page || p.limit !== 20 ||
        !Number.isSafeInteger(p.total) || p.total < 0 || !Number.isSafeInteger(p.pages) ||
        !(p.pages === Math.ceil(p.total / 20) || (p.total === 0 && p.pages === 1)) ||
        (total !== undefined && (p.total !== total || p.pages !== pages)) ||
        rows.length !== Math.min(20, Math.max(0, p.total - (page - 1) * 20))) {
      throw new RefillStop("工单分页未知或不完整")
    }
    total = p.total
    pages = p.pages
    for (const ticket of rows) {
      if (!validId(ticket?.id) || ids.has(String(ticket.id))) throw new RefillStop("工单列表重复或字段缺失")
      ids.add(String(ticket.id))
      const key = ticket?.category?.key
      if (!key && !validId(ticket?.categoryId) && !TITLES.has(ticket?.title)) throw new RefillStop("工单类别字段缺失")
      if (key !== CATEGORY && String(ticket.categoryId) !== String(categoryId) && !TITLES.has(ticket.title)) continue
      // Both website waiting states are pending, regardless of creation day.
      if (["WAITING_FOR_SUPPORT", "WAITING_FOR_USER"].includes(ticket.status)) return true
      const raw = ticket.createdAt
      const time = typeof raw === "string" && /(?:Z|[+-]\d\d:\d\d)$/.test(raw) ? Date.parse(raw) : NaN
      if (!Number.isFinite(time) || ticket.status !== "CLOSED") throw new RefillStop("重置工单日期或状态未知")
      if (beijingDay(time) === day) return true
    }
    if (page >= pages) return false
  }
  throw new RefillStop("工单分页未读完")
}

function statusText(record) {
  if (!record) return "待触发"
  if (record.status === "submitted") return "已申请"
  if (record.status === "existing") return "已有同日申请或待处理工单"
  if (record.status === "attempt") return "申请结果未知，今日不重试"
  if (record.status === "checking") return "检查中或上次已中断，今日不重试"
  return `失败（${record.reason ?? "状态未知"}），今日不重试`
}

export function createAutoRefill({ enabled = false, directory, now = Date.now } = {}) {
  const enabledFor = (auth) => typeof enabled === "function" ? enabled(auth) : enabled
  const root = typeof directory === "string" && isAbsolute(directory) ? join(directory, ".gaccode-refill") : null
  const seen = new Map()
  const keyOf = (auth) => hash(`${auth?.key ?? ""}\0${tokenOf(auth)}`)
  const statePath = (id, day) => join(root, `${hash(String(id))}-${day}.jsonl`)

  async function storage(create) {
    if (!root || !(await lstat(directory)).isDirectory()) throw new RefillStop("宿主目录不可用")
    if (create) await mkdir(root, { mode: 0o700 }).catch((e) => { if (e.code !== "EEXIST") throw e })
    const info = await lstat(root)
    if (!info.isDirectory() || (info.mode & 0o077)) throw new RefillStop("状态目录权限不安全")
  }

  async function readState(id, day) {
    const path = statePath(id, day)
    const info = await lstat(path)
    if (!info.isFile() || (info.mode & 0o777) !== 0o600 || info.size > 16 * 1024) throw new RefillStop("状态文件不可用")
    const records = (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line))
    if (!records.length || records.some((r) => r.day !== day || !["checking", "attempt", "submitted", "existing", "failed"].includes(r.status))) throw new RefillStop("状态文件损坏")
    return records.at(-1)
  }

  async function observe(auth, response, statusUrl) {
    if (!enabledFor(auth) || !await exhaustedCredits(response)) return
    const day = beijingDay(now())
    const key = keyOf(auth)
    if (seen.get(key)?.day === day) return
    // Also suppress same-instance races before /me has supplied the account id.
    const entry = { day, status: "checking" }
    seen.set(key, entry)
    let file
    let attempted = false
    const save = async (status, reason) => {
      Object.assign(entry, { status, reason })
      if (file) {
        await file.writeFile(JSON.stringify({ day, status, ...(reason ? { reason } : {}) }) + "\n")
        await file.sync()
      }
    }
    try {
      const token = tokenOf(auth)
      if (!token) throw new RefillStop("需网站 JWT（metadata.loginToken）")
      await storage(true)
      const signal = AbortSignal.timeout(12_000)
      const me = await siteJson("/me", token, signal)
      const id = me?.user?.id
      if (!validId(id)) throw new RefillStop("网站 account id 缺失")
      entry.id = id
      try {
        // The permanent per-account/day ledger is also an atomic file lock.
        // Never remove/reclaim it: a crash or unknown POST result must not retry.
        file = await open(statePath(id, day), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      } catch (error) {
        if (error.code !== "EEXIST") throw error
        Object.assign(entry, await readState(id, day))
        return
      }
      await save("checking")
      const statusResponse = await fetch(statusUrl, {
        method: "GET", redirect: "error", headers: { accept: "application/json", "x-api-key": auth.key }, signal,
      })
      if (!statusResponse.ok) throw new RefillStop("API key 身份读取失败")
      const status = await statusResponse.json()
      const siteEmail = emailOf(me.user.email)
      const keyEmails = [status?.email, status?.user?.email].filter((v) => v !== undefined)
      const keyIds = [status?.userId, status?.user?.id].filter((v) => v !== undefined)
      if (!siteEmail || !keyEmails.length || keyEmails.some((v) => emailOf(v) !== siteEmail) ||
          keyIds.some((v) => !validId(v) || String(v) !== String(id))) throw new RefillStop("网站与 API key 身份缺失或不一致")
      if (typeof status.balance !== "number" || !Number.isFinite(status.balance)) throw new RefillStop("账户积分余额缺失或格式未知")
      if (status.balance > 0) throw new RefillStop("账户仍有积分，不申请")
      if (Object.hasOwn(status, "effectiveBalance")) {
        if (typeof status.effectiveBalance !== "number" || !Number.isFinite(status.effectiveBalance)) throw new RefillStop("账户有效积分余额格式未知")
        if (status.effectiveBalance > 0) throw new RefillStop("账户仍有有效积分，不申请")
      }
      const categories = await siteJson("/tickets/categories", token, signal)
      const matches = Array.isArray(categories?.categories) ? categories.categories.filter((c) => c?.key === CATEGORY) : []
      if (matches.length !== 1 || !validId(matches[0].id)) throw new RefillStop("重置类别缺失或不唯一")
      const captcha = await siteJson("/tickets/recaptcha-required", token, signal)
      if (captcha?.requiresRecaptcha !== false) throw new RefillStop("需验证码或验证码要求未知，请到官网处理")
      if (await existingTicket(token, signal, matches[0].id, day)) {
        await save("existing")
        return
      }
      if (beijingDay(now()) !== day || signal.aborted) throw new RefillStop("日期已切换或检查超时")
      await save("attempt") // fsync BEFORE POST, including timeouts with unknown results.
      attempted = true
      const result = await siteJson("/tickets", token, signal, {
        categoryId: matches[0].id, title: "请求重置积分",
        description: "托管推理请求返回积分耗尽错误，申请重置积分。此申请不代表积分已到账。", language: "zh",
      })
      if (!validId(result?.ticket?.id)) throw new RefillStop("申请返回格式未知")
      await save("submitted")
    } catch (error) {
      // Never copy upstream bodies/messages (which may contain credentials) into state.
      try { await save(attempted ? "attempt" : "failed", attempted ? undefined : error instanceof RefillStop ? error.message : "读取或状态存储失败") } catch {}
    } finally {
      try { await file?.close() } catch {}
    }
  }

  async function text(auth, meResult) {
    const prefix = "自动申请："
    if (!enabledFor(auth)) return prefix + "选项关闭"
    if (!tokenOf(auth)) return prefix + "需网站 JWT（metadata.loginToken）"
    if (meResult?.status === "rejected") return prefix + "网站身份读取失败，暂停申请" +
      (meResult.reason?.status === 401 ? "，请更新 JWT" : "")
    const me = meResult?.status === "fulfilled" ? meResult.value : undefined
    if (!root) return prefix + "失败（宿主目录不可用）"
    try {
      if (!(await lstat(directory)).isDirectory()) throw new RefillStop("宿主目录不可用")
    } catch { return prefix + "失败（宿主目录不可用）" }
    const day = beijingDay(now())
    const entry = seen.get(keyOf(auth))
    const id = me?.user?.id ?? (entry?.day === day ? entry.id : undefined)
    if (validId(id)) {
      try {
        await storage(false)
        return prefix + statusText(await readState(id, day))
      } catch (e) {
        if (e.code !== "ENOENT") return prefix + "失败（状态文件不可用），今日不重试"
      }
    }
    return prefix + statusText(entry?.day === day ? entry : undefined)
  }

  return { observe, text }
}
