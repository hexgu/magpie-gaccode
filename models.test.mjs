import { afterEach, beforeEach, expect, test } from "bun:test"
import { GacCodePlugin, _internal } from "./index.mjs"

const originalFetch = globalThis.fetch
const FELL_BACK = Symbol.for("magpie.fellBack")
const auth = { type: "api", key: "fake-api-key", metadata: { host: "https://relay05.gaccode.com" } }
beforeEach(() => { globalThis.fetch = async () => { throw new Error("offline fixture") } })
afterEach(() => { globalThis.fetch = originalFetch })

async function given(options = { experimentalGemini: false }, models = {}) {
  const hooks = await GacCodePlugin({}, options)
  const cfg = { provider: { gaccode: { models } } }
  await hooks.config(cfg)
  return { hooks, provider: { id: "gaccode", models: cfg.provider.gaccode.models } }
}

function catalog(replies = {}) {
  const seen = []
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init)
    const path = new URL(req.url).pathname
    seen.push(req)
    const defaults = {
      "/claudecode/v1/models": { data: [{ id: "claude-sonnet-5-5" }] },
      "/codex/v1/models": { data: [{ id: "gpt-5.5" }] },
      "/gemini/v1beta/models": { models: [{ name: "models/gemini-3-flash" }] },
    }
    const reply = Object.hasOwn(replies, path) ? replies[path] : defaults[path]
    if (reply instanceof Error) throw reply
    if (reply instanceof Response) return reply.clone()
    return Response.json(reply ?? {})
  }
  return seen
}

test("default config preserves the original Gemini entries and known-model declarations", async () => {
  const { provider } = await given({})
  expect(provider.models["gemini-2.5-flash"]).toBeDefined()
  expect(provider.models["gpt-5.5"]).toMatchObject({
    tool_call: true, reasoning: true, attachment: true,
    limit: { context: 400000, output: 128000 },
  })
  expect(provider.models["claude-sonnet-5-5"].variants.high).toEqual({})
})

test("an explicit Gemini opt-out remains respected", async () => {
  const { provider } = await given({ experimentalGemini: false })
  expect(Object.keys(provider.models).some((id) => id.startsWith("gemini-"))).toBe(false)
})

test("config never writes inferred model pricing multipliers", async () => {
  const { provider } = await given()
  for (const m of Object.values(provider.models)) {
    expect(m.rate).toBeUndefined()
    expect(m.rateWas).toBeUndefined()
  }
})

for (const account of [undefined, { type: "api", metadata: {} }, auth]) {
  test(`public Claude/Codex catalogs work with ${account?.key ? "API key" : account ? "keyless auth" : "no auth"}`, async () => {
    const { hooks, provider } = await given()
    const seen = catalog()
    const models = await hooks.provider.models(provider, { auth: account })
    expect(Object.keys(models).sort()).toEqual(["claude-sonnet-5-5", "gpt-5.5"])
    expect(models[FELL_BACK]).toBeUndefined()
    expect(seen.map((r) => new URL(r.url).pathname).sort())
      .toEqual(["/claudecode/v1/models", "/codex/v1/models"])
    for (const req of seen) expect(new URL(req.url).hostname).toBe(account?.metadata?.host ? "relay05.gaccode.com" : "gaccode.com")
    for (const m of Object.values(models)) {
      expect(m.rate).toBeUndefined()
      expect(m.rateWas).toBeUndefined()
    }
  })
}

test("enabled Gemini GenAI catalog uses its protocol and fake key", async () => {
  const { hooks, provider } = await given({ experimentalGemini: true })
  const seen = catalog()
  const models = await hooks.provider.models(provider, { auth })
  expect(models["gemini-3-flash"].api).toMatchObject({ npm: "@ai-sdk/google", url: "https://relay05.gaccode.com/gemini/v1beta" })
  const request = seen.find((r) => new URL(r.url).pathname === "/gemini/v1beta/models")
  expect(request).toBeDefined()
  expect(request.headers.get("x-goog-api-key")).toBe("fake-api-key")
})

