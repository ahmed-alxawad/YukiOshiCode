import { describe, expect, spyOn, test } from "bun:test"
import { GoogleAIStudioAuthPlugin } from "../../src/plugin/google"

const input = {} as any

describe("GoogleAIStudioAuthPlugin", () => {
  test("opens AI Studio and accepts a pasted key, or an existing key", async () => {
    const hooks = await GoogleAIStudioAuthPlugin(input)
    expect(hooks.auth?.provider).toBe("google")
    const [signIn, manual] = hooks.auth!.methods
    expect(manual).toMatchObject({ type: "api" })
    if (signIn.type !== "oauth") throw new Error("expected the AI Studio sign-in method")

    const authorization = await signIn.authorize()
    expect(authorization.url).toBe("https://aistudio.google.com/apikey")
    if (authorization.method !== "code") throw new Error("expected a paste-the-key flow")

    // Google accepts the key.
    const accepted = spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }))
    try {
      expect(await authorization.callback("  AIzaSyExample  ")).toEqual({ type: "success", key: "AIzaSyExample" })
      expect(String(accepted.mock.calls[0]?.[0])).toContain("generativelanguage.googleapis.com")
    } finally {
      accepted.mockRestore()
    }
    expect(await authorization.callback("   ")).toEqual({ type: "failed" })
  })

  test("rejects a key Google refuses, but keeps the key when Google cannot be reached", async () => {
    const hooks = await GoogleAIStudioAuthPlugin(input)
    const [signIn] = hooks.auth!.methods
    if (signIn.type !== "oauth") throw new Error("expected the AI Studio sign-in method")
    const authorization = await signIn.authorize()
    if (authorization.method !== "code") throw new Error("expected a paste-the-key flow")

    const rejected = spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 400 }))
    try {
      expect(await authorization.callback("AIzaSyTypo")).toEqual({ type: "failed" })
    } finally {
      rejected.mockRestore()
    }

    const offline = spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("fetch failed"))
    try {
      expect(await authorization.callback("AIzaSyOffline")).toEqual({ type: "success", key: "AIzaSyOffline" })
    } finally {
      offline.mockRestore()
    }
  })
})
