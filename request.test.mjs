import { afterEach, beforeEach, expect, test } from "bun:test"
import { GacCodePlugin } from "./index.mjs"

const originalFetch = globalThis.fetch
const mainAuth = { type: "api", key: "fake-main-key", metadata: { host: "https://gaccode.com" } }
const relayAuth = { type: "api", key: "fake-relay-key", metadata: { host: "https://relay05.gaccode.com" } }
beforeEach(() => { globalThis.fetch = async () => { throw new Error("unexpected network request") } })
afterEach(() => { globalThis.fetch = originalFetch })

async function loader(getAuth = async () => relayAuth) {
  return (await GacCodePlugin({}, { experimentalGemini: true })).auth.loader(getAuth)
}

const protocols = [
  ["Claude", "/claudecode/v1/messages?beta=tools", "x-api-key"],
  ["Codex", "/codex/v1/responses?fixture=1", "authorization"],
  ["experimental Gemini GenAI", "/gemini/v1beta/models/gemini-fixture:streamGenerateContent?alt=sse", "x-goog-api-key"],
]

for (const [family, path, credentialHeader] of protocols) {
  for (const shape of ["string", "URL", "Request"]) {
    test(`${family} ${shape} request follows account host while preserving protocol and payload`, async () => {
      let seen
      globalThis.fetch = async (input, init) => {
        seen = new Request(input, init)
        return Response.json({ id: "fake-success" })
      }
      const loaded = await loader()
      const controller = new AbortController()
      const body = JSON.stringify({ model: "fixture-model", tools: [{ type: "function", name: "fixture_tool" }], input: "fake prompt" })
      const init = { method: "POST", body, headers: { "content-type": "application/json", "x-fixture": "preserved", "anthropic-version": "2023-06-01" }, signal: controller.signal }
      const url = `https://gaccode.com${path}`
      const input = shape === "string" ? url : shape === "URL" ? new URL(url) : new Request(url, init)
      await loaded.fetch(input, shape === "Request" ? undefined : init)
      expect(seen.url).toBe(`https://relay05.gaccode.com${path}`)
      expect(seen.method).toBe("POST")
      expect(await seen.text()).toBe(body)
      expect(seen.headers.get("x-fixture")).toBe("preserved")
      expect(seen.headers.get("anthropic-version")).toBe("2023-06-01")
      expect(seen.headers.get(credentialHeader)).toBe(credentialHeader === "authorization" ? "Bearer fake-relay-key" : "fake-relay-key")
      controller.abort()
      expect(seen.signal.aborted).toBe(true)
    })
  }
}

test("managed relayNN URL is also rewritten after account moves back to the main host", async () => {
  let seen
  globalThis.fetch = async (input, init) => { seen = new Request(input, init); return Response.json({}) }
  const loaded = await loader(async () => mainAuth)
  await loaded.fetch("https://relay99.gaccode.com/codex/v1/responses?keep=yes", { method: "POST", body: "{}" })
  expect(seen.url).toBe("https://gaccode.com/codex/v1/responses?keep=yes")
})

for (const url of [
  "https://custom.example.invalid/claudecode/v1/messages?keep=1",
  "https://gaccode.com/custom/v1/messages?keep=1",
  "https://gaccode.com.example.invalid/codex/v1/responses",
  "https://other.gaccode.com/codex/v1/responses",
]) {
  test(`explicit custom URL retains its origin and path: ${url}`, async () => {
    let seen
    globalThis.fetch = async (input, init) => { seen = new Request(input, init); return Response.json({}) }
    await (await loader()).fetch(new URL(url), { method: "POST", body: "fake body" })
    expect(seen.url).toBe(url)
    expect(await seen.text()).toBe("fake body")
  })
}

test("two successful accounts sharing a cached main model URL still send on their own hosts", async () => {
  const seen = []
  globalThis.fetch = async (input, init) => { seen.push(new Request(input, init)); return Response.json({}) }
  const a = await loader(async () => mainAuth)
  const b = await loader(async () => relayAuth)
  const cached = "https://gaccode.com/codex/v1/responses"
  await a.fetch(cached, { method: "POST", body: "{}" })
  await b.fetch(cached, { method: "POST", body: "{}" })
  expect(seen.map((r) => new URL(r.url).hostname)).toEqual(["gaccode.com", "relay05.gaccode.com"])
  expect(seen.map((r) => r.headers.get("authorization"))).toEqual(["Bearer fake-main-key", "Bearer fake-relay-key"])
})

