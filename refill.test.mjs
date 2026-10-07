import { afterEach, beforeEach, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { GacCodePlugin } from "./index.mjs"
import { beijingDay, createAutoRefill } from "./refill.mjs"

const originalFetch = globalThis.fetch
const dirs = []
const auth = { type: "api", key: "fake-key", metadata: { host: "https://relay05.gaccode.com", loginToken: "fake-site-jwt" } }
const email = "fixture@example.invalid"
const statusPath = "/claudecode/v1/cc-status-line"
const statusUrl = "https://relay05.gaccode.com" + statusPath
const inferenceUrl = "https://gaccode.com/codex/v1/responses"
const errorBody = '{"error":{"code":"insufficient_credits","message":"Insufficient credits"}}'
const refused = () => new Response(errorBody, { status: 429, statusText: "Fixture exhausted", headers: {
  "content-type": "application/json", "content-length": String(Buffer.byteLength(errorBody)), "retry-after": "17", "x-fixture": "preserved",
} })
const emptyTickets = { tickets: [], pagination: { page: 1, limit: 20, total: 0, pages: 0 } }
const usageText = (u) => [u.balance, u.error, ...u.windows.map((w) => w.display)].join(" | ")

beforeEach(() => { globalThis.fetch = async () => { throw new Error("unexpected network request") } })
afterEach(async () => {
  globalThis.fetch = originalFetch
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function temp() {
  const dir = await mkdtemp(join(tmpdir(), "gaccode-refill-test-"))
  dirs.push(dir)
  return dir
}

function mock(replies = {}, inference = refused) {
  const seen = []
  const responses = []
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init)
    seen.push(req)
    const url = new URL(req.url)
    const path = url.pathname + url.search
    if (!url.pathname.startsWith("/api/") && path !== statusPath) {
      const response = typeof inference === "function" ? inference() : inference
      responses.push(response)
      return response
    }
    const defaults = {
      [statusPath]: { email, userId: 42, balance: 0, creditCap: 100 },
      "/api/me": { user: { id: 42, email } },
      "/api/tickets/categories": { categories: [{ id: 9, key: "REQUEST_TO_REFILL_CREDIT" }] },
      "/api/tickets/recaptcha-required": { requiresRecaptcha: false },
      "/api/tickets?page=1&limit=20": emptyTickets,
      "/api/tickets": { ticket: { id: 123 } },
      "/api/subscriptions": { subscriptions: [] },
      "/api/usd-account": { account: null },
      "/api/credits/booster-packs": { boosterPacks: [] },
    }
    let value = Object.hasOwn(replies, path) ? replies[path] : defaults[path]
    if (typeof value === "function") value = await value(req)
    if (value instanceof Error) throw value
    if (value instanceof Response) return value.clone()
    if (value === undefined) throw new Error("unmocked path " + path)
    return Response.json(value)
  }
  return { seen, responses, posts: () => seen.filter((r) => r.method === "POST" && new URL(r.url).pathname === "/api/tickets") }
}

async function setup({ directory, options = { autoRequestRefill: true }, current = auth, config } = {}) {
  const hooks = await GacCodePlugin({ directory }, options)
  if (config) await hooks.config(config)
  const loaded = await hooks.auth.loader(async () => current)
  return { hooks, send: (url = inferenceUrl, init = { method: "POST", body: "{}" }) => loaded.fetch(url, init) }
}

for (const option of [undefined, false, "true", 1]) {
  test(`autoRequestRefill ${String(option)} is off and makes no side-effect reads`, async () => {
    const fixture = mock()
    const { send, hooks } = await setup({ directory: await temp(), options: { autoRequestRefill: option } })
    expect(await send()).toBe(fixture.responses[0])
    expect(fixture.seen.length).toBe(1)
    expect(usageText(await hooks.auth.usage(async () => auth))).toContain("自动申请：选项关闭")
    expect(fixture.posts()).toHaveLength(0)
  })
}

for (const [label, status, body, contentType] of [
  ["success", 200, errorBody, "application/json"],
  ["rate limit", 429, '{"error":{"type":"rate_limit_error","message":"Too many requests"}}', "application/json"],
  ["generic quota", 429, '{"error":{"type":"insufficient_quota"}}', "application/json"],
  ["429 text without explicit code", 429, '{"error":{"message":"Insufficient credits"}}', "application/json"],
  ["429 generic quota plus credit text", 429, '{"error":{"type":"insufficient_quota","message":"Insufficient credits"}}', "application/json"],
  ["429 type without explicit code", 429, '{"error":{"type":"insufficient_credits"}}', "application/json"],
  ...[400, 401, 403, 404, 408, 500, 502, 503, 504].map((status) => [`excluded HTTP ${status} despite credit code and text`, status, errorBody, "application/json"]),
  ["outage", 503, '{"error":"unavailable"}', "application/json"],
  ["auth", 401, '{"error":"Invalid API key"}', "application/json"],
  ["plain text", 403, "Insufficient credits", "text/plain"],
  ["malformed JSON", 429, "Insufficient credits", "application/json"],
  ["unstructured message", 429, '{"message":"Insufficient credits"}', "application/json"],
  ["oversized JSON", 429, JSON.stringify({ error: "Insufficient credits", padding: "x".repeat(65536) }), "application/json"],
]) {
  test(`${label} does not trigger and preserves the original Response`, async () => {
    const response = new Response(body, { status, headers: { "content-type": contentType } })
    const fixture = mock({}, response)
    const { send } = await setup({ directory: await temp() })
    expect(await send()).toBe(response)
    expect(response.bodyUsed).toBe(false)
    expect(await response.text()).toBe(body)
    expect(fixture.seen).toHaveLength(1)
  })
}

test("quota remains GET-only with auto enabled and exhausted balance", async () => {
  const fixture = mock()
  const directory = await temp()
  const { hooks } = await setup({ directory })
  for (let i = 0; i < 2; i++) expect(usageText(await hooks.auth.usage(async () => auth))).toContain("待触发")
  expect(fixture.seen.every((r) => r.method === "GET")).toBe(true)
  expect(await readdir(directory)).toEqual([])
})

for (const status of [401, 503]) {
  test(`fresh plugin quota with failed /me HTTP ${status} pauses instead of waiting`, async () => {
    const directory = await temp()
    const fixture = mock({ "/api/me": Response.json({}, { status }) })
    await (await setup({ directory })).send()
    const before = fixture.seen.length
    const fresh = await setup({ directory })
    const text = usageText(await fresh.hooks.auth.usage(async () => auth))
    expect(text).toContain("自动申请：网站身份读取失败，暂停申请")
    expect(text).not.toContain("待触发")
    if (status === 401) expect(text).toContain("请更新 JWT")
    else expect(text).not.toContain("请更新 JWT")
    expect(fixture.seen.slice(before).every((r) => r.method === "GET")).toBe(true)
    expect(fixture.posts()).toHaveLength(0)
    expect(await readdir(join(directory, ".gaccode-refill"))).toEqual([])
  })
}

test("a separate quota process shows expired JWT without a credential-account mapping", async () => {
  const directory = await temp()
  const fixture = mock({ "/api/me": Response.json({}, { status: 401 }) })
  await (await setup({ directory })).send()
  expect(fixture.posts()).toHaveLength(0)
  const script = `
    import { GacCodePlugin } from ${JSON.stringify(new URL("./index.mjs", import.meta.url).href)};
    const methods = [];
    globalThis.fetch = async (input, init) => {
      const req = new Request(input, init); methods.push(req.method);
      const path = new URL(req.url).pathname;
      if (path === '/api/me') return Response.json({}, {status:401});
      const values = {
        '/claudecode/v1/cc-status-line': {user:{id:42,email:'fixture@example.invalid'},balance:0,creditCap:100},
        '/api/subscriptions': {subscriptions:[]},
        '/api/usd-account': {account:null},
        '/api/credits/booster-packs': {boosterPacks:[]},
        '/api/tickets': {tickets:[],pagination:{page:1,limit:20,total:0,pages:0}}
      };
      if (!(path in values)) throw new Error('unexpected mocked path');
      return Response.json(values[path]);
    };
    const plugin = await GacCodePlugin({directory:process.argv[1]}, {autoRequestRefill:true});
    const usage = await plugin.auth.usage(async () => (${JSON.stringify(auth)}));
    console.log(JSON.stringify({usage,methods}));
  `
  const child = Bun.spawn([process.execPath, "--eval", script, directory], { env: {}, stdout: "pipe", stderr: "pipe" })
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(code).toBe(0)
  expect(stderr).toBe("")
  const result = JSON.parse(stdout)
  expect(usageText(result.usage)).toContain("自动申请：网站身份读取失败，暂停申请，请更新 JWT")
  expect(usageText(result.usage)).not.toContain("待触发")
  expect(result.methods.every((m) => m === "GET")).toBe(true)
  expect(await readdir(directory)).toEqual([".gaccode-refill"])
  expect(await readdir(join(directory, ".gaccode-refill"))).toEqual([])
})

for (const [field, value] of [
  ...[undefined, null, true, false, "", " ", "0", "-1", "Infinity", {}, [], 1, 0.01].map((v) => ["balance", v]),
  ...[null, true, false, "", "0", "Infinity", {}, [], 1, 0.01].map((v) => ["effectiveBalance", v]),
]) {
  test(`statusline ${field}=${JSON.stringify(value)} blocks POST and preserves the original response`, async () => {
    const status = { email, userId: 42, balance: 0, effectiveBalance: 0, [field]: value }
    const fixture = mock({ [statusPath]: status })
    const directory = await temp()
    const plugin = await setup({ directory })
    const response = await plugin.send()
    expect(response).toBe(fixture.responses[0])
    expect(await response.text()).toBe(errorBody)
    expect(fixture.posts()).toHaveLength(0)
    expect(fixture.seen.some((r) => new URL(r.url).pathname === "/api/tickets/categories")).toBe(false)
    expect(usageText(await plugin.hooks.auth.usage(async () => auth))).toContain("自动申请：失败")
    const reads = fixture.seen.length
    await (await setup({ directory })).send()
    expect(fixture.seen.length).toBe(reads + 2) // Inference + /me, then persistent refusal.
    expect(fixture.posts()).toHaveLength(0)
  })
}

for (const field of ["balance", "effectiveBalance"]) {
  test(`non-finite numeric ${field} from JSON exponent overflow fails closed`, async () => {
    const fixture = mock({ [statusPath]: new Response(`{"email":"${email}","balance":0,"${field}":1e400}`, { headers: { "content-type": "application/json" } }) })
    await (await setup({ directory: await temp() })).send()
    expect(fixture.posts()).toHaveLength(0)
  })
}

for (const status of [{ balance: 0 }, { balance: -1 }, { balance: 0, effectiveBalance: 0 }, { balance: -1, effectiveBalance: -0.5 }]) {
  test(`confirmed exhausted numeric balance permits a request: ${JSON.stringify(status)}`, async () => {
    const fixture = mock({ [statusPath]: { email, userId: 42, ...status } })
    await (await setup({ directory: await temp() })).send()
    expect(fixture.posts()).toHaveLength(1)
  })
}

test("request success uses verified identities, dynamic category, fixed website and synced 0600 attempt", async () => {
  const directory = await temp()
  let durableAttempt
  const fixture = mock({ "/api/tickets": async () => {
    const files = await readdir(join(directory, ".gaccode-refill"))
    const path = join(directory, ".gaccode-refill", files[0])
    durableAttempt = await readFile(path, "utf8")
    expect(durableAttempt.trim().split("\n").map(JSON.parse).at(-1).status).toBe("attempt")
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    return { ticket: { id: 123 } }
  } })
  const { send, hooks } = await setup({ directory })
  const response = await send()
  expect(response).toBe(fixture.responses[0])
  expect(response.status).toBe(429)
  expect(response.statusText).toBe("Fixture exhausted")
  expect(response.headers.get("retry-after")).toBe("17")
  expect(response.bodyUsed).toBe(false)
  expect(await response.text()).toBe(errorBody)
  expect(fixture.responses).toHaveLength(1) // No inference retry.
  expect(fixture.posts()).toHaveLength(1)
  expect(await fixture.posts()[0].json()).toEqual({ categoryId: 9, title: "请求重置积分", description: "托管推理请求返回积分耗尽错误，申请重置积分。此申请不代表积分已到账。", language: "zh" })
  for (const req of fixture.seen.filter((r) => new URL(r.url).pathname.startsWith("/api/"))) {
    expect(new URL(req.url).origin).toBe("https://gaccode.com")
    expect(req.headers.get("authorization")).toBe("Bearer fake-site-jwt")
    expect(req.redirect).toBe("error")
    expect(req.headers.has("x-api-key")).toBe(false)
  }
  expect(durableAttempt).not.toMatch(/fake-key|fake-site-jwt|fixture@example/)
  const display = usageText(await hooks.auth.usage(async () => auth))
  expect(display).toContain("自动申请：已申请")
  expect(display).not.toContain("到账未核验")
  expect(display).not.toContain("已重置")
})

for (const [label, path, value] of [
  ["captcha required", "/api/tickets/recaptcha-required", { requiresRecaptcha: true }],
  ["captcha field missing", "/api/tickets/recaptcha-required", { required: false }],
  ["captcha string", "/api/tickets/recaptcha-required", { requiresRecaptcha: "false" }],
  ["captcha failed", "/api/tickets/recaptcha-required", new Error("fake secret should not persist")],
  ["identity mismatch", statusPath, { email: "different@example.invalid" }],
  ["identity id mismatch", statusPath, { email, userId: 43 }],
  ["conflicting nested email", statusPath, { email, user: { email: "other@example.invalid" } }],
  ["conflicting nested id", statusPath, { email, userId: 42, user: { id: 43 } }],
  ["present but null id", statusPath, { email, userId: null }],
  ["identity missing", statusPath, { balance: 0 }],
  ["identity failed", statusPath, Response.json({}, { status: 500 })],
  ["website identity missing", "/api/me", { user: { id: 42 } }],
  ["account id missing", "/api/me", { user: { email } }],
  ["me failed", "/api/me", Response.json({}, { status: 401 })],
  ["category missing", "/api/tickets/categories", { categories: [] }],
  ["category ambiguous", "/api/tickets/categories", { categories: [{ id: 9, key: "REQUEST_TO_REFILL_CREDIT" }, { id: 10, key: "REQUEST_TO_REFILL_CREDIT" }] }],
  ["category read fails", "/api/tickets/categories", new Error("offline")],
  ["list unknown", "/api/tickets?page=1&limit=20", { tickets: [] }],
  ["pagination unknown", "/api/tickets?page=1&limit=20", { tickets: [], pagination: { total: 0 } }],
  ["pagination incomplete", "/api/tickets?page=1&limit=20", { tickets: [], pagination: { page: 1, limit: 20, total: 21, pages: 2 } }],
  ["list read fails", "/api/tickets?page=1&limit=20", new Error("offline")],
]) {
  test(`${label} fails closed and is not retried that day`, async () => {
    const fixture = mock({ [path]: value })
    const { send, hooks } = await setup({ directory: await temp() })
    const response = await send()
    const count = fixture.seen.length
    expect(await response.text()).toBe(errorBody)
    await send()
    expect(fixture.seen.length).toBe(count + 1)
    expect(fixture.posts()).toHaveLength(0)
    expect(usageText(await hooks.auth.usage(async () => auth))).toContain(label === "me failed" ? "自动申请：网站身份读取失败，暂停申请" : "自动申请：失败")
  })
}

for (const current of [
  { ...auth, metadata: {} },
  { ...auth, metadata: { token: "legacy-token-must-not-authorize" } },
]) {
  test("missing metadata.loginToken cannot submit, even with legacy token alias", async () => {
    const fixture = mock()
    const { send, hooks } = await setup({ directory: await temp(), current })
    await send()
    expect(fixture.seen).toHaveLength(1)
    expect(usageText(await hooks.auth.usage(async () => current))).toContain("自动申请：需网站 JWT")
    expect(fixture.posts()).toHaveLength(0)
  })
}

test("missing or unwritable directory cannot submit and cannot replace original error", async () => {
  const dir = await temp()
  const file = join(dir, "is-a-file")
  await writeFile(file, "fixture")
  for (const directory of [undefined, "relative", join(dir, "missing"), file]) {
    const fixture = mock()
    const { send, hooks } = await setup({ directory })
    expect(await send()).toBe(fixture.responses[0])
    expect(fixture.seen).toHaveLength(1)
    expect(usageText(await hooks.auth.usage(async () => auth))).toContain("自动申请：失败（宿主目录不可用）")
  }
})

test("concurrent plugin instances with different keys/JWTs share a website-account lock", async () => {
  const fixture = mock()
  const directory = await temp()
  const instances = await Promise.all(Array.from({ length: 8 }, (_, i) => setup({ directory, current: { ...auth, key: `fake-key-${i}`, metadata: { ...auth.metadata, loginToken: `fake-jwt-${i}` } } })))
  await Promise.all(instances.map((p) => p.send()))
  expect(fixture.posts()).toHaveLength(1)
  expect(await readdir(join(directory, ".gaccode-refill"))).toHaveLength(1)
})

test("persistent dedup survives a fresh plugin and a new key/JWT for the same account", async () => {
  const fixture = mock()
  const directory = await temp()
  await (await setup({ directory })).send()
  await (await setup({ directory, current: { ...auth, key: "fake-replacement-key", metadata: { ...auth.metadata, loginToken: "fake-new-jwt" } } })).send()
  expect(fixture.posts()).toHaveLength(1)
})

test("a failed preflight remains blocked after restart even when CAPTCHA later becomes false", async () => {
  const directory = await temp()
  const first = mock({ "/api/tickets/recaptcha-required": { requiresRecaptcha: true } })
  await (await setup({ directory })).send()
  expect(first.posts()).toHaveLength(0)
  const second = mock()
  const plugin = await setup({ directory })
  await plugin.send()
  expect(second.posts()).toHaveLength(0)
  expect(second.seen.map((r) => new URL(r.url).pathname)).toEqual(["/codex/v1/responses", "/api/me"])
  expect(usageText(await plugin.hooks.auth.usage(async () => auth))).toContain("需验证码")
})

for (const status of ["checking", "attempt"]) {
  test(`an interrupted ${status} ledger is never reclaimed`, async () => {
    const directory = await temp()
    const fixture = mock()
    await (await setup({ directory })).send()
    const root = join(directory, ".gaccode-refill")
    const [file] = await readdir(root)
    await writeFile(join(root, file), JSON.stringify({ day: beijingDay(), status }) + "\n")
    const second = await setup({ directory })
    await second.send()
    expect(fixture.posts()).toHaveLength(1)
    expect(usageText(await second.hooks.auth.usage(async () => auth))).toContain("今日不重试")
  })
}

test("upstream errors cannot leak arbitrary exception text into the ledger", async () => {
  const directory = await temp()
  mock({ "/api/tickets/categories": new Error("工单 failure fake-secret-do-not-persist") })
  await (await setup({ directory })).send()
  const root = join(directory, ".gaccode-refill")
  const [file] = await readdir(root)
  expect(await readFile(join(root, file), "utf8")).not.toContain("fake-secret-do-not-persist")
})

for (const outcome of [new Error("Timeout: result unknown"), Response.json({}, { status: 503 }), { ok: true }]) {
  test(`failed/unknown POST ${String(outcome)} is permanently deduplicated for the day`, async () => {
    const fixture = mock({ "/api/tickets": outcome })
    const directory = await temp()
    await (await setup({ directory })).send()
    const second = await setup({ directory })
    await second.send()
    expect(fixture.posts()).toHaveLength(1)
    expect(usageText(await second.hooks.auth.usage(async () => auth))).toContain("申请结果未知，今日不重试")
  })
}

const closedTicket = (id, createdAt = "2020-01-01T00:00:00Z") => ({ id, category: { key: "REQUEST_TO_REFILL_CREDIT" }, title: "fixture", createdAt, status: "CLOSED" })
function page(tickets, page = 1, total = tickets.length) {
  return { tickets, pagination: { page, limit: 20, total, pages: Math.ceil(total / 20) } }
}

for (const ticket of [closedTicket(1, new Date().toISOString()), { ...closedTicket(2), status: "WAITING_FOR_SUPPORT" }, { ...closedTicket(3), status: "WAITING_FOR_USER" }]) {
  test(`existing ${ticket.status}/${ticket.createdAt} refill blocks a duplicate`, async () => {
    const fixture = mock({ "/api/tickets?page=1&limit=20": page([ticket]) })
    const { send, hooks } = await setup({ directory: await temp() })
    await send()
    expect(fixture.posts()).toHaveLength(0)
    expect(usageText(await hooks.auth.usage(async () => auth))).toContain("已有同日申请或待处理工单")
  })
}

test("all pages must be read; a pending ticket on page two blocks POST", async () => {
  const fixture = mock({
    "/api/tickets?page=1&limit=20": page(Array.from({ length: 20 }, (_, i) => closedTicket(i + 1)), 1, 21),
    "/api/tickets?page=2&limit=20": page([{ ...closedTicket(21), status: "WAITING_FOR_SUPPORT" }], 2, 21),
  })
  await (await setup({ directory: await temp() })).send()
  expect(fixture.seen.some((r) => r.url.endsWith("page=2&limit=20"))).toBe(true)
  expect(fixture.posts()).toHaveLength(0)
})

test("complete multiple pages with only old closed refill tickets permit one POST", async () => {
  const fixture = mock({
    "/api/tickets?page=1&limit=20": page(Array.from({ length: 20 }, (_, i) => closedTicket(i + 1)), 1, 21),
    "/api/tickets?page=2&limit=20": page([closedTicket(21)], 2, 21),
  })
  await (await setup({ directory: await temp() })).send()
  expect(fixture.posts()).toHaveLength(1)
})

for (const secondPage of [new Error("offline"), page([closedTicket(1)], 2, 21), page([closedTicket(21)], 2, 22)]) {
  test("unreadable, duplicate or changing pagination cannot authorize POST", async () => {
    const fixture = mock({
      "/api/tickets?page=1&limit=20": page(Array.from({ length: 20 }, (_, i) => closedTicket(i + 1)), 1, 21),
      "/api/tickets?page=2&limit=20": secondPage,
    })
    await (await setup({ directory: await temp() })).send()
    expect(fixture.posts()).toHaveLength(0)
  })
}

test("GMT+8 midnight creates the next daily lock, independent of local timezone", async () => {
  let clock = Date.parse("2026-10-07T15:59:59.999Z")
  expect(beijingDay(clock)).toBe("2026-10-07")
  expect(beijingDay(clock + 1)).toBe("2026-10-08")
  const directory = await temp()
  const fixture = mock()
  const refill = createAutoRefill({ enabled: true, directory, now: () => clock })
  await refill.observe(auth, refused(), statusUrl)
  await refill.observe(auth, refused(), statusUrl)
  expect(fixture.posts()).toHaveLength(1)
  clock++
  await refill.observe(auth, refused(), statusUrl)
  expect(fixture.posts()).toHaveLength(2)
})

test("crossing GMT+8 midnight during preflight stops before POST", async () => {
  let clock = Date.parse("2026-10-07T15:59:59.999Z")
  const fixture = mock({ "/api/tickets?page=1&limit=20": () => { clock++; return emptyTickets } })
  const refill = createAutoRefill({ enabled: true, directory: await temp(), now: () => clock })
  await refill.observe(auth, refused(), statusUrl)
  expect(fixture.posts()).toHaveLength(0)
})

for (const [path, body] of [
  ["/claudecode/v1/messages", { error: { message: "积分已耗尽" } }],
  ["/codex/v1/responses", { error: { code: "insufficient_credits" } }],
  ["/gemini/v1beta/models/gemini-fixture:generateContent", { error: { message: "Credit balance is depleted" } }],
]) {
  test(`explicit exhaustion on managed inference Request ${path} triggers once`, async () => {
    const fixture = mock({}, () => Response.json(body, { status: 402 }))
    const { send } = await setup({ directory: await temp(), options: { autoRequestRefill: true, experimentalGemini: true } })
    await send(new Request("https://gaccode.com" + path, { method: "POST", body: "{}" }), {})
    expect(fixture.posts()).toHaveLength(1)
  })
}

test("a redirected error response cannot trigger an application", async () => {
  const response = refused()
  Object.defineProperty(response, "redirected", { value: true })
  const fixture = mock({}, response)
  expect(await (await setup({ directory: await temp() })).send()).toBe(response)
  expect(fixture.seen).toHaveLength(1)
})

test("an unfinished error body times out without consuming or replacing the original", async () => {
  let controller
  const response = new Response(new ReadableStream({ start(c) { controller = c; c.enqueue(new TextEncoder().encode(errorBody)) } }), { status: 429, headers: { "content-type": "application/json" } })
  const fixture = mock({}, response)
  expect(await (await setup({ directory: await temp() })).send()).toBe(response)
  expect(response.bodyUsed).toBe(false)
  expect(fixture.seen).toHaveLength(1)
  controller.close()
  expect(await response.text()).toBe(errorBody)
})

for (const [url, config, current, method] of [
  ["https://custom.example.invalid/codex/v1/responses"],
  ["http://gaccode.com/codex/v1/responses"],
  ["https://gaccode.com:8443/codex/v1/responses"],
  ["https://gaccode.com/codex/v1/models", undefined, undefined, "GET"],
  [inferenceUrl, undefined, undefined, "GET"],
  [inferenceUrl, { provider: { gaccode: { models: { custom: { provider: { api: "https://gaccode.com/codex/v1" } } } } } }],
  [inferenceUrl, { provider: { gaccode: { api: "https://gaccode.com/codex/v1" } } }],
  [inferenceUrl, undefined, { ...auth, metadata: { ...auth.metadata, host: "https://custom.example.invalid" } }],
]) {
  test(`nonmanaged or explicitly custom endpoint cannot trigger: ${url} ${JSON.stringify(config)}`, async () => {
    const fixture = mock()
    const { send } = await setup({ directory: await temp(), config, current: current ?? auth })
    await send(url, method === "GET" ? { method } : { method: "POST", body: "{}" })
    expect(fixture.seen).toHaveLength(1)
  })
}

test("corrupted persistent record and insecure state directory fail closed", async () => {
  const directory = await temp()
  const fixture = mock()
  await (await setup({ directory })).send()
  const root = join(directory, ".gaccode-refill")
  const [file] = await readdir(root)
  await writeFile(join(root, file), "partial state")
  await (await setup({ directory })).send()
  expect(fixture.posts()).toHaveLength(1)
  const insecure = await temp()
  await mkdir(join(insecure, ".gaccode-refill"), { mode: 0o755 })
  await (await setup({ directory: insecure })).send()
  expect(fixture.posts()).toHaveLength(1)
})

test("cross-process account lock allows at most one POST with independent keys and JWTs", async () => {
  const directory = await temp()
  const moduleUrl = new URL("./index.mjs", import.meta.url).href
  const script = `
    import { GacCodePlugin } from ${JSON.stringify(moduleUrl)};
    import { writeFile, readdir, appendFile } from 'node:fs/promises';
    const dir = process.argv[1], id = process.argv[2];
    globalThis.fetch = async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : input).pathname;
      let data;
      if (path === '/codex/v1/responses') return Response.json({error:{code:'insufficient_credits',message:'Insufficient credits'}},{status:429});
      if (path === '/api/me') {
        await writeFile(dir + '/ready-' + id, 'ready');
        const deadline = Date.now() + 5000;
        while ((await readdir(dir)).filter(n => n.startsWith('ready-')).length < 4) {
          if (Date.now() > deadline) throw new Error('barrier timeout');
          await new Promise(r => setTimeout(r, 5));
        }
        data = {user:{id:42,email:'fixture@example.invalid'}};
      } else if (path.endsWith('/cc-status-line')) data = {email:'fixture@example.invalid',balance:0,effectiveBalance:0};
      else if (path === '/api/tickets/categories') data = {categories:[{id:9,key:'REQUEST_TO_REFILL_CREDIT'}]};
      else if (path === '/api/tickets/recaptcha-required') data = {requiresRecaptcha:false};
      else if (path === '/api/tickets' && init.method === 'GET') data = ${JSON.stringify(emptyTickets)};
      else if (path === '/api/tickets' && init.method === 'POST') {
        await appendFile(dir + '/posts', id + '\\n'); data = {ticket:{id:123}};
      } else throw new Error('unexpected mock request');
      return Response.json(data);
    };
    const hooks = await GacCodePlugin({directory:dir},{autoRequestRefill:true});
    const loaded = await hooks.auth.loader(async () => ({type:'api',key:'fake-'+id,metadata:{loginToken:'fake-jwt-'+id}}));
    const r = await loaded.fetch(${JSON.stringify(inferenceUrl)},{method:'POST',body:'{}'});
    if (r.status !== 429) process.exit(2);
  `
  const children = Array.from({ length: 4 }, (_, i) => Bun.spawn([process.execPath, "--eval", script, directory, String(i)], { env: {}, stdout: "pipe", stderr: "pipe" }))
  const results = await Promise.all(children.map(async (child) => ({ code: await child.exited, error: await new Response(child.stderr).text() })))
  expect(results).toEqual(Array.from({ length: 4 }, () => ({ code: 0, error: "" })))
  expect((await readFile(join(directory, "posts"), "utf8")).trim().split("\n")).toHaveLength(1)
}, 10000)
