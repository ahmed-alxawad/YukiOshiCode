import { describe, expect, test } from "bun:test"
import { lazyCommand } from "../src/cli/lazy-command"

describe("lazyCommand", () => {
  test("loads only the selected command and reuses its module", async () => {
    let loads = 0
    let received: unknown
    const command = lazyCommand({
      command: "run",
      load: async () => {
        loads++
        return {
          command: "run",
          builder: (args: any) => args.option("name", { type: "string" }),
          handler: (args: any) => {
            received = args.name
          },
        }
      },
    })

    expect(loads).toBe(0)

    const argv = { option: () => argv } as never
    if (typeof command.builder === "function") await command.builder(argv)
    await command.handler?.({ name: "yuki" } as never)
    expect(loads).toBe(1)
    expect(received).toBe("yuki")
  })
})
