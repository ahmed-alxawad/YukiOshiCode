import { describe, expect, spyOn, test } from "bun:test"
import { GoogleAuth } from "google-auth-library"
import { GoogleAIStudioAuthPlugin, GoogleVertexAuthPlugin } from "../../src/plugin/google"

const input = {} as any

async function vertexSignIn() {
  const [signIn] = (await GoogleVertexAuthPlugin(input)).auth!.methods
  if (signIn.type !== "oauth") throw new Error("expected the sign-in method")
  return signIn
}

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

describe("GoogleVertexAuthPlugin", () => {
  test("asks for a valid project ID and a region", async () => {
    const hooks = await GoogleVertexAuthPlugin(input)
    expect(hooks.auth?.provider).toBe("google-vertex")
    const [signIn] = hooks.auth!.methods
    if (signIn.type !== "oauth") throw new Error("expected the sign-in method")
    const [project, location] = signIn.prompts ?? []
    if (project?.type !== "text" || location?.type !== "select") throw new Error("expected project and region prompts")
    expect(project.validate?.("my-project-123")).toBeUndefined()
    expect(project.validate?.("Not A Project")).toBeString()
    expect(location.options.map((option) => option.value)).toContain("global")
  })

  test("explains how to install gcloud when there is no Google sign-in and no gcloud", async () => {
    // Stub the environment: CI runners may have gcloud or Google credentials of their own.
    const client = spyOn(GoogleAuth.prototype, "getClient").mockRejectedValue(new Error("no credentials"))
    const which = spyOn(Bun, "which").mockReturnValue(null)
    try {
      const signIn = await vertexSignIn()
      const authorization = await signIn.authorize({ project: "my-project-123", location: "global" })
      expect(authorization.url).toBe("https://cloud.google.com/sdk/docs/install")
      expect(authorization.instructions).toContain("gcloud")
      if (authorization.method !== "auto") throw new Error("expected an automatic flow")
      expect(await authorization.callback()).toEqual({ type: "failed" })
    } finally {
      client.mockRestore()
      which.mockRestore()
    }
  })

  test("reuses an existing Google sign-in and records the project and region", async () => {
    const client = spyOn(GoogleAuth.prototype, "getClient").mockResolvedValue({
      getAccessToken: async () => ({ token: "ya29.example" }),
    } as any)
    try {
      const signIn = await vertexSignIn()
      const authorization = await signIn.authorize({ project: " my-project-123 ", location: "europe-west4" })
      expect(authorization.instructions).toContain("existing Google sign-in")
      if (authorization.method !== "auto") throw new Error("expected an automatic flow")
      expect(await authorization.callback()).toEqual({
        type: "success",
        key: "google-adc",
        metadata: { project: "my-project-123", location: "europe-west4" },
      })
    } finally {
      client.mockRestore()
    }
  })
})
