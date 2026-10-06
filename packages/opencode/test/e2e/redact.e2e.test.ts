import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { reply } from "../lib/llm-server"
import { cliIt } from "../lib/cli-process"
import { config, runtimeEnv } from "./helpers"

function read(filePath: string) {
  return reply().tool("read", { filePath })
}

describe("secret redaction", () => {
  cliIt.live(
    "masks fake github token when reading file so model receives redacted placeholder",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const tokenFile = path.join(home, "token.env")
        const fakeToken = "ghp_FakeTokenForE2ETest12345678901234"
        yield* Effect.promise(() => Bun.write(tokenFile, `GITHUB_TOKEN=${fakeToken}\n`))

        yield* llm.push(read(tokenFile))
        yield* llm.text("read completed")

        const result = yield* opencode.run("read the secret token file", {
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url) },
          extraArgs: ["--dangerously-skip-permissions"],
        })
        expect(result.exitCode).toBe(0)

        const inputs = yield* llm.inputs
        const allRequestsJson = JSON.stringify(inputs)
        expect(allRequestsJson).not.toContain(fakeToken)
        expect(allRequestsJson).toContain("[REDACTED:github-token]")
      }),
    60_000,
  )
})