test("first offline catalog fallback cannot route relay inference through the cached main origin", async () => {
  const hooks = await GacCodePlugin({})
  const cfg = {}
  await hooks.config(cfg)
  globalThis.fetch = async () => { throw new Error("offline fixture") }
  const models = await hooks.provider.models({ models: cfg.provider.gaccode.models }, { auth: relayAuth })
  expect(models[Symbol.for("magpie.fellBack")]).toBe(true)
  const entry = Object.entries(models).find(([id]) => id.startsWith("claude-"))
  expect(entry).toBeDefined()
  const base = entry[1].api?.url ?? entry[1].provider?.api
  let seen
  globalThis.fetch = async (input, init) => { seen = new Request(input, init); return Response.json({}) }
  await (await hooks.auth.loader(async () => relayAuth)).fetch(`${base}/messages`, { method: "POST", body: "{}" })
  expect(new URL(seen.url).origin).toBe("https://relay05.gaccode.com")
})

test("fetch re-reads getAuth when host and key change after loader creation", async () => {
  let current = mainAuth
  const seen = []
  globalThis.fetch = async (input, init) => { seen.push(new Request(input, init)); return Response.json({}) }
  const loaded = await loader(async () => current)
  const cached = "https://gaccode.com/codex/v1/responses"
  await loaded.fetch(cached, { method: "POST", body: "{}" })
  current = { ...relayAuth, key: "fake-rotated-key", metadata: { host: "https://relay07.gaccode.com" } }
  await loaded.fetch(cached, { method: "POST", body: "{}" })
  expect(seen.at(-1).url).toBe("https://relay07.gaccode.com/codex/v1/responses")
  expect(seen.at(-1).headers.get("authorization")).toBe("Bearer fake-rotated-key")
})

test("Request init overrides survive rewriting along with original headers", async () => {
  let seen
  globalThis.fetch = async (input, init) => { seen = new Request(input, init); return Response.json({}) }
  const input = new Request("https://gaccode.com/codex/v1/responses?request=1", { method: "POST", body: "old", headers: { "x-old": "original" } })
  await (await loader()).fetch(input, { body: "overridden" })
  expect(seen.url).toBe("https://relay05.gaccode.com/codex/v1/responses?request=1")
  expect(seen.method).toBe("POST")
  expect(seen.headers.get("x-old")).toBe("original")
  expect(await seen.text()).toBe("overridden")
})

test("streaming Request body reaches fetch before production and keeps late cancellation", async () => {
  let producer
  let seen
  const body = new ReadableStream({ start(c) { producer = c } })
  const controller = new AbortController()
  const input = new Request("https://gaccode.com/codex/v1/responses?stream=body", {
    method: "POST", body, duplex: "half", signal: controller.signal, headers: { "x-stream-fixture": "preserved" },
  })
  globalThis.fetch = async (target, init) => {
    seen = new Request(target, init)
    return Response.json({ id: "fake-immediate-ack" })
  }
  try {
    await (await loader()).fetch(input)
    expect(seen.url).toBe("https://relay05.gaccode.com/codex/v1/responses?stream=body")
    expect(seen.headers.get("x-stream-fixture")).toBe("preserved")
    expect(seen.bodyUsed).toBe(false)
    producer.enqueue(new TextEncoder().encode('{"input":'))
    producer.enqueue(new TextEncoder().encode('"fake-stream"}'))
    producer.close()
    expect(await seen.text()).toBe('{"input":"fake-stream"}')
    controller.abort()
    expect(seen.signal.aborted).toBe(true)
  } finally {
    if (seen && !seen.bodyUsed) await seen.body.cancel()
  }
}, 1000)

test("Request init signal override wins and remains connected after host rewriting", async () => {
  let seen
  const original = new AbortController()
  const replacement = new AbortController()
  const input = new Request("https://gaccode.com/claudecode/v1/messages", { method: "POST", body: "{}", signal: original.signal })
  globalThis.fetch = async (target, init) => { seen = new Request(target, init); return Response.json({}) }
  await (await loader()).fetch(input, { signal: replacement.signal })
  original.abort()
  expect(seen.signal.aborted).toBe(false)
  replacement.abort()
  expect(seen.signal.aborted).toBe(true)
})

for (const shape of ["string", "URL", "Request"]) {
  test(`disabled experimental Gemini blocks managed cached ${shape} requests before fetch`, async () => {
    let calls = 0
    globalThis.fetch = async () => { calls++; return Response.json({}) }
    const hooks = await GacCodePlugin({}, { experimentalGemini: false })
    const loaded = await hooks.auth.loader(async () => relayAuth)
    const url = "https://gaccode.com/gemini/v1beta/models/gemini-fixture:generateContent"
    const init = { method: "POST", body: "{}" }
    const input = shape === "string" ? url : shape === "URL" ? new URL(url) : new Request(url, init)
    await expect(loaded.fetch(input, shape === "Request" ? undefined : init)).rejects.toThrow(/Gemini.*未启用|experimental.*Gemini/i)
    expect(calls).toBe(0)
  })
}

