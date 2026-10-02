import { describe, expect, test } from "bun:test"
import { providerOptions } from "../../../../src/component/dialog-provider"

describe("providerOptions", () => {
  test("shows only YukiOshi's selected providers in the intended order", () => {
    expect(
      providerOptions([
        { id: "openai", name: "OpenAI" },
        { id: "custom-z", name: "Zebra Provider" },
        { id: "anthropic", name: "Anthropic" },
        { id: "mistral", name: "Mistral" },
        { id: "aws", name: "AWS Bedrock" },
        { id: "google", name: "Google" },
        { id: "xai", name: "xAI" },
        { id: "nvidia", name: "Nvidia" },
      ]).map((option) => option.value),
    ).toEqual(["anthropic", "openai", "google", "xai", "nvidia"])
  })

  test("uses product-facing names for OAuth and model families", () => {
    const options = providerOptions([
      { id: "anthropic", name: "Anthropic" },
      { id: "openai", name: "OpenAI" },
      { id: "google", name: "Google" },
      { id: "zai", name: "Z.AI" },
    ])

    expect(options.map((option) => option.title)).toEqual([
      "Claude (Anthropic)",
      "Codex (OpenAI)",
      "Antigravity OAuth (Google)",
      "Z.AI (GLM)",
    ])
  })

  test("does not add an Other or custom-provider option", () => {
    const options = providerOptions([
      { id: "openrouter", name: "OpenRouter" },
      { id: "custom-provider", name: "Custom Provider" },
    ])

    expect(options.map((option) => option.value)).toEqual(["openrouter"])
    expect(options.some((option) => option.title === "Other")).toBe(false)
  })
})
