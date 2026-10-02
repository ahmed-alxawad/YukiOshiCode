import { expect, test } from "bun:test"
import path from "path"

const promptDir = path.resolve(import.meta.dir, "../../src/session/prompt")
const identityPrompts = [
  "anthropic.txt",
  "beast.txt",
  "codex.txt",
  "copilot-gpt-5.txt",
  "default.txt",
  "gemini.txt",
  "gpt-astra.txt",
  "gpt.txt",
  "kimi.txt",
  "meta.txt",
  "trinity.txt",
]

test("provider system prompts identify the running agent as YukiOshi", async () => {
  for (const name of identityPrompts) {
    const prompt = await Bun.file(path.join(promptDir, name)).text()
    expect(prompt).toContain("YukiOshi")
    expect(prompt).not.toMatch(/\bopencode\b(?!-foundation)/i)
  }
})
