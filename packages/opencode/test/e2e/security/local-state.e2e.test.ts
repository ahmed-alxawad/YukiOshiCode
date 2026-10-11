// Scenarios 10, 11, 12 and 13: the opencode-hosted provider refusal, owner-only data directories and
// files, scheduled-job injection into crontab, and credentials in the environment of a delegated agent.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"
import { reply } from "../../lib/llm-server"
import { requestToolResults, waitFor } from "../helpers"
import { makeProject, plainEnv, projectEnv, userConfig, walk } from "./util"

const DISABLED = "this provider is operated by opencode and is disabled in YukiOshi Code; use another provider"
const mode = (file: string) => fs.statSync(file).mode & 0o777
const posix = process.platform !== "win32"

describe("security: opencode-hosted providers", () => {
  cliIt.live(
    "a provider id or base URL operated by opencode is refused with the documented message and nothing is sent",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const proj = makeProject(home)
        const base = plainEnv(home, llm.url)
        const zen = (url: string) => ({
          provider: {
            zen: {
              name: "Zen",
              npm: "@ai-sdk/openai-compatible",
              options: { baseURL: url, apiKey: "k" },
              models: { m: { id: "m", name: "m" } },
            },
          },
        })
        const hosts = ["https://opencode.ai/zen/v1", "https://api.OPENCODE.AI./v1"]
        for (const url of hosts) {
          const env = { ...base, YUKIOSHI_CONFIG_CONTENT: JSON.stringify({ ...JSON.parse(base.YUKIOSHI_CONFIG_CONTENT), ...zen(url) , provider: { ...JSON.parse(base.YUKIOSHI_CONFIG_CONTENT).provider, ...zen(url).provider } }) }
          const result = yield* opencode.run("hello", { cwd: proj, env, model: "zen/m" })
          expect(result.exitCode).not.toBe(0)
          expect(result.stderr + result.stdout).toContain(DISABLED)
        }
        const byId = yield* opencode.run("hello", { cwd: proj, env: base, model: "opencode/big-pickle" })
        expect(byId.exitCode).not.toBe(0)
        expect(byId.stderr + byId.stdout).toContain(DISABLED)
        expect(yield* llm.calls).toBe(0)

        // Positive control: the configured test provider still answers.
        yield* llm.text("still works")
        const ok = yield* opencode.run("hello", { cwd: proj, env: base, timeoutMs: 120_000 })
        expect(ok.exitCode).toBe(0)
        expect(yield* llm.calls).toBeGreaterThan(0)
      }),
    300_000,
  )
})

describe("security: data directory permissions", () => {
  cliIt.live(
    "data, state and config directories are owner-only, even when they existed with wider modes; secrets files are 0600",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        if (!posix) return
        const proj = makeProject(home)
        // The directories already exist with the usual wide mode (an upgrade from an older version).
        for (const root of ["data", "state", "config"]) {
          const dir = `${home}-${root}/yukioshi`
          fs.mkdirSync(dir, { recursive: true, mode: 0o755 })
          fs.chmodSync(dir, 0o755)
        }
        userConfig(home, { audit: { enabled: true } })
        const env = plainEnv(home, llm.url)
        yield* llm.push(reply().tool("bash", { command: "echo hi", description: "say hi" }), reply().text("done").stop())
        const result = yield* opencode.run("hello", { cwd: proj, env, timeoutMs: 120_000 })
        expect(result.exitCode).toBe(0)
        const trust = yield* opencode.spawn(["trust", proj], { cwd: proj, env })
        expect(trust.exitCode).toBe(0)
        const added = yield* opencode.spawn(["schedule", "add", "*/5 * * * *", "do it", "--name", "perm", "--dir", proj], {
          cwd: proj,
          timeoutMs: 120_000,
          env: { ...env, YUKIOSHI_CRONTAB: path.join(home, "fake-crontab") },
        })
        expect(added.exitCode).toBe(0)

        for (const root of ["data", "state", "config"]) expect(mode(`${home}-${root}/yukioshi`).toString(8)).toBe("700")
        const state = `${home}-state/yukioshi`
        expect(mode(path.join(state, "project-trust.json")).toString(8)).toBe("600")
        expect(mode(path.join(state, "schedule", "jobs.json")).toString(8)).toBe("600")
        const audit = walk(path.join(state, "audit"))
        expect(audit.length).toBeGreaterThan(0)
        for (const file of audit) expect(mode(file).toString(8)).toBe("600")
        expect(mode(path.join(state, "audit")).toString(8)).toBe("700")
        // Nothing the CLI created below its owner-only directories is writable by others.
        for (const root of ["data", "state", "config"])
          for (const file of walk(`${home}-${root}/yukioshi`)) expect(mode(file) & 0o022).toBe(0)
      }),
    240_000,
  )
})

