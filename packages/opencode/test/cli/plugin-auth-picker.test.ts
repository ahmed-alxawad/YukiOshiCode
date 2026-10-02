import { test, expect, describe } from "bun:test"
import { resolvePluginAuth, resolvePluginProviders } from "../../src/cli/cmd/providers"
import type { Hooks } from "@yukioshi/plugin"

function hookWithAuth(provider: string): Hooks {
  return {
    auth: {
      provider,
      methods: [],
    },
  }
}

function hookWithoutAuth(): Hooks {
  return {}
}

describe("resolvePluginProviders", () => {
  test("returns plugin providers not in models.dev", () => {
    const result = resolvePluginProviders({
      hooks: [hookWithAuth("portkey")],
      existingProviders: {},
      disabled: new Set(),
      providerNames: {},
    })
    expect(result).toEqual([{ id: "portkey", name: "portkey" }])
  })

  test("skips providers already in models.dev", () => {
    const result = resolvePluginProviders({
      hooks: [hookWithAuth("anthropic")],
      existingProviders: { anthropic: {} },
      disabled: new Set(),
      providerNames: {},
    })
    expect(result).toEqual([])
  })

  test("deduplicates across plugins", () => {
    const result = resolvePluginProviders({
      hooks: [hookWithAuth("portkey"), hookWithAuth("portkey")],
      existingProviders: {},
      disabled: new Set(),
      providerNames: {},
    })
    expect(result).toEqual([{ id: "portkey", name: "portkey" }])
  })

  test("respects disabled_providers", () => {
    const result = resolvePluginProviders({
      hooks: [hookWithAuth("portkey")],
      existingProviders: {},
      disabled: new Set(["portkey"]),
      providerNames: {},
    })
    expect(result).toEqual([])
  })

  test("respects enabled_providers when provider is absent", () => {
    const result = resolvePluginProviders({
      hooks: [hookWithAuth("portkey")],
      existingProviders: {},
      disabled: new Set(),
      enabled: new Set(["anthropic"]),
      providerNames: {},
    })
    expect(result).toEqual([])
  })

  test("includes provider when in enabled set", () => {
    const result = resolvePluginProviders({
      hooks: [hookWithAuth("portkey")],
      existingProviders: {},
      disabled: new Set(),
      enabled: new Set(["portkey"]),
      providerNames: {},
    })
    expect(result).toEqual([{ id: "portkey", name: "portkey" }])
  })

  test("resolves name from providerNames", () => {
    const result = resolvePluginProviders({
      hooks: [hookWithAuth("portkey")],
      existingProviders: {},
      disabled: new Set(),
      providerNames: { portkey: "Portkey AI" },
    })
    expect(result).toEqual([{ id: "portkey", name: "Portkey AI" }])
  })

  test("falls back to id when no name configured", () => {
    const result = resolvePluginProviders({
      hooks: [hookWithAuth("portkey")],
      existingProviders: {},
      disabled: new Set(),
      providerNames: {},
    })
    expect(result).toEqual([{ id: "portkey", name: "portkey" }])
  })

  test("skips hooks without auth", () => {
    const result = resolvePluginProviders({
      hooks: [hookWithoutAuth(), hookWithAuth("portkey"), hookWithoutAuth()],
      existingProviders: {},
      disabled: new Set(),
      providerNames: {},
    })
    expect(result).toEqual([{ id: "portkey", name: "portkey" }])
  })

  test("returns empty for no hooks", () => {
    const result = resolvePluginProviders({
      hooks: [],
      existingProviders: {},
      disabled: new Set(),
      providerNames: {},
    })
    expect(result).toEqual([])
  })
})

describe("resolvePluginAuth", () => {
  test("keeps Antigravity OAuth alongside another Google auth plugin", () => {
    const api: Hooks = {
      auth: {
        provider: "google",
        methods: [{ type: "api", label: "Google API key" }],
      },
    }
    const antigravity: Hooks = {
      auth: {
        provider: "google",
        methods: [
          {
            type: "oauth",
            label: "OAuth with Google (Antigravity)",
            authorize: async () => ({
              url: "https://accounts.google.test/authorize",
              instructions: "Sign in",
              method: "code",
              callback: async () => ({ type: "success", refresh: "refresh", access: "access", expires: 1 }),
            }),
          },
        ],
      },
    }

    expect(resolvePluginAuth([api, antigravity], "google")?.methods.map((method) => method.label)).toEqual([
      "Google API key",
      "OAuth with Google (Antigravity)",
    ])
  })

  test("uses the later implementation for a duplicate auth method", () => {
    const first = hookWithAuth("google")
    first.auth!.methods = [{ type: "api", label: "Google API key" }]
    const second = hookWithAuth("google")
    second.auth!.methods = [{ type: "api", label: "Google API key" }]

    const auth = resolvePluginAuth([first, second], "google")
    expect(auth?.methods).toHaveLength(1)
    expect(auth?.methods[0]).toBe(second.auth!.methods[0])
  })
})
