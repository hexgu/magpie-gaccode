import { afterEach, beforeEach, expect, test } from "bun:test"
import { GacCodePlugin } from "./index.mjs"

// 使用 bun --no-env-file test ./routing.test.mjs；凭证和响应均为合成数据。
const originalFetch = globalThis.fetch
const mainSite = "https://gaccode.com"
const relay = "https://relay05.gaccode.com"
const statusPath = "/claudecode/v1/cc-status-line"
const creditPath = "/api/credits/balance"
const sitePaths = [creditPath, "/api/subscriptions", "/api/me", "/api/usd-account",
  "/api/credits/booster-packs", "/api/tickets?page=1&limit=20"]
const email = "routing@example.invalid"
const otherEmail = "other-routing@example.invalid"
const apiAuth = { type: "api", key: "synthetic-api-key", metadata: { host: relay } }
const jwtAuth = { ...apiAuth, metadata: { ...apiAuth.metadata, loginToken: "synthetic-site-jwt" } }
let seen
let unexpected

beforeEach(() => {
  seen = []
  unexpected = []
  globalThis.fetch = async () => {
    unexpected.push("未配置合成响应")
    throw new Error("禁止真实网络请求")
  }
})

afterEach(() => {
  globalThis.fetch = originalFetch
  // 产品代码捕获的越界请求也必须使测试失败。
  expect(unexpected).toEqual([])
})

function fixture(overrides = {}) {
  const replies = {
    [statusPath]: { balance: 20, creditCap: 100, refillRate: 5, user: { email } },
    [creditPath]: { balance: 22000, creditCap: 12000, creditsPerHour: 300 },
    "/api/me": { user: { email } },
    "/api/subscriptions": { subscriptions: [] },
    "/api/usd-account": { account: null },
    "/api/credits/booster-packs": { boosterPacks: [] },
    "/api/tickets?page=1&limit=20": { tickets: [] },
    ...overrides,
  }
  globalThis.fetch = async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    const path = url.pathname + url.search
    seen.push(request)
    if (request.method !== "GET" || !Object.hasOwn(replies, path) ||
        (path === statusPath ? ![mainSite, relay].includes(url.origin) : url.origin !== mainSite)) {
      unexpected.push(`${request.method} ${request.url}`)
      throw new Error("请求超出只读合成响应边界")
    }
    const reply = typeof replies[path] === "function" ? await replies[path](request) : replies[path]
    return reply instanceof Response ? reply.clone() : Response.json(reply)
  }
}

async function usage(auth = apiAuth) {
  return (await GacCodePlugin({}, { autoRequestRefill: false })).auth.usage(async () => auth)
}

function checkBalance(result, amount, refillPerHour, annotated = false) {
  expect(result.error).toBeUndefined()
  if (annotated) expect(result.balance.startsWith(`${amount} 积分`)).toBe(true)
  else expect(result.balance).toBe(`${amount} 积分`)
  expect(result.balanceTelemetry).toEqual({ amount, unit: "积分", kind: "replenishing",
    ...(refillPerHour === undefined ? {} : { refillPerHour }) })
  expect(result.signIn).toBe("kept")
  // 预计用完时间由宿主基于余额走势拟合，不能用补充基准伪造周期重置。
  for (const item of [result, result.balanceTelemetry, ...result.windows]) {
    for (const field of ["span", "resetsAt", "resetSecs"]) expect(item[field]).toBeUndefined()
  }
}

function checkWindow(window, name, balance, cap, used, aside) {
  expect(window).toMatchObject({ name, aside })
  expect(window.used).toBeCloseTo(used, 10)
  expect(Number.isFinite(window.used)).toBe(true)
  expect(window.used).toBeGreaterThanOrEqual(0)
  expect(window.used).toBeLessThanOrEqual(100)
  expect(window.display.startsWith(`${balance} 积分（补充基准 ${cap} 积分）`)).toBe(true)
  expect(window.display).not.toContain(" · ")
  // 补充基准不是消费上限，不能用计数字段覆盖原生余额说明。
  for (const field of ["amount", "limit", "unit"]) expect(window[field]).toBeUndefined()
}

const routeOf = (result) => result.windows.filter((window) => !window.aside)
const textOf = (result) => [result.balance, result.error, ...result.windows.map((window) => window.display)]
  .filter(Boolean).join("\n")
