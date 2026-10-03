import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { GoogleAIStudioAuthPlugin, GoogleVertexAuthPlugin } from "../../src/plugin/google"

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
    const empty = await mkdtemp(path.join(os.tmpdir(), "yukioshi-google-"))
    const saved = { PATH: process.env.PATH, HOME: process.env.HOME, GAC: process.env.GOOGLE_APPLICATION_CREDENTIALS, CLOUDSDK: process.env.CLOUDSDK_CONFIG }
    process.env.PATH = empty
    process.env.HOME = empty
    process.env.CLOUDSDK_CONFIG = empty
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS
    try {
      const hooks = await GoogleVertexAuthPlugin(input)
      const [signIn] = hooks.auth!.methods
      if (signIn.type !== "oauth") throw new Error("expected the sign-in method")
      const authorization = await signIn.authorize({ project: "my-project-123", location: "global" })
      expect(authorization.url).toBe("https://cloud.google.com/sdk/docs/install")
      expect(authorization.instructions).toContain("gcloud")
      if (authorization.method !== "auto") throw new Error("expected an automatic flow")
      expect(await authorization.callback()).toEqual({ type: "failed" })
    } finally {
      for (const [key, value] of [["PATH", saved.PATH], ["HOME", saved.HOME], ["GOOGLE_APPLICATION_CREDENTIALS", saved.GAC], ["CLOUDSDK_CONFIG", saved.CLOUDSDK]] as const) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      await rm(empty, { recursive: true, force: true })
    }
  })
})
