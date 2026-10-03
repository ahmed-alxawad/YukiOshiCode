import type { Hooks, PluginInput } from "@yukioshi/plugin"
import { existsSync } from "node:fs"
import os from "node:os"
import path from "node:path"

// Google sign-in through Google's supported routes only. Consumer "sign in with Google" flows
// that reuse Google's own apps' OAuth clients (as some Antigravity / Gemini CLI plugins do) are
// not allowed by Google's terms and put accounts at risk, so YukiOshi does not bundle them.
// YukiOshi never opens a browser for these sign-ins: it shows the link, the user opens it on any
// device, and pastes back the key or code.

const AI_STUDIO_KEYS_URL = "https://aistudio.google.com/apikey"
const GCLOUD_INSTALL_URL = "https://cloud.google.com/sdk/docs/install"
const VERTEX_CONSOLE_URL = "https://console.cloud.google.com/vertex-ai"
const ADC_HELP_URL = "https://cloud.google.com/docs/authentication/provide-credentials-adc"
const SIGN_IN_TIMEOUT_MS = 10 * 60 * 1000
const LINK_TIMEOUT_MS = 60 * 1000

/**
 * Stored as the Vertex AI credential's key after "Sign in with Google". It only marks the sign-in:
 * the real credential stays in Google's own store, and the marker must never be sent as an API key.
 */
export const GOOGLE_SIGN_IN_KEY = "google-adc"

/** Gemini through Google AI Studio: sign in with a Google account, free tier included. */
export async function GoogleAIStudioAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "google",
      methods: [
        {
          type: "oauth",
          label: "Sign in with Google AI Studio (free and paid)",
          authorize: async () => ({
            url: AI_STUDIO_KEYS_URL,
            instructions:
              "Open this link on any device, sign in with your Google account, click Create API key (the free tier needs no billing), then paste the key here.",
            method: "code" as const,
            callback: async (code: string) => {
              const key = code.trim()
              return key ? { type: "success" as const, key } : { type: "failed" as const }
            },
          }),
        },
        {
          type: "api",
          label: "Enter an existing Gemini API key",
        },
      ],
    },
  }
}

// Where google-auth-library looks for a Google sign-in, without probing the cloud metadata server
// (which takes seconds when it is not there).
function googleCredentialFile() {
  const file = process.env.GOOGLE_APPLICATION_CREDENTIALS
  if (file) return file
  const config =
    process.platform === "win32"
      ? path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), "gcloud")
      : path.join(os.homedir(), ".config", "gcloud")
  return path.join(config, "application_default_credentials.json")
}

async function hasGoogleCredentials() {
  if (!existsSync(googleCredentialFile())) return false
  try {
    const { GoogleAuth } = await import("google-auth-library")
    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] })
    const token = await (await auth.getClient()).getAccessToken()
    return Boolean(token.token)
  } catch {
    return false
  }
}

// Resolves with the first Google sign-in link the process prints, while draining both streams.
function findSignInLink(streams: ReadableStream<Uint8Array>[]) {
  return new Promise<string | undefined>((resolve) => {
    let text = ""
    const timer = setTimeout(() => resolve(undefined), LINK_TIMEOUT_MS)
    const done = (url: string | undefined) => {
      clearTimeout(timer)
      resolve(url)
    }
    const drain = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder()
      const reader = stream.getReader()
      while (true) {
        const { done: end, value } = await reader.read()
        if (end) return
        text += decoder.decode(value, { stream: true })
        const match = text.match(/https:\/\/accounts\.google\.com\/\S+(?=\s)/)
        if (match) done(match[0])
      }
    }
    void Promise.all(streams.map(drain)).then(() => done(undefined))
  })
}

/**
 * Starts Google's own no-browser sign-in (`gcloud auth application-default login --no-launch-browser`).
 * gcloud prints a link and waits for the verification code Google shows after the user signs in; the
 * code is passed to gcloud, which stores Application Default Credentials for the Vertex AI provider.
 */
async function startGoogleSignIn(gcloud: string) {
  const child = Bun.spawn([gcloud, "auth", "application-default", "login", "--no-launch-browser", "--quiet"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
  const timer = setTimeout(() => child.kill(), SIGN_IN_TIMEOUT_MS)
  void child.exited.finally(() => clearTimeout(timer))
  const url = await findSignInLink([child.stdout, child.stderr])
  if (!url) {
    child.kill()
    return undefined
  }
  return {
    url,
    finish: async (code: string) => {
      child.stdin.write(code + "\n")
      await child.stdin.end()
      return (await child.exited) === 0
    },
  }
}

/** Gemini on Vertex AI: Google sign-in for your Google Cloud account, without opening a browser. */
export async function GoogleVertexAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "google-vertex",
      methods: [
        {
          type: "oauth",
          label: "Sign in with Google",
          prompts: [
            {
              type: "text",
              key: "project",
              message: "Google Cloud project ID (Vertex AI API enabled, billing set up)",
              placeholder: "e.g. my-project-123",
              validate: (value) => (/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(value.trim()) ? undefined : "Enter a project ID"),
            },
            {
              type: "select",
              key: "location",
              message: "Region",
              options: [
                { label: "Global", value: "global", hint: "recommended" },
                { label: "US (us-central1)", value: "us-central1" },
                { label: "Europe (europe-west4)", value: "europe-west4" },
                { label: "Asia (asia-northeast1)", value: "asia-northeast1" },
              ],
            },
          ],
          authorize: async (inputs = {}) => {
            const metadata = { project: (inputs.project ?? "").trim(), location: inputs.location || "global" }
            const failed = { type: "failed" as const }
            // The credential lives in Google's own store; this entry records where to use it.
            const success = { type: "success" as const, key: GOOGLE_SIGN_IN_KEY, metadata }

            if (await hasGoogleCredentials()) {
              return {
                url: VERTEX_CONSOLE_URL,
                instructions: `Using your existing Google sign-in for project ${metadata.project}.`,
                method: "auto" as const,
                callback: async () => success,
              }
            }
            const gcloud = Bun.which("gcloud", { PATH: process.env.PATH ?? "" })
            if (!gcloud) {
              return {
                url: GCLOUD_INSTALL_URL,
                instructions: "Signing in with Google needs the Google Cloud CLI (gcloud). Install it, then choose this option again.",
                method: "auto" as const,
                callback: async () => failed,
              }
            }
            const signIn = await startGoogleSignIn(gcloud)
            if (!signIn) {
              return {
                url: ADC_HELP_URL,
                instructions:
                  "gcloud did not start the sign-in. Run `gcloud auth application-default login --no-launch-browser` in a terminal, then choose this option again.",
                method: "auto" as const,
                callback: async () => failed,
              }
            }
            return {
              url: signIn.url,
              instructions:
                "Open this link on any device, sign in with your Google account and allow access, then paste the verification code Google shows.",
              method: "code" as const,
              callback: async (code: string) => {
                if (!code.trim() || !(await signIn.finish(code.trim()))) return failed
                return (await hasGoogleCredentials()) ? success : failed
              },
            }
          },
        },
      ],
    },
  }
}
