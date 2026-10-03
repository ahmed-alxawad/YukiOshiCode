import { describe, expect, spyOn, test } from "bun:test"
import { GoogleAuth } from "google-auth-library"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { GOOGLE_SIGN_IN_KEY, GoogleAIStudioAuthPlugin, GoogleVertexAuthPlugin } from "../../src/plugin/google"

const input = {} as any

// Runs `fn` with the given environment variables set (undefined removes one), then restores them.
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>) {
  const saved = Object.fromEntries(Object.keys(vars).map((key) => [key, process.env[key]]))
  const apply = (values: Record<string, string | undefined>) => {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
  apply(vars)
  try {
    return await fn()
  } finally {
    apply(saved)
  }
}

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
    const dir = await mkdtemp(path.join(os.tmpdir(), "yukioshi-adc-"))
    const file = path.join(dir, "adc.json")
    await writeFile(file, "{}")
    const client = spyOn(GoogleAuth.prototype, "getClient").mockResolvedValue({
      getAccessToken: async () => ({ token: "ya29.example" }),
    } as any)
    try {
      await withEnv({ GOOGLE_APPLICATION_CREDENTIALS: file }, async () => {
        const signIn = await vertexSignIn()
        const authorization = await signIn.authorize({ project: " my-project-123 ", location: "europe-west4" })
        expect(authorization.instructions).toContain("existing Google sign-in")
        if (authorization.method !== "auto") throw new Error("expected an automatic flow")
        expect(await authorization.callback()).toEqual({
          type: "success",
          key: GOOGLE_SIGN_IN_KEY,
          metadata: { project: "my-project-123", location: "europe-west4" },
        })
      })
    } finally {
      client.mockRestore()
      await rm(dir, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === "win32")(
    "signs in without a browser: shows Google's link and passes the pasted code to gcloud",
    async () => {
      // A stand-in gcloud: prints a sign-in link, then accepts only "good-code" and writes the sign-in file.
      const dir = await mkdtemp(path.join(os.tmpdir(), "yukioshi-gcloud-"))
      const adc = path.join(dir, "adc.json")
      await writeFile(
        path.join(dir, "gcloud"),
        [
          "#!/bin/sh",
          'echo "$@" > "$(dirname "$0")/args"',
          'printf "Go to the following link:\\n\\n    https://accounts.google.com/o/oauth2/auth?client_id=x&state=y\\n\\nEnter the verification code: " >&2',
          "read code",
          '[ "$code" = "good-code" ] || exit 1',
          `echo "{}" > "${adc}"`,
        ].join("\n"),
        { mode: 0o755 },
      )
      const client = spyOn(GoogleAuth.prototype, "getClient").mockResolvedValue({
        getAccessToken: async () => ({ token: "ya29.example" }),
      } as any)
      try {
        await withEnv({ PATH: `${dir}${path.delimiter}${process.env.PATH}`, GOOGLE_APPLICATION_CREDENTIALS: adc }, async () => {
          const signIn = await vertexSignIn()
          const rejected = await signIn.authorize({ project: "my-project-123", location: "global" })
          expect(rejected.url).toBe("https://accounts.google.com/o/oauth2/auth?client_id=x&state=y")
          if (rejected.method !== "code") throw new Error("expected a paste-the-code flow")
          expect(await rejected.callback("bad-code")).toEqual({ type: "failed" })

          const accepted = await signIn.authorize({ project: "my-project-123", location: "us-central1" })
          if (accepted.method !== "code") throw new Error("expected a paste-the-code flow")
          expect(await accepted.callback(" good-code ")).toEqual({
            type: "success",
            key: GOOGLE_SIGN_IN_KEY,
            metadata: { project: "my-project-123", location: "us-central1" },
          })
        })
        expect(await Bun.file(path.join(dir, "args")).text()).toContain("--no-launch-browser")
      } finally {
        client.mockRestore()
        await rm(dir, { recursive: true, force: true })
      }
    },
  )
})
