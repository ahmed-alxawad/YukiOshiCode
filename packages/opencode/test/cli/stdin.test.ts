import { describe, expect, test } from "bun:test"
import path from "path"

const helper = path.join(import.meta.dir, "../../src/cli/stdin.ts")

// Runs readPipedInput in a child process whose stdin we control, and returns what it printed.
async function readInChild(hasMessage: boolean, write?: string) {
  const proc = Bun.spawn(
    [
      process.execPath,
      "-e",
      `const { readPipedInput } = await import(${JSON.stringify(helper)});
       const result = await readPipedInput(${hasMessage}, 300);
       console.log(JSON.stringify(result ?? null));
       process.exit(0)`,
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  )
  if (write !== undefined) {
    proc.stdin.write(write)
    await proc.stdin.end()
  }
  // Leave the pipe open and idle otherwise, like a parent process that never writes to it.
  const exited = await Promise.race([proc.exited, Bun.sleep(5000).then(() => "still waiting" as const)])
  if (exited === "still waiting") proc.kill()
  return { exited, stdout: (await new Response(proc.stdout).text()).trim(), stderr: await new Response(proc.stderr).text() }
}

describe("readPipedInput", () => {
  test("does not wait forever on an idle stdin pipe when a message is given", async () => {
    const result = await readInChild(true)
    expect(result.exited).toBe(0)
    expect(result.stdout).toBe("null")
    expect(result.stderr).toContain("No input arrived on stdin")
  })

  test("adds piped text when it arrives", async () => {
    const result = await readInChild(true, "extra context\n")
    expect(result.stdout).toBe(JSON.stringify("extra context\n"))
  })

  test("reads stdin to the end when there is no message", async () => {
    const result = await readInChild(false, "the whole message")
    expect(result.stdout).toBe(JSON.stringify("the whole message"))
  })
})