test("experimental Gemini is not probed without a key", async () => {
  const { hooks, provider } = await given({ experimentalGemini: true })
  const seen = catalog()
  const models = await hooks.provider.models(provider, { auth: undefined })
  expect(seen.some((r) => new URL(r.url).pathname.startsWith("/gemini/"))).toBe(false)
  expect(models[FELL_BACK]).toBeUndefined()
  expect(models["gpt-5.5"]).toBeDefined()
  expect(_internal.modelEvidence(models["gemini-3-flash"]).source).toBe("bundled-catalog")
})

for (const path of ["/claudecode/v1/models", "/codex/v1/models"]) {
  test(`failure of enabled family ${path} falls back as a whole, without partial live rows`, async () => {
    const { hooks, provider } = await given({ experimentalGemini: true })
    catalog({
      "/claudecode/v1/models": { data: [{ id: "claude-new-live-fixture" }] },
      "/codex/v1/models": { data: [{ id: "gpt-new-live-fixture" }] },
      "/gemini/v1beta/models": { models: [{ name: "models/gemini-new-live-fixture" }] },
      [path]: Response.json({ error: "fixture outage" }, { status: 503 }),
    })
    const models = await hooks.provider.models(provider, { auth })
    expect(models[FELL_BACK]).toBe(true)
    // Either the supplied snapshot or a regenerated whole static snapshot is valid.
    // Account URLs may be repaired, but fresh partial rows must never leak through.
    expect(Object.keys(models).sort()).toEqual(Object.keys(provider.models).sort())
    for (const m of Object.values(models)) {
      expect(m.rate).toBeUndefined()
      expect(m.rateWas).toBeUndefined()
    }
  })
}

test("a successful empty family remains empty while another family has live rows", async () => {
  const { hooks, provider } = await given()
  catalog({ "/claudecode/v1/models": { data: [] } })
  const models = await hooks.provider.models(provider, { auth })
  expect(Object.keys(models)).toEqual(["gpt-5.5"])
  expect(models[FELL_BACK]).toBeUndefined()
})

test("successful empty experimental Gemini is not replaced with static Gemini rows", async () => {
  const { hooks, provider } = await given({ experimentalGemini: true })
  catalog({ "/gemini/v1beta/models": { models: [] } })
  const models = await hooks.provider.models(provider, { auth })
  expect(Object.keys(models).sort()).toEqual(["claude-sonnet-5-5", "gpt-5.5"])
  expect(models[FELL_BACK]).toBeUndefined()
})

test("Gemini authentication refusal preserves live Claude/Codex rows and marks only Gemini as bundled", async () => {
  const { hooks, provider } = await given({ experimentalGemini: true })
  catalog({ "/gemini/v1beta/models": Response.json({ error: "fake key refused" }, { status: 401 }) })
  const models = await hooks.provider.models(provider, { auth })
  expect(models[FELL_BACK]).toBeUndefined()
  expect(models["gpt-5.5"]).toBeDefined()
  expect(models["claude-sonnet-5-5"]).toBeDefined()
  expect(_internal.modelEvidence(models["gpt-5.5"]).catalogPresent).toBe(true)
  expect(_internal.modelEvidence(models["gemini-3-flash"])).toMatchObject({ source: "bundled-catalog", checkedAt: null, catalogPresent: null })
})

test("all successful empty catalogs do not silently manufacture models", async () => {
  const { hooks, provider } = await given({ experimentalGemini: true })
  catalog({ "/claudecode/v1/models": { data: [] }, "/codex/v1/models": { data: [] }, "/gemini/v1beta/models": { models: [] } })
  const models = await hooks.provider.models(provider, { auth })
  // Explicit whole-table fallback is also honest; an unmarked nonempty result is not.
  expect(Object.keys(models).length === 0 || models[FELL_BACK] === true).toBe(true)
})