// A `crontab` first on PATH that keeps its table in a file and logs every call, so the real one is never touched.
function fakeCrontab(home: string) {
  const bin = path.join(home, "cron-bin")
  const table = path.join(home, "cron-table")
  const log = path.join(home, "cron-calls.log")
  fs.mkdirSync(bin)
  fs.writeFileSync(
    path.join(bin, "crontab"),
    `#!/bin/sh
echo "crontab $*" >> "${log}"
case "$1" in
  -l) if [ -f "${table}" ]; then cat "${table}"; else echo "no crontab for fake" >&2; exit 1; fi ;;
  -r) rm -f "${table}" ;;
  -) cat > "${table}" ;;
  *) exit 2 ;;
esac
`,
    { mode: 0o755 },
  )
  return {
    env: { PATH: `${bin}:${process.env.PATH}`, YUKIOSHI_CRONTAB: "" },
    table: () => (fs.existsSync(table) ? fs.readFileSync(table, "utf8") : ""),
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
  }
}

describe("security: schedule", () => {
  cliIt.live(
    "job ids and cron expressions with newlines or spaces cannot inject a crontab line",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        // macOS schedules through LaunchAgents and only falls back to cron, so the fake crontab is never used there.
        if (!posix || process.platform === "darwin") return
        const proj = makeProject(home)
        const pwn = path.join(home, "pwned")
        const cron = fakeCrontab(home)
        const env = { ...plainEnv(home, llm.url), ...cron.env }
        const schedule = (...args: string[]) => opencode.spawn(["schedule", ...args], { cwd: proj, env })

        // Positive control: a normal job lands in the table through the fake crontab.
        const added = yield* schedule("add", "*/5 * * * *", "summarize", "--name", "good", "--dir", proj)
        expect(added.exitCode).toBe(0)
        const goodID = (added.stdout + added.stderr).match(/Added scheduled job ([0-9a-f]{8})/)?.[1]
        expect(goodID).toBeDefined()
        expect(cron.table()).toContain(`schedule run ${goodID}`)
        expect(cron.calls().some((call) => call.startsWith("crontab -"))).toBe(true)

        // A cron expression with a newline is refused.
        const newlineCron = yield* schedule("add", `* * * * *\n* * * * * touch ${pwn}`, "x", "--name", "evil", "--dir", proj)
        expect(newlineCron.exitCode).not.toBe(0)
        expect(cron.table()).not.toContain(pwn)

        // A hand-edited job store with hostile ids must not reach the crontab when jobs are re-synced.
        const jobsFile = `${home}-state/yukioshi/schedule/jobs.json`
        const jobs = JSON.parse(fs.readFileSync(jobsFile, "utf8")) as Array<Record<string, unknown>>
        const template = jobs[0]!
        const hostile = ["abc\n* * * * * touch " + pwn, "abc def", "abc;touch " + pwn, "$(touch " + pwn + ")", "../../x"]
        fs.writeFileSync(
          jobsFile,
          JSON.stringify([...jobs, ...hostile.map((id) => ({ ...template, id, name: "hostile" }))]),
        )
        for (const args of [["disable", goodID!], ["enable", goodID!]]) {
          yield* schedule(...args)
        }
        const table = cron.table()
        expect(table).not.toContain(pwn)
        expect(table).not.toContain("abc")
        expect(table.split("\n").filter((line) => line.includes("schedule run"))).toHaveLength(1)

        // Running a hostile id, or reading its logs, is refused (`remove` only drops the store entry, which is
        // how a tampered store gets cleaned up).
        for (const id of hostile) {
          for (const sub of ["run", "logs"]) {
            const result = yield* schedule(sub, id)
            if (result.exitCode === 0) throw new Error(`schedule ${sub} ${JSON.stringify(id)} exited 0:\n${result.stdout}\n${result.stderr}`)
          }
        }
        expect(fs.existsSync(pwn)).toBe(false)
        expect(cron.table()).not.toContain(pwn)
      }),
    240_000,
  )
})

