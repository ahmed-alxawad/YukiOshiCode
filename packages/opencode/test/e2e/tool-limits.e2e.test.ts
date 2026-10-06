import { describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import { reply } from "../lib/llm-server"
import { cliIt } from "../lib/cli-process"
import { config, requestToolResults, runtimeEnv } from "./helpers"

const marker = "[Repeated call]"

function read(filePath: string) {
  return reply().tool("read", { filePath })
}

describe("tool limits", () => {
  cliIt.live(
    "the third identical call carries a note and the fifth carries stronger wording",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const file = path.join(home, "repeat.txt")
        yield* Effect.promise(() => Bun.write(file, "same result\n"))
        yield* llm.push(read(file), read(file), read(file), read(file), read(file))
        yield* llm.text("finished")
        const result = yield* opencode.run("read it five times", {
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url) },
          extraArgs: ["--dangerously-skip-permissions"],
        })
        expect(result.exitCode).toBe(0)
        const outputs = requestToolResults((yield* llm.inputs).at(-1)!)
        expect(outputs).toHaveLength(5)
        expect(outputs[0]).not.toContain(marker)
        expect(outputs[1]).not.toContain(marker)
        expect(outputs[2]).toContain("3rd time this turn")
        expect(outputs[4]).toContain("Stop repeating this call")
      }),
    60_000,
  )

  cliIt.live(
    "the same input with a changed result gets no note",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const file = path.join(home, "changing.txt")
        yield* Effect.promise(() => Bun.write(file, "old value\n"))
        yield* llm.push(
          read(file),
          read(file),
          read(file),
          reply().tool("bash", { command: `printf 'new value\\n' > ${JSON.stringify(file)}`, description: "edit" }),
          read(file),
        )
        yield* llm.text("finished")
        const result = yield* opencode.run("read around an edit", {
          env: { ...runtimeEnv(home), YUKIOSHI_CONFIG_CONTENT: config(llm.url) },
          extraArgs: ["--dangerously-skip-permissions"],
        })
        expect(result.exitCode).toBe(0)
        const outputs = requestToolResults((yield* llm.inputs).at(-1)!)
        expect(outputs[2]).toContain("3rd time this turn")
        expect(outputs.at(-1)).toContain("new value")
        expect(outputs.at(-1)).not.toContain(marker)
      }),
    60_000,
  )

  cliIt.live(
    "repeat_nudge false adds no note",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        const file = path.join(home, "no-nudge.txt")
        yield* Effect.promise(() => Bun.write(file, "same\n"))
        yield* llm.push(read(file), read(file), read(file), read(file), read(file))
        yield* llm.text("finished")
        const result = yield* opencode.run("read without nudges", {
          env: {
            ...runtimeEnv(home),
            YUKIOSHI_CONFIG_CONTENT: config(llm.url, { tool_limits: { repeat_nudge: false } }),
          },
          extraArgs: ["--dangerously-skip-permissions"],
        })
        expect(result.exitCode).toBe(0)
        expect(requestToolResults((yield* llm.inputs).at(-1)!).join("\n")).not.toContain(marker)
      }),
    60_000,
  )

  cliIt.live(
    "tool_limits timeout stops webfetch to a slow server and the turn finishes",
    ({ home, llm, opencode }) =>
      Effect.gen(function* () {
        let requests = 0
        const slow = Bun.serve({
          port: 0,
          fetch: async () => {
            requests++
            await Bun.sleep(10_000)
            return new Response("late")
          },
        })
        yield* Effect.addFinalizer(() => Effect.sync(() => slow.stop(true)))
        yield* llm.push(reply().tool("webfetch", { url: slow.url.toString(), format: "text" }))
        yield* llm.text("continued after timeout")
        const result = yield* opencode.run("fetch the slow endpoint", {
          env: {
            ...runtimeEnv(home),
            YUKIOSHI_CONFIG_CONTENT: config(llm.url, { tool_limits: { timeout: { webfetch: 100 } } }),
          },
          extraArgs: ["--dangerously-skip-permissions"],
          timeoutMs: 20_000,
        })
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain("continued after timeout")
        expect(result.durationMs).toBeLessThan(10_000)
        expect(requests).toBe(1)
        expect(requestToolResults((yield* llm.inputs).at(-1)!).at(-1)).toContain("did not finish within 100 ms")
      }),
    60_000,
  )
})
