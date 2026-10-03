import { describe, expect, test } from "bun:test"
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
    expect(await authorization.callback("  AIzaSyExample  ")).toEqual({ type: "success", key: "AIzaSyExample" })
    expect(await authorization.callback("   ")).toEqual({ type: "failed" })
  })
})
