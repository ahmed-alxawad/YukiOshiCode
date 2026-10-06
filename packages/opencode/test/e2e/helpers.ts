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