const invalidCaps = [undefined, null, 0, -1, false, true, "", " ", "未知", "Infinity", {}, []]
const invalidBalances = [undefined, null, false, true, "", " ", "未知", "Infinity", {}, []]

test("无 JWT 的零余额、透支和赠送积分保留真实数值，路由比例截到零至百分之百", async () => {
  for (const [balance, cap, used] of [[-25, 100, 100], [0, 100, 100], [20, 100, 80],
    [100, 100, 0], [150, 100, 0], [22000, 12000, 0]]) {
    fixture({ [statusPath]: { balance, creditCap: cap, refillRate: 300 } })
    const result = await usage()
    checkBalance(result, balance, 300)
    expect(result.windows).toHaveLength(1)
    checkWindow(result.windows[0], "积分余量", balance, cap, used, false)
    expect(result.windows[0].display).toContain("300/时")
    expect(result.plan).toBe("GACCode")
  }
})

test("JWT 邮箱匹配时主余额取网站，唯一路由窗口始终使用 key 数字", async () => {
  for (const [websiteBalance, keyBalance, used] of [[22000, 0, 100], [0, 100, 0], [-25, 20, 80]]) {
    fixture({ [creditPath]: { balance: websiteBalance, creditCap: 12000, creditsPerHour: 300 },
      [statusPath]: { balance: keyBalance, creditCap: 100, refillRate: 7, user: { email } },
      "/api/me": { user: { email: ` ${email.toUpperCase()} ` } } })
    const result = await usage(jwtAuth)
    checkBalance(result, websiteBalance, 300)
    expect(result.windows).toHaveLength(1)
    checkWindow(result.windows[0], "积分余量", keyBalance, 100, used, false)
  }
})

test("不同账户两个方向都隔离网站余额和 key 路由，网站展示窗口固定在前", async () => {
  for (const [websiteBalance, keyBalance, websiteUsed, keyUsed] of [[22000, 0, 0, 100], [0, 100, 100, 0]]) {
    fixture({ [creditPath]: { balance: websiteBalance, creditCap: 12000, creditsPerHour: 300 },
      [statusPath]: { balance: keyBalance, creditCap: 100, user: { email: otherEmail } } })
    const result = await usage(jwtAuth)
    checkBalance(result, websiteBalance, 300)
    expect(result.windows).toHaveLength(2)
    checkWindow(result.windows[0], "网站积分", websiteBalance, 12000, websiteUsed, true)
    checkWindow(result.windows[1], "积分余量", keyBalance, 100, keyUsed, false)
    expect(routeOf(result)).toHaveLength(1)
  }
})

test("邮箱未知或身份接口拒绝访问时 key 独立路由，JWT 标签不能证明账户匹配", async () => {
  const token = `synthetic.${Buffer.from(JSON.stringify({ email })).toString("base64url")}.unsigned`
  for (const [me, owner] of [[{}, { email }], [{ email }, {}], [{}, {}],
    [Response.json({}, { status: 401 }), { email }]]) {
    fixture({ "/api/me": me, [statusPath]: { balance: 20, creditCap: 100, user: owner } })
    const result = await usage({ ...jwtAuth, accountId: email,
      metadata: { ...jwtAuth.metadata, loginToken: token, email } })
    checkBalance(result, 22000, 300)
    expect(result.windows).toHaveLength(2)
    checkWindow(result.windows[0], "网站积分", 22000, 12000, 0, true)
    checkWindow(result.windows[1], "积分余量", 20, 100, 80, false)
  }
})

test("无 JWT 的无效上限不生成零用量路由窗口，余额和独立遥测仍真实", async () => {
  for (const creditCap of invalidCaps) {
    fixture({ [statusPath]: { balance: 20, creditCap, refillRate: 300 } })
    const result = await usage()
    checkBalance(result, 20, 300, true)
    expect(result.windows).toEqual([])
    expect(result.balance).toContain("路由用量未知")
  }
})