test("unknown ID-only catalog entries do not invent budgets, vision or thinking levels", async () => {
  const { hooks, provider } = await given()
  catalog({ "/claudecode/v1/models": { data: [{ id: "claude-unknown-fixture" }] }, "/codex/v1/models": { data: [{ id: "gpt-unknown-fixture" }] } })
  const models = await hooks.provider.models(provider, { auth })
  for (const id of ["claude-unknown-fixture", "gpt-unknown-fixture"]) {
    const m = models[id]
    expect(m.limit).toEqual({ context: 0, output: 0 })
    expect(m.capabilities?.input?.image ?? false).toBe(false)
    expect(m.capabilities?.reasoning ?? false).toBe(false)
    expect(Object.keys(m.variants ?? {})).toEqual([])
  }
})

for (const live of [true, false]) {
  test(`user model overrides survive ${live ? "live" : "fallback"} catalogs`, async () => {
    const override = {
      name: "User label", limit: { context: 12345, output: 123 },
      options: { temperature: 0.3 }, headers: { "x-fixture": "user" },
      provider: { npm: "@ai-sdk/openai", api: "https://custom.example.invalid/responses/v1" },
      variants: { custom: { reasoningEffort: "low" } },
    }
    const { hooks, provider } = await given({ experimentalGemini: false }, { "gpt-5.5": override })
    if (live) catalog()
    const models = await hooks.provider.models(provider, { auth })
    const m = models["gpt-5.5"]
    for (const field of ["name", "limit", "options", "headers", "variants"]) expect(m[field]).toEqual(override[field])
    expect(m.api?.npm ?? m.provider?.npm).toBe(override.provider.npm)
    expect(m.api?.url ?? m.provider?.api).toBe(override.provider.api)
  })
}

for (const live of [true, false]) {
  test(`API ID and partial token limit overrides survive ${live ? "live" : "fallback"} listing`, async () => {
    const { hooks, provider } = await given({ experimentalGemini: false }, {
      "gpt-5.5": { id: "fake-wire-model-id", limit: { input: 321, output: 123 }, options: { reasoningEffort: "low" } },
    })
    if (live) catalog()
    const models = await hooks.provider.models(provider, { auth })
    const m = models["gpt-5.5"]
    expect(m.api?.id ?? m.id).toBe("fake-wire-model-id")
    expect(m.limit).toMatchObject({ context: 400000, input: 321, output: 123 })
    expect(m.options).toEqual({ reasoningEffort: "low" })
  })
}

test("the original Haiku declaration does not acquire reasoning tiers", async () => {
  const { provider } = await given()
  const m = provider.models["claude-haiku-4-5"]
  expect(m.reasoning).toBe(false)
  expect(m.tool_call).toBe(true)
  expect(Object.keys(m.variants)).toEqual([])
})

for (const live of [true, false]) {
  test(`explicit known model absent from the catalog survives ${live ? "live" : "fallback"} listing`, async () => {
    const override = { name: "Configured Claude", tool_call: true,
      provider: { api: "https://custom.example.invalid/v1", npm: "@ai-sdk/anthropic" },
      headers: { "x-custom-secret": "fake-user-secret" }, limit: { output: 123 } }
    const { hooks, provider } = await given({}, { "claude-sonnet-5-5": override })
    if (live) catalog({ "/claudecode/v1/models": { data: [] } })
    const models = await hooks.provider.models(provider, { auth })
    expect(models["claude-sonnet-5-5"].api.url).toBe(override.provider.api)
    expect(models["claude-sonnet-5-5"].capabilities.toolcall).toBe(true)
    expect(models["claude-sonnet-5-5"].limit.output).toBe(123)
  })
}

