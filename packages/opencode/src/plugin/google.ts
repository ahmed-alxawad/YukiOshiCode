import type { Hooks, PluginInput } from "@yukioshi/plugin"

// Gemini sign-in through Google AI Studio. YukiOshi never opens a browser for it: it shows the
// link, the user opens it on any device, and pastes back the key.

const AI_STUDIO_KEYS_URL = "https://aistudio.google.com/apikey"

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