describe("security: delegated agent environment", () => {
  cliIt.live(
    "credential-like variables are not passed to a delegated agent; ordinary ones and the agent's own env are",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        if (!posix) return
        const proj = makeProject(home)
        const dump = path.join(home, "agent-env.txt")
        const mock = path.resolve(import.meta.dir, "../../delegate/mock-acp-agent.ts")
        userConfig(home, {
          delegate: {
            enabled: true,
            agents: {
              stub: {
                command: ["sh", "-c", `env > "${dump}"; exec "${process.execPath}" "${mock}" normal`],
                env: { AGENT_OWN_SETTING_TOKEN: "explicitly-passed" },
              },
            },
          },
        })
        const hostileEnv: Record<string, string> = {
          OPENAI_API_KEY: "sk-envvarsecreg0000000000000000000000000000",
          ANTHROPIC_API_KEY: "envsecret-anthropic",
          GITHUB_TOKEN: "ghp_FakeEnvTokenSecurityRegression1234567890",
          GH_TOKEN: "envsecret-gh",
          AWS_SECRET_ACCESS_KEY: "envsecret-aws",
          AWS_PROFILE: "envsecret-profile",
          MY_SERVICE_PASSWORD: "envsecret-password",
          NPM_TOKEN: "envsecret-npm",
          DATABASE_URL: "postgres://u:envsecret-db@h/db",
          SSH_AUTH_SOCK: "/tmp/envsecret-ssh.sock",
          INNOCENT_NAME_HOLDING_A_KEY: "AKIAIOSFODNN7EXAMPLE",
          YUKIOSHI_SERVER_PASSWORD: "envsecret-server",
          SECREG_HARMLESS_SETTING: "visible",
        }
        yield* llm.push(reply().tool("delegate", { agent: "stub", prompt: "list files" }), reply().text("done").stop())
        const result = yield* opencode.run("delegate something", {
          cwd: proj,
          env: { ...plainEnv(home, llm.url), ...hostileEnv },
          extraArgs: ["--dangerously-skip-permissions"],
        })
        expect(result.exitCode).toBe(0)
        yield* Effect.promise(() => waitFor(() => fs.existsSync(dump) && fs.statSync(dump).size > 0, "stub agent did not dump its env", 15_000))
        const seen = fs.readFileSync(dump, "utf8")
        for (const [name, value] of Object.entries(hostileEnv)) {
          if (name === "SECREG_HARMLESS_SETTING") continue
          expect(seen).not.toContain(`${name}=`)
          expect(seen).not.toContain(value)
        }
        // Positive control.
        expect(seen).toContain("SECREG_HARMLESS_SETTING=visible")
        expect(seen).toContain("AGENT_OWN_SETTING_TOKEN=explicitly-passed")
        expect(seen).toMatch(/^PATH=/m)
        expect(requestToolResults((yield* llm.inputs).at(-1)!).at(-1)).toBeDefined()
      }),
    240_000,
  )
})
