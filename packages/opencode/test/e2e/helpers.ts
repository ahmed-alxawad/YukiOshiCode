import { testProviderConfig } from "../lib/test-provider"

export function config(url: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ ...testProviderConfig(url), ...extra })
}

export function runtimeEnv(home: string) {
  return {
    XDG_CONFIG_HOME: `${home}-config`,
    XDG_DATA_HOME: `${home}-data`,
    XDG_STATE_HOME: `${home}-state`,
    XDG_CACHE_HOME: `${home}-cache`,
  }
}

export function globalConfig(home: string, extra: Record<string, unknown>) {
  const directory = `${home}-config/yukioshi`
  Bun.spawnSync(["mkdir", "-p", directory])
  Bun.write(`${directory}/yukioshi.json`, JSON.stringify(extra))
}

export function expectRun(output: { exitCode: number; stdout: string; stderr: string }, text: string) {
  if (output.exitCode !== 0) throw new Error(`CLI failed: ${output.stderr}`)
  if (!output.stdout.includes(text)) throw new Error(`Expected ${JSON.stringify(text)} in ${output.stdout}`)
}

export function requestToolNames(input: Record<string, unknown>) {
  if (!Array.isArray(input.tools)) return []
  return input.tools.flatMap((item) => {
    if (!item || typeof item !== "object") return []
    const tool = item as { name?: unknown; function?: { name?: unknown } }
    if (typeof tool.name === "string") return [tool.name]
    if (typeof tool.function?.name === "string") return [tool.function.name]
    return []
  })
}

export function requestText(input: Record<string, unknown>) {
  return JSON.stringify(input.messages ?? input.input ?? input)
}

export function requestToolResults(input: Record<string, unknown>) {
  if (!Array.isArray(input.messages)) return []
  return input.messages.flatMap((message) => {
    if (!message || typeof message !== "object") return []
    const item = message as { role?: unknown; content?: unknown }
    return item.role === "tool" && typeof item.content === "string" ? [item.content] : []
  })
}

export function occurrences(text: string, value: string) {
  return text.split(value).length - 1
}

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await condition()) return
    await Bun.sleep(20)
  }
  throw new Error(message)
}
