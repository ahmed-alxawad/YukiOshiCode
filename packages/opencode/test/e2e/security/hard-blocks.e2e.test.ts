// Scenarios 5 and 6: hard safety blocks hold even with every permission granted, including wrapped
// variants and secret paths in other letter case, and a permission pattern cannot be used for ReDoS.
// Dangerous binaries are replaced by recording stubs first on PATH, so a regression cannot do damage.
import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"
import { cliIt } from "../../lib/cli-process"
import { reply } from "../../lib/llm-server"
import { requestText } from "../helpers"
import { exists, makeProject, plainEnv, userConfig } from "./util"

function stubs(home: string) {
  const bin = path.join(home, "stub-bin")
  const log = path.join(home, "stub-calls.log")
  fs.mkdirSync(bin)
  const realGit = Bun.which("git") ?? "/usr/bin/git"
  const script = (name: string, body: string) => {
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  }
  script("rm", `echo "rm $*" >> "${log}"; exit 0`)
  script("git", `if [ "$1" = push ] || [ "$1" = branch ]; then echo "git $*" >> "${log}"; exit 0; fi\nexec "${realGit}" "$@"`)
  const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : [])
  return { bin, calls, env: { PATH: `${bin}:${process.env.PATH}` } }
}

// TODO(security-owner): `git push origin :main` (deleting the remote main branch) is not hard-blocked today,
// only forced pushes and `git branch -D main` are; add it here once guards.ts covers it.
const bash = (command: string) => reply().tool("bash", { command, description: "run" })

describe("security: hard blocks and permission patterns", () => {
  cliIt.live(
    "rm -rf / and wrapped variants, and force pushes to a protected branch never run, even with every permission granted",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        // The recording rm/git stubs are POSIX `sh` scripts first on PATH; Windows resolves commands differently.
        if (process.platform === "win32") return
        const proj = makeProject(home)
        const stub = stubs(home)
        const env = plainEnv(home, llm.url)
        const hostile = [
          "rm -rf /",
          "FOO=1 rm -rf /",
          "env rm -rf /",
          "nohup rm -rf / ",
          'bash -c "rm -rf /"',
          "sh -c 'rm -rf /*'",
          "sudo rm -rf /",
          "echo hi && rm -rf ~",
          "git push -f origin main",
          "git push --force origin main",
          "git push origin +main",
        ]
        yield* llm.push(...hostile.map(bash), reply().text("done").stop())
        const blocked = yield* opencode.run("run the hostile commands", {
          cwd: proj,
          env: { ...env, ...stub.env },
          extraArgs: ["--dangerously-skip-permissions"],
          timeoutMs: 90_000,
        })
        expect(blocked.exitCode).toBe(0)
        expect(stub.calls()).toEqual([])

        // Positive control: harmless variants of the same programs do run.
        yield* llm.reset
        yield* llm.push(
          bash("rm -rf ./scratch"),
          bash("env rm -rf ./scratch2"),
          bash("git push origin feature-branch"),
          reply().text("done").stop(),
        )
        const fine = yield* opencode.run("run the harmless commands", {
          cwd: proj,
          env: { ...env, ...stub.env },
          extraArgs: ["--dangerously-skip-permissions"],
          timeoutMs: 90_000,
        })
        expect(fine.exitCode).toBe(0)
        expect(stub.calls()).toEqual(["rm -rf ./scratch", "rm -rf ./scratch2", "git push origin feature-branch"])
      }),
    240_000,
  )

  cliIt.live(
    "secret files are refused whatever the letter case of the path; ordinary files are read",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const proj = makeProject(home)
        const secrets: Array<[string, string]> = [
          [".SSH/ID_RSA", "UPPERCASE-SSH-KEY-SECREG"],
          [".Ssh/id_rsa", "MIXEDCASE-SSH-KEY-SECREG"],
          [".ENV", "UPPERCASE-ENV-FILE-SECREG"],
          [".Aws/Credentials", "MIXEDCASE-AWS-FILE-SECREG"],
          ["server.PEM", "UPPERCASE-PEM-FILE-SECREG"],
          [".git/config", "GIT-CONFIG-FILE-SECREG"],
        ]
        for (const [file, content] of secrets) {
          fs.mkdirSync(path.dirname(path.join(proj, file)), { recursive: true })
          fs.writeFileSync(path.join(proj, file), content)
        }
        fs.writeFileSync(path.join(proj, "README.txt"), "ORDINARY-README-SECREG")
        const env = plainEnv(home, llm.url)
        yield* llm.push(
          ...secrets.map(([file]) => reply().tool("read", { filePath: path.join(proj, file) })),
          reply().tool("read", { filePath: path.join(proj, "README.txt") }),
          reply().text("done").stop(),
        )
        const result = yield* opencode.run("read everything", { cwd: proj, env, extraArgs: ["--dangerously-skip-permissions"] })
        expect(result.exitCode).toBe(0)
        const inputs = yield* llm.inputs
        const text = JSON.stringify(inputs)
        for (const [, content] of secrets) expect(text).not.toContain(content)
        expect(requestText(inputs.at(-1)!)).toContain("ORDINARY-README-SECREG")
      }),
    240_000,
  )

  cliIt.live(
    "a catastrophic permission pattern against a 5000-character command finishes fast and still matches",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const proj = makeProject(home)
        userConfig(home, { permission: { bash: { "*a*a*a*b": "deny" } } })
        const env = plainEnv(home, llm.url)
        const filler = "a".repeat(5000)
        yield* llm.push(
          bash(`touch ${path.join(proj, "ran-long")} ${filler}`),
          bash(`touch ${path.join(proj, "ran-denied")} ${filler}b`),
          reply().text("done").stop(),
        )
        const result = yield* opencode.run("run long commands", { cwd: proj, env, extraArgs: ["--dangerously-skip-permissions"], timeoutMs: 90_000 })
        expect(result.exitCode).toBe(0)
        expect(exists(proj, "ran-long")).toBe(true)
        // The pattern still applies: a command that matches it is denied.
        expect(exists(proj, "ran-denied")).toBe(false)
        // A 5000-character match must not be the dominant cost of the run.
        expect(result.durationMs).toBeLessThan(60_000)
      }),
    240_000,
  )
})