test("model evidence separates live catalog facts from user capability declarations without serializing secrets", async () => {
  const { hooks, provider } = await given({}, {
    "claude-sonnet-5-5": { tool_call: true, headers: { authorization: "fake-user-secret" } },
    "gpt-5.6-sol": { name: "Explicit absent model" },
  })
  catalog()
  const models = await hooks.provider.models(provider, { auth })
  const live = _internal.modelEvidence(models["claude-sonnet-5-5"])
  expect(live).toMatchObject({ family: "claude", catalogPresent: true, authentication: "unverified" })
  expect(live.source).toBe("https://relay05.gaccode.com/claudecode/v1/models")
  expect(Number.isFinite(Date.parse(live.checkedAt))).toBe(true)
  expect(live.capabilities.toolCall).toBe("user-configured")
  expect(live.capabilities.reasoning).toBe("bundled-default")
  expect(JSON.stringify(live)).not.toContain("fake-user-secret")
  expect(JSON.stringify(models)).not.toContain("checkedAt")
  expect(_internal.modelEvidence(models["gpt-5.6-sol"])).toMatchObject({
    source: "user-config", catalogPresent: false, checkedAt: null, authentication: "unverified",
  })
})

test("bundled fallback evidence does not acquire a successful catalog timestamp", async () => {
  const { hooks, provider } = await given()
  const models = await hooks.provider.models(provider, { auth })
  expect(_internal.modelEvidence(models["gpt-5.5"])).toMatchObject({
    source: "bundled-catalog", checkedAt: null, catalogPresent: null, authentication: "unverified",
  })
})

test("duplicate IDs across protocol catalogs cause whole fallback instead of choosing an arbitrary protocol", async () => {
  const { hooks, provider } = await given()
  catalog({ "/claudecode/v1/models": { data: [{ id: "ambiguous-model" }] },
    "/codex/v1/models": { data: [{ id: "ambiguous-model" }] } })
  const models = await hooks.provider.models(provider, { auth })
  expect(models[FELL_BACK]).toBe(true)
  expect(models["ambiguous-model"]).toBeUndefined()
})

test("disabled explicit models stay excluded and disabled Gemini requires an explicit endpoint", async () => {
  const { hooks, provider } = await given({ experimentalGemini: false }, {
    "claude-sonnet-5-5": { disabled: true }, "gemini-3-flash": { name: "Off experiment" },
    "gemini-2.5-pro": { provider: { api: "https://custom.example.invalid/gemini" } },
  })
  catalog()
  const models = await hooks.provider.models(provider, { auth })
  expect(models["claude-sonnet-5-5"]).toBeUndefined()
  expect(provider.models["gemini-3-flash"]).toBeUndefined()
  expect(models["gemini-3-flash"]).toBeUndefined()
  expect(models["gemini-2.5-pro"].api.url).toBe("https://custom.example.invalid/gemini")
})

for (const [label, logResult] of [
  ["undefined", () => undefined],
  ["truthy non-Promise", () => 1],
  ["synchronous throw", () => { throw new Error("fake synchronous logger failure") }],
  ["Promise rejection", () => Promise.reject(new Error("fake asynchronous logger failure"))],
]) {
  test(`catalog logger ${label} cannot interrupt whole-table fallback`, async () => {
    let logCalls = 0
    const hooks = await GacCodePlugin({ client: { app: { log() {
      logCalls++
      return logResult()
    } } } })
    const cfg = {}
    await hooks.config(cfg)
    const provider = { id: "gaccode", models: cfg.provider.gaccode.models }
    catalog({
      "/claudecode/v1/models": { data: [{ id: "claude-new-live-fixture" }] },
      "/codex/v1/models": Response.json({ error: "fake catalog outage" }, { status: 503 }),
    })
    const models = await hooks.provider.models(provider, { auth })
    expect(logCalls).toBe(1)
    expect(models[FELL_BACK]).toBe(true)
    expect(Object.keys(models).sort()).toEqual(Object.keys(provider.models).sort())
    expect(models["claude-new-live-fixture"]).toBeUndefined()
  })
}