test("explicit user model endpoint on a managed host remains unchanged with its custom credential", async () => {
  const hooks = await GacCodePlugin({})
  const cfg = { provider: { gaccode: { models: {
    "gpt-5.5": { provider: { npm: "@ai-sdk/openai", api: "https://gaccode.com/codex/v1" } },
  } } } }
  await hooks.config(cfg)
  let seen
  globalThis.fetch = async (target, init) => { seen = new Request(target, init); return Response.json({}) }
  const loaded = await hooks.auth.loader(async () => relayAuth)
  await loaded.fetch("https://gaccode.com/codex/v1/responses?custom=1", {
    method: "POST", body: "{}", headers: { authorization: "Bearer fake-custom-credential" },
  })
  expect(seen.url).toBe("https://gaccode.com/codex/v1/responses?custom=1")
  expect(seen.headers.get("authorization")).toBe("Bearer fake-custom-credential")
})

for (const [status, body, contentType] of [
  [401, '{"error":{"type":"authentication_error","message":"Invalid API key"}}', "application/json"],
  [429, '{"error":{"type":"insufficient_quota","message":"Insufficient credits"}}', "application/json"],
  [429, '{"error":{"type":"rate_limit_error","message":"Too many requests"}}', "application/json"],
  [403, "Insufficient credits: plain upstream text", "text/plain"],
  [502, "<html>upstream unavailable</html>", "text/html"],
]) {
  const label = body.includes("insufficient_quota") ? "insufficient quota" : body.includes("rate_limit_error") ? "rate limit" : contentType
  test(`upstream ${status} ${label} error retains bytes, status and transport headers`, async () => {
    const upstream = new Response(body, { status, statusText: "Fixture refusal", headers: {
      "content-type": contentType, "content-length": String(Buffer.byteLength(body)), "content-encoding": "identity", "retry-after": "37", "x-fixture-upstream": "preserved",
    } })
    const upstreamHeaders = [...upstream.headers.entries()]
    globalThis.fetch = async () => upstream
    const res = await (await loader()).fetch("https://gaccode.com/codex/v1/responses", { method: "POST", body: "{}" })
    expect(res.status).toBe(status)
    expect(res.statusText).toBe("Fixture refusal")
    expect([...res.headers.entries()]).toEqual(upstreamHeaders)
    expect(res.headers.has("x-magpie-sign-in")).toBe(false)
    expect(await res.text()).toBe(body)
  })
}

test("successful SSE is returned before any chunks arrive and is not buffered", async () => {
  let streamController
  const stream = new ReadableStream({ start(c) { streamController = c } })
  const upstream = new Response(stream, { headers: { "content-type": "text/event-stream" } })
  globalThis.fetch = async () => upstream
  try {
    const res = await (await loader()).fetch("https://gaccode.com/claudecode/v1/messages", { method: "POST", body: "{}" })
    expect(res).toBe(upstream)
    expect(res.bodyUsed).toBe(false)
    const chunk = 'event: content_block_delta\ndata: {"type":"input_json_delta","partial_json":"{}"}\n\n'
    streamController.enqueue(new TextEncoder().encode(chunk))
    streamController.close()
    expect(await res.text()).toBe(chunk)
  } finally {
    if (!upstream.bodyUsed) await upstream.body.cancel()
  }
}, 1000)

test("tool call response is passed through with the upstream structure", async () => {
  const body = { id: "fake-response", output: [{ type: "function_call", call_id: "fake-call", name: "fixture_tool", arguments: '{"value":1}' }] }
  const upstream = Response.json(body)
  globalThis.fetch = async () => upstream
  const res = await (await loader()).fetch("https://gaccode.com/codex/v1/responses", { method: "POST", body: "{}" })
  expect(res).toBe(upstream)
  expect(await res.json()).toEqual(body)
})

test("cancellation reaches fetch and AbortError is not turned into a provider response", async () => {
  globalThis.fetch = async (input, init) => {
    const req = new Request(input, init)
    req.signal.throwIfAborted()
    throw new Error("fixture must be aborted")
  }
  const controller = new AbortController()
  controller.abort()
  const loaded = await loader()
  await expect(loaded.fetch(new Request("https://gaccode.com/codex/v1/responses", { method: "POST", body: "{}", signal: controller.signal }))).rejects.toMatchObject({ name: "AbortError" })
})