test("网站上限无效时不创建网站或账户信息窗口，有效 key 窗口承载说明", async () => {
  for (const creditCap of invalidCaps) {
    fixture({ [creditPath]: { balance: 22000, creditCap, creditsPerHour: 300 },
      [statusPath]: { balance: 20, creditCap: 100, user: { email: otherEmail } },
      "/api/usd-account": { account: { balanceUsd: 12.34 } } })
    const result = await usage(jwtAuth)
    checkBalance(result, 22000, 300)
    expect(result.windows).toHaveLength(1)
    checkWindow(result.windows[0], "积分余量", 20, 100, 80, false)
    expect(result.windows[0].display).toContain("300/时")
    expect(result.windows[0].display).toContain("USD $12.34")
  }
})

test("key 上限或余额无效时网站不能替代路由，同账户也不能回退到网站数字", async () => {
  const statuses = [...invalidCaps.map((creditCap) => ({ balance: 20, creditCap })),
    ...invalidBalances.map((balance) => ({ balance, creditCap: 100 })),
    Response.json({}, { status: 401 }), new Response('{"balance":1e309,"creditCap":100}')]
  for (const status of statuses) {
    for (const matched of [false, true]) {
      fixture({ [statusPath]: status instanceof Response ? status : { ...status, user: { email } },
        "/api/me": { email: matched ? email : otherEmail } })
      const result = await usage(jwtAuth)
      checkBalance(result, 22000, 300, result.windows.length === 0)
      expect(routeOf(result)).toEqual([])
      const canMatch = matched && !(status instanceof Response)
      expect(result.windows).toHaveLength(canMatch ? 0 : 1)
      if (!canMatch) checkWindow(result.windows[0], "网站积分", 22000, 12000, 0, true)
      expect(textOf(result)).toContain("路由用量未知")
    }
  }
})

test("无效主余额或主接口错误返回错误和空窗口，key 与 USD 不能掩盖错误", async () => {
  for (const auth of [apiAuth, jwtAuth]) {
    for (const body of [...invalidBalances.map((balance) => ({ balance, creditCap: 100 })),
      Response.json({}, { status: 401 }), new Response('{"balance":1e309,"creditCap":100}')]) {
      fixture({ [auth === jwtAuth ? creditPath : statusPath]: body,
        "/api/usd-account": { account: { balanceUsd: 1234 } } })
      const result = await usage(auth)
      expect(result.error).toMatch(/有效余额|读取失败/)
      expect(result.windows).toEqual([])
      expect(result.balance).toBeUndefined()
      expect(result.balanceTelemetry).toBeUndefined()
      expect(result.signIn).toBe("kept")
    }
  }
})

test("数值字符串兼容积分、补充基准和速率，不解析余额展示文字生成遥测", async () => {
  fixture({ [statusPath]: { balance: " 20 ", creditCap: "100", refillRate: "300" } })
  const keyOnly = await usage()
  checkBalance(keyOnly, 20, 300)
  checkWindow(keyOnly.windows[0], "积分余量", 20, 100, 80, false)
  fixture({ [creditPath]: { balance: "22000", creditCap: "12000", creditsPerHour: "300" },
    [statusPath]: { balance: "-25", creditCap: "100", user: { email } } })
  const website = await usage(jwtAuth)
  checkBalance(website, 22000, 300)
  expect(website.windows).toHaveLength(1)
  checkWindow(website.windows[0], "积分余量", -25, 100, 100, false)
})

test("补充速率只接受有限非负值，兼容别名和真实零值，不推断缺失速率", async () => {
  for (const [fields, rate] of [[{ refillRate: 0, creditsPerHour: 300 }, 0],
    [{ refillRate: "300", creditsPerHour: 7 }, 300], [{ creditsPerHour: "300" }, 300],
    [{ refillRate: null, creditsPerHour: 300 }, 300], [{}, undefined],
    ...[-1, false, true, "", " ", "未知", "Infinity", {}, []].map((refillRate) => [{ refillRate }, undefined])]) {
    fixture({ [statusPath]: { balance: 20, creditCap: 100, ...fields } })
    const result = await usage()
    checkBalance(result, 20, rate)
    expect(result.windows).toHaveLength(1)
  }
})

