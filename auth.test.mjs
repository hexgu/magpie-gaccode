import { afterEach, beforeEach, expect, test } from "bun:test"
import { GacCodePlugin } from "./index.mjs"

const originalFetch = globalThis.fetch
beforeEach(() => { globalThis.fetch = async () => { throw new Error("unexpected network request") } })
afterEach(() => { globalThis.fetch = originalFetch })

test("API key is entered separately by the host: one API method without an authorizer", async () => {
  const { auth } = await GacCodePlugin({})
  expect(auth.provider).toBe("gaccode")
  expect(auth.methods.map((m) => m.type)).toEqual(["api"])
  expect(auth.methods[0].authorize).toBeUndefined()
})

test("prompts collect only host and optional website token, never password or automatic reset", async () => {
  const { auth } = await GacCodePlugin({})
  expect(auth.methods.flatMap((m) => m.prompts ?? []).map((p) => p.key).sort())
    .toEqual(["host", "loginToken"])
})

for (const loginToken of ["", "fake-site-jwt"]) {
  test(`loader accepts separately saved fake API key with ${loginToken ? "optional JWT" : "no JWT"}`, async () => {
    const hooks = await GacCodePlugin({})
    const saved = { type: "api", key: "fake-api-key", metadata: { host: "https://relay05.gaccode.com", loginToken } }
    const loaded = await hooks.auth.loader(async () => saved)
    expect(loaded.apiKey).toBe("fake-api-key")
    expect(typeof loaded.fetch).toBe("function")
  })
}

test("unsigned loader does not provide inference credentials", async () => {
  const hooks = await GacCodePlugin({})
  expect(await hooks.auth.loader(async () => undefined)).toEqual({})
})
