import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

const source = process.argv[2]
if (!source) throw new Error("请指定未修改的 Magpie 源码目录")
const hostPath = path.resolve(source, "internal/plugin/host.js")
const pluginPath = fileURLToPath(new URL("../index.mjs", import.meta.url))
await readFile(hostPath)

// 宿主只读取这个临时合成凭证文件；所有查询都由本地响应替代。
const home = await mkdtemp(path.join(tmpdir(), "gaccode-native-"))
const authPath = path.join(home, "synthetic-auth.json")
const wrapper = path.join(home, "host-fixture.mjs")
const balances = [9600, 7200, 2400, 0, 6000, 22000, -10]
await writeFile(authPath, JSON.stringify({
  gaccode: { type: "api", key: "synthetic-key" },
  "gaccode#website": { type: "api", key: "synthetic-website-key", metadata: { loginToken: "synthetic-jwt" } },
  "gaccode#unknown": { type: "api", key: "synthetic-unknown-key", metadata: { loginToken: "synthetic-jwt" } },
}), { mode: 0o600 })
await writeFile(wrapper, `
import assert from "node:assert/strict"
let reading = 0
globalThis.fetch = async (input, init) => {
  const req = new Request(input, init), url = new URL(req.url)
  assert.equal(req.method, "GET", "查询必须只读")
  assert.equal(url.origin, "https://gaccode.com", "不能发出真实或越界请求")
  const key = req.headers.get("x-api-key")
  if (url.pathname === "/claudecode/v1/models") return Response.json({ data: [{ id: "claude-sonnet-5-5" }] })
  if (url.pathname === "/codex/v1/models") return Response.json({ data: [{ id: "gpt-6.1-sol" }] })
  if (url.pathname === "/claudecode/v1/cc-status-line") {
    assert.equal(req.headers.get("authorization"), null, "网站凭证不能替代 API key")
    if (key === "synthetic-key") {
      assert(reading < ${balances.length}, "读取次数超出合成数据")
      return Response.json({ balance: ${JSON.stringify(balances)}[reading++], creditCap: 12000, refillRate: 300, user: { email: "key@example.invalid" } })
    }
    assert(["synthetic-website-key", "synthetic-unknown-key"].includes(key), "合成 key 未知")
    return Response.json({ balance: 2400, creditCap: key === "synthetic-unknown-key" ? 0 : 12000, user: { email: "key@example.invalid" } })
  }
  assert.equal(key, null, "API key 不能进入网站接口")
  assert.equal(req.headers.get("authorization"), "Bearer synthetic-jwt", "网站仅接受合成凭证")
  if (url.pathname === "/api/credits/balance") return Response.json({ balance: 22000, creditCap: 12000, refillRate: 300 })
  if (url.pathname === "/api/me") return Response.json({ email: "website@example.invalid" })
  if (url.pathname === "/api/subscriptions") return Response.json({ subscriptions: [] })
  if (url.pathname === "/api/usd-account") return Response.json({ account: null })
  if (url.pathname === "/api/credits/booster-packs") return Response.json({ boosterPacks: [] })
  if (url.pathname === "/api/tickets" && url.search === "?page=1&limit=20") return Response.json({ tickets: [] })
  throw new Error("未配置合成响应")
}
await import(${JSON.stringify(pathToFileURL(hostPath).href)})
`)

const pending = new Map()
const host = Bun.spawn([process.execPath, "--no-env-file", wrapper], {
  cwd: home,
  env: { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), PATH: "/usr/bin:/bin" },
  stdin: "pipe", stdout: "pipe", stderr: "ignore",
})
const watchdog = setTimeout(() => host.kill(), 30000)
const rejectPending = (error) => {
  for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(error) }
  pending.clear()
}
const output = (async () => {
  const decoder = new TextDecoder()
  let buffer = ""
  try {
    for await (const chunk of host.stdout) {
      buffer += decoder.decode(chunk, { stream: true })
      let end
      while ((end = buffer.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffer.slice(0, end))
        buffer = buffer.slice(end + 1)
        const waiter = pending.get(message.id)
        if (!waiter) continue
        pending.delete(message.id)
        clearTimeout(waiter.timer)
        message.error ? waiter.reject(new Error("宿主返回调用错误")) : waiter.resolve(message.result)
      }
    }
  } catch {
    rejectPending(new Error("宿主响应格式错误"))
  } finally {
    rejectPending(new Error("宿主已退出"))
  }
})()
let nextID = 0
const rpc = (method, params) => new Promise((resolve, reject) => {
  const id = ++nextID
  const timer = setTimeout(() => {
    pending.delete(id)
    reject(new Error("宿主调用超过 10 秒"))
  }, 10000)
  pending.set(id, { resolve, reject, timer })
  try {
    host.stdin.write(JSON.stringify({ id, method, params }) + "\n")
    host.stdin.flush()
  } catch {
    clearTimeout(timer)
    pending.delete(id)
    reject(new Error("无法写入宿主请求"))
  }
})
const check = (usage) => {
  assert.equal(usage.error, "", "普通用量查询应成功")
  assert.equal(usage.signIn, "kept")
  assert.equal(usage.balanceTelemetry, undefined, "此验证要求未扩展的官方宿主")
  assert.equal(usage.balanceTrend, undefined, "普通窗口不会自动生成绝对余额预测")
  for (const window of usage.windows) {
    assert.equal(window.span, 0)
    assert.equal(window.resetsAt, "")
    assert.equal(window.resetSecs, 0)
    // 原版宿主将未提供的计数字段归一化为零，不伪造累计消费。
    assert.equal(window.amount, 0)
    assert.equal(window.limit, 0)
    assert.equal(window.unit, "")
  }
}
try {
  const init = await rpc("init", {
    authPath, directory: home,
    plugins: [{ spec: "gaccode-native-verification", target: pluginPath, options: { experimentalGemini: false, autoRequestRefill: false } }],
  })
  assert.equal(init.plugins.length, 1)
  assert.equal(init.plugins[0].error, undefined, "插件应加载成功")
  for (const [index, used] of [20, 40, 80, 100, 50, 0, 100].entries()) {
    const usage = await rpc("usage", { provider: "gaccode", account: "gaccode" })
    check(usage)
    assert.equal(usage.balance, `${balances[index]} 积分`)
    assert.equal(usage.windows.length, 1)
    assert.equal(usage.windows[0].name, "积分余量")
    assert.equal(usage.windows[0].aside, false)
    assert(Math.abs(usage.windows[0].used - used) < 1e-8)
  }
  const website = await rpc("usage", { provider: "gaccode", account: "gaccode#website" })
  check(website)
  assert.equal(website.balance, "22000 积分")
  assert.equal(website.windows.length, 2)
  assert.equal(website.windows[0].aside, true)
  assert.equal(website.windows[1].aside, false)
  assert.equal(website.windows[1].name, "积分余量")
  assert.equal(website.windows[1].used, 80)
  const unknown = await rpc("usage", { provider: "gaccode", account: "gaccode#unknown" })
  check(unknown)
  assert.equal(unknown.windows.length, 1)
  assert.equal(unknown.windows[0].aside, true)
  assert.match(unknown.windows[0].display, /路由用量未知/)
  console.log("未修改官方宿主：9 次插件调用通过，普通窗口保留路由比例及来源隔离，无虚构周期或累计消费")
} finally {
  host.kill()
  await host.exited
  await output
  clearTimeout(watchdog)
  await rm(home, { recursive: true, force: true })
}