test("USD、自定义套餐和工单只作说明，不替代积分余额、遥测或 key 数字", async () => {
  for (const matched of [true, false]) {
    fixture({ "/api/me": { email: matched ? email : otherEmail },
      "/api/subscriptions": { subscriptions: [{ planName: "合成自定义套餐" }] },
      "/api/usd-account": { account: { balanceUsd: 12.34 } },
      "/api/tickets?page=1&limit=20": { tickets: [{ title: "请求重置积分",
        createdAt: new Date().toISOString(), status: "CLOSED" }] } })
    const result = await usage(jwtAuth)
    checkBalance(result, 22000, 300)
    expect(result.plan).toBe("合成自定义套餐")
    expect(result.windows[0].display).toContain("USD $12.34")
    expect(result.windows[0].display).toContain("今日已申请")
    expect(result.windows[0].display).toContain("300/时")
    expect(routeOf(result)).toHaveLength(1)
    checkWindow(routeOf(result)[0], "积分余量", 20, 100, 80, false)
  }
})

test("没有有效窗口时积分余额保留附注，遥测仍是独立数值", async () => {
  fixture({ [creditPath]: { balance: 22000, creditsPerHour: 300 },
    [statusPath]: Response.json({}, { status: 401 }),
    "/api/usd-account": { account: { balanceUsd: 12.34 } } })
  const result = await usage(jwtAuth)
  checkBalance(result, 22000, 300, true)
  expect(result.windows).toEqual([])
  expect(result.balance).toContain("路由用量未知")
  expect(result.balance).toContain("USD $12.34")
})

test("最大有限补充基准与零余额仍有有限比例，非有限上限仅保留余额", async () => {
  fixture({ [statusPath]: { balance: 0, creditCap: Number.MAX_VALUE } })
  const result = await usage()
  checkBalance(result, 0)
  expect(result.windows).toHaveLength(1)
  checkWindow(result.windows[0], "积分余量", 0, Number.MAX_VALUE, 100, false)
  fixture({ [statusPath]: new Response('{"balance":20,"creditCap":1e309}') })
  const unknown = await usage()
  checkBalance(unknown, 20, undefined, true)
  expect(unknown.windows).toEqual([])
  expect(unknown.balance).toContain("路由用量未知")
})

test("先检查未截断比例是否有限，正负溢出都不能伪造成路由窗口", async () => {
  for (const [balance, creditCap] of [[-Number.MAX_VALUE, Number.MIN_VALUE],
    [Number.MAX_VALUE, Number.MIN_VALUE], [-Number.MAX_VALUE, 1]]) {
    fixture({ [statusPath]: { balance, creditCap } })
    const result = await usage()
    checkBalance(result, balance, undefined, true)
    expect(result.windows).toEqual([])
    expect(result.balance).toContain("路由用量未知")
    fixture({ [statusPath]: { balance, creditCap, user: { email: otherEmail } } })
    const website = await usage(jwtAuth)
    checkBalance(website, 22000, 300)
    expect(website.windows).toHaveLength(1)
    checkWindow(website.windows[0], "网站积分", 22000, 12000, 0, true)
    expect(textOf(website)).toContain("路由用量未知")
  }
})

test("网站比例溢出时省略展示窗口，真实主余额与有效 key 路由保持独立", async () => {
  fixture({ [creditPath]: { balance: Number.MAX_VALUE, creditCap: Number.MIN_VALUE, creditsPerHour: 300 },
    "/api/me": { email: otherEmail } })
  const result = await usage(jwtAuth)
  checkBalance(result, Number.MAX_VALUE, 300)
  expect(result.windows).toHaveLength(1)
  checkWindow(result.windows[0], "积分余量", 20, 100, 80, false)
})

test("同一 key 的身份读取变化和余额恢复不改变路由窗口名称", async () => {
  let owner = { email }
  let balance = 0
  fixture({ "/api/me": () => owner,
    [statusPath]: () => ({ balance, creditCap: 100, user: { email } }) })
  const hooks = await GacCodePlugin({}, { autoRequestRefill: false })
  for (const [me, keyBalance, count, used] of [[{ email }, 0, 1, 100], [{}, 20, 2, 80],
    [{ email: otherEmail }, -25, 2, 100], [{ email }, 150, 1, 0]]) {
    owner = me
    balance = keyBalance
    const result = await hooks.auth.usage(async () => jwtAuth)
    checkBalance(result, 22000, 300)
    expect(result.windows).toHaveLength(count)
    expect(routeOf(result)).toHaveLength(1)
    checkWindow(routeOf(result)[0], "积分余量", keyBalance, 100, used, false)
  }
})

