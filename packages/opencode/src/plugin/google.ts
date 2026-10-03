import type { Hooks, PluginInput } from "@yukioshi/plugin"

// Google sign-in through Google's supported routes only. Consumer "sign in with Google" flows
// that reuse Google's own apps' OAuth clients (as some Antigravity / Gemini CLI plugins do) are
// not allowed by Google's terms and put accounts at risk, so YukiOshi does not bundle them.

const AI_STUDIO_KEYS_URL = "https://aistudio.google.com/apikey"
const GCLOUD_INSTALL_URL = "https://cloud.google.com/sdk/docs/install"
const VERTEX_CONSOLE_URL = "https://console.cloud.google.com/vertex-ai"
const SIGN_IN_TIMEOUT_MS = 5 * 60 * 1000

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
              "Sign in with your Google account, click Create API key (the free tier needs no billing), then paste the key here.",
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

async function hasGoogleCredentials() {
  try {
    const { GoogleAuth } = await import("google-auth-library")
    const auth = new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] })
    const token = await (await auth.getClient()).getAccessToken()
    return Boolean(token.token)
  } catch {
    return false
  }
}

async function runGoogleSignIn() {
  // Google's own CLI runs the browser sign-in and stores Application Default Credentials,
  // which the Vertex AI provider reads through google-auth-library.
  const child = Bun.spawn(["gcloud", "auth", "application-default", "login", "--quiet"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })
  const timer = setTimeout(() => child.kill(), SIGN_IN_TIMEOUT_MS)
  const code = await child.exited.finally(() => clearTimeout(timer))
  return code === 0
}

/** Gemini on Vertex AI: Google's browser sign-in for your Google Cloud account. */
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
            const signedIn = await hasGoogleCredentials()
            if (!signedIn && !Bun.which("gcloud")) {
              return {
                url: GCLOUD_INSTALL_URL,
                instructions: "Signing in with Google needs the Google Cloud CLI (gcloud). Install it, then choose this option again.",
                method: "auto" as const,
                callback: async () => ({ type: "failed" as const }),
              }
            }
            return {
              url: VERTEX_CONSOLE_URL,
              instructions: signedIn
                ? `Using your existing Google sign-in for project ${metadata.project}.`
                : "A browser window opens: sign in with your Google account and allow access.",
              method: "auto" as const,
              callback: async () => {
                if (!signedIn && !(await runGoogleSignIn())) return { type: "failed" as const }
                if (!(await hasGoogleCredentials())) return { type: "failed" as const }
                // The credential lives in Google's own store; this entry records where to use it.
                return { type: "success" as const, key: "google-adc", metadata }
              },
            }
          },
        },
      ],
    },
  }
}
