import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Global } from "@yukioshi/core/global"

describe("global paths", () => {
  test("tmp path is under the system temp directory", () => {
    expect(Global.Path.tmp).toBe(path.join(os.tmpdir(), "yukioshi"))
    expect(Global.make().tmp).toBe(Global.Path.tmp)
  })

  test.skipIf(process.platform === "win32")("data dir holding credentials and sessions is owner-only", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "yk-global-"))
    try {
      // Fresh directory (created) and pre-existing 0755 directory (tightened).
      await fs.mkdir(path.join(home, "existing", "yukioshi"), { recursive: true, mode: 0o755 })
      await fs.chmod(path.join(home, "existing", "yukioshi"), 0o755)
      for (const name of ["fresh", "existing"]) {
        const proc = Bun.spawn(["bun", "-e", `await import(${JSON.stringify(path.resolve(import.meta.dir, "../src/global.ts"))})`], {
          env: { ...process.env, XDG_DATA_HOME: path.join(home, name) },
          stdout: "ignore",
          stderr: "pipe",
        })
        expect(await proc.exited).toBe(0)
        expect((await fs.stat(path.join(home, name, "yukioshi"))).mode & 0o077).toBe(0)
      }
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })

  test("tmp path is created on module load", async () => {
    expect((await fs.stat(Global.Path.tmp)).isDirectory()).toBe(true)
  })
})