test("赠送积分和补充过程的原始遥测连续保留，供宿主拟合预计用完时间", async () => {
  let balance = 22000
  fixture({ [statusPath]: () => ({ balance, creditCap: 12000, refillRate: 300 }) })
  const hooks = await GacCodePlugin({}, { autoRequestRefill: false })
  const readings = []
  for (const amount of [22000, 21000, 20000, 20300, 19000]) {
    balance = amount
    const result = await hooks.auth.usage(async () => apiAuth)
    checkBalance(result, amount, 300)
    checkWindow(result.windows[0], "积分余量", amount, 12000, 0, false)
    readings.push(result.balanceTelemetry)
  }
  expect(readings.map((reading) => reading.amount)).toEqual([22000, 21000, 20000, 20300, 19000])
})

test("同一插件切换 key、主机与 JWT 后重新读取对应来源，不复用旧账户遥测", async () => {
  const authB = { type: "api", key: "synthetic-api-key-b",
    metadata: { host: mainSite, loginToken: "synthetic-site-jwt-b" } }
  fixture({ [statusPath]: (request) => ({ balance: request.headers.get("x-api-key") === apiAuth.key ? 0 : 100,
    creditCap: 100, refillRate: 5, user: { email } }),
  [creditPath]: (request) => ({ balance: request.headers.get("authorization") === "Bearer synthetic-site-jwt-b" ? 3000 : 22000,
    creditCap: 12000, creditsPerHour: 300 }) })
  const hooks = await GacCodePlugin({}, { autoRequestRefill: false })
  let current
  for (const [auth, amount, rate, keyBalance, used] of [[jwtAuth, 22000, 300, 0, 100],
    [authB, 3000, 300, 100, 0], [apiAuth, 0, 5, 0, 100], [jwtAuth, 22000, 300, 0, 100]]) {
    current = auth
    const result = await hooks.auth.usage(async () => current)
    checkBalance(result, amount, rate)
    expect(result.windows).toHaveLength(1)
    checkWindow(result.windows[0], "积分余量", keyBalance, 100, used, false)
  }
  expect(seen.filter((request) => new URL(request.url).pathname === statusPath).map((request) =>
    [new URL(request.url).origin, request.headers.get("x-api-key")])).toEqual([
    [relay, apiAuth.key], [mainSite, authB.key], [relay, apiAuth.key], [relay, apiAuth.key],
  ])
})

test("无 JWT 只读取所选主机的 key 状态，不访问网站账户接口", async () => {
  for (const host of [mainSite, relay]) {
    const before = seen.length
    fixture()
    await usage({ ...apiAuth, metadata: { host } })
    const requests = seen.slice(before)
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe(`${host}${statusPath}`)
    expect(requests[0].headers.get("x-api-key")).toBe(apiAuth.key)
    expect(requests[0].headers.has("authorization")).toBe(false)
  }
})

test("连续低余额查询只用 GET，JWT 留在主站，key 留在状态接口且不写补充工单", async () => {
  fixture({ [creditPath]: { balance: -25, creditCap: 12000, creditsPerHour: 300 },
    [statusPath]: { balance: 0, creditCap: 100, user: { email: otherEmail } },
    "/api/tickets?page=1&limit=20": Response.json({}, { status: 503 }) })
  const hooks = await GacCodePlugin({}, { autoRequestRefill: true })
  await hooks.auth.usage(async () => jwtAuth)
  await hooks.auth.usage(async () => jwtAuth)
  expect(seen).toHaveLength(2 * (sitePaths.length + 1))
  expect(seen.filter((request) => new URL(request.url).pathname.startsWith("/api/")).map((request) => {
    const url = new URL(request.url)
    return url.pathname + url.search
  }).sort()).toEqual([...sitePaths, ...sitePaths].sort())
  for (const request of seen) {
    const url = new URL(request.url)
    expect(request.method).toBe("GET")
    expect(request.body).toBeNull()
    expect(request.headers.has("cookie")).toBe(false)
    if (url.pathname === statusPath) {
      expect(url.origin).toBe(relay)
      expect(request.headers.get("x-api-key")).toBe(apiAuth.key)
      expect(request.headers.has("authorization")).toBe(false)
    } else {
      expect(url.origin).toBe(mainSite)
      expect(request.headers.get("authorization")).toBe("Bearer synthetic-site-jwt")
      expect(request.headers.has("x-api-key")).toBe(false)
    }
  }
})
