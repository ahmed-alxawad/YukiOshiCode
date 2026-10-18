import { describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { waitFor } from "./helpers"

const isLinux = process.platform === "linux"
const suite = isLinux ? describe : describe.skip

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

suite("Linux SIGKILL orphan cleanup watchdog", () => {
  test(
    "terminates child process when parent receives SIGKILL (kill -9)",
    async () => {
      const watchdogModule = path.resolve(__dirname, "../../src/util/watchdog.ts")

      // Parent process code that spawns a dummy child (sleep 60) via spawnWithWatchdog
      const parentCode = `
        import { spawnWithWatchdog } from ${JSON.stringify(watchdogModule)};
        const child = spawnWithWatchdog(["sleep", "60"]);
        console.log("PARENT:" + process.pid);
        console.log("CHILD:" + child.pid);
        console.log("WATCHDOG:" + child.watchdog?.pid);
        // Keep parent alive until killed
        setInterval(() => {}, 1000);
      `

      const parent = spawn(process.execPath, ["-e", parentCode], {
        stdio: ["ignore", "pipe", "pipe"],
      })

      let parentPid: number | undefined
      let childPid: number | undefined
      let watchdogPid: number | undefined

      parent.stdout?.on("data", (chunk: Buffer) => {
        const lines = chunk.toString().split("\n")
        for (const line of lines) {
          if (line.startsWith("PARENT:")) parentPid = Number(line.split(":")[1])
          if (line.startsWith("CHILD:")) childPid = Number(line.split(":")[1])
          if (line.startsWith("WATCHDOG:")) watchdogPid = Number(line.split(":")[1])
        }
      })
      parent.stderr?.on("data", (chunk: Buffer) => {
        console.error("parent stderr:", chunk.toString())
      })

      // Wait until child is running and confirmed alive
      await waitFor(() => Boolean(childPid && alive(childPid)), "child process to be running and alive", 5_000)

      expect(childPid).toBeDefined()
      expect(alive(childPid!)).toBe(true)
      expect(parentPid).toBeDefined()
      expect(alive(parentPid!)).toBe(true)

      // Send SIGKILL (kill -9) directly to the parent process
      // This abruptly terminates the parent without running exit handlers
      process.kill(parentPid!, "SIGKILL")

      // Verify parent is dead
      await waitFor(() => !alive(parentPid!), "parent process to be terminated", 2_000)

      // Verify child process is terminated within 1-2 seconds (does not orphan)
      const start = Date.now()
      await waitFor(() => !alive(childPid!), `child ${childPid} to be terminated by watchdog`, 2_000)
      const elapsed = Date.now() - start
      expect(elapsed).toBeLessThan(2_000)

      // Verify the watchdog helper itself terminated as well
      if (watchdogPid) {
        await waitFor(() => !alive(watchdogPid!), `watchdog ${watchdogPid} to exit`, 2_000)
      }
    },
    10_000,
  )

  test(
    "terminates child process group and grandchildren when parent receives SIGKILL",
    async () => {
      const watchdogModule = path.resolve(__dirname, "../../src/util/watchdog.ts")
      const tmpDir = path.join("/tmp", `sigkill-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      fs.mkdirSync(tmpDir, { recursive: true })
      const grandchildPidFile = path.join(tmpDir, "grandchild.pid")

      // Parent spawns a detached shell command that spawns a grandchild sleep process
      const parentCode = `
        import { spawnWithWatchdog } from ${JSON.stringify(watchdogModule)};
        const child = spawnWithWatchdog(
          ["sh", "-c", "sleep 60 & echo \\$! > ${grandchildPidFile}; wait"],
          { detached: true }
        );
        console.log("PARENT:" + process.pid);
        console.log("CHILD:" + child.pid);
        console.log("WATCHDOG:" + child.watchdog?.pid);
        setInterval(() => {}, 1000);
      `

      const parent = spawn(process.execPath, ["-e", parentCode], {
        stdio: ["ignore", "pipe", "pipe"],
      })

      let parentPid: number | undefined
      let childPid: number | undefined
      let watchdogPid: number | undefined

      parent.stdout?.on("data", (chunk: Buffer) => {
        const lines = chunk.toString().split("\n")
        for (const line of lines) {
          if (line.startsWith("PARENT:")) parentPid = Number(line.split(":")[1])
          if (line.startsWith("CHILD:")) childPid = Number(line.split(":")[1])
          if (line.startsWith("WATCHDOG:")) watchdogPid = Number(line.split(":")[1])
        }
      })
      parent.stderr?.on("data", (chunk: Buffer) => {
        console.error("parent stderr:", chunk.toString())
      })

      // Wait until child is running and grandchild PID file is written
      await waitFor(
        () =>
          Boolean(
            childPid &&
              alive(childPid) &&
              fs.existsSync(grandchildPidFile) &&
              fs.readFileSync(grandchildPidFile, "utf8").trim() !== "",
          ),
        "child and grandchild processes to be running",
        5_000,
      )

      const grandchildPid = Number(fs.readFileSync(grandchildPidFile, "utf8").trim())
      expect(alive(childPid!)).toBe(true)
      expect(alive(grandchildPid)).toBe(true)

      // Kill parent with SIGKILL
      process.kill(parentPid!, "SIGKILL")

      // Verify both child and grandchild are terminated within 1-2 seconds
      await waitFor(() => !alive(childPid!), `child ${childPid} to be terminated`, 2_000)
      await waitFor(() => !alive(grandchildPid), `grandchild ${grandchildPid} to be terminated`, 2_000)

      if (watchdogPid) {
        await waitFor(() => !alive(watchdogPid!), `watchdog ${watchdogPid} to exit`, 2_000)
      }

      fs.rmSync(tmpDir, { recursive: true, force: true })
    },
    10_000,
  )

  test(
    "cleans up watchdog cleanly when child process exits normally",
    async () => {
      const watchdogModule = path.resolve(__dirname, "../../src/util/watchdog.ts")

      const parentCode = `
        import { spawnWithWatchdog } from ${JSON.stringify(watchdogModule)};
        const child = spawnWithWatchdog(["sh", "-c", "exit 0"]);
        console.log("WATCHDOG:" + child.watchdog?.pid);
        await child.exited;
        console.log("CHILD_EXITED");
        // Keep parent alive briefly to verify watchdog cleanup
        setTimeout(() => {
          console.log("PARENT_DONE");
          process.exit(0);
        }, 1000);
      `

      const parent = spawn(process.execPath, ["-e", parentCode], {
        stdio: ["ignore", "pipe", "pipe"],
      })

      let watchdogPid: number | undefined
      let childExited = false

      parent.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString()
        for (const line of text.split("\n")) {
          if (line.startsWith("WATCHDOG:")) watchdogPid = Number(line.split(":")[1])
          if (line.includes("CHILD_EXITED")) childExited = true
        }
      })
      parent.stderr?.on("data", (chunk: Buffer) => {
        console.error("parent stderr:", chunk.toString())
      })

      await waitFor(() => childExited, "child to have exited", 5_000)

      // When child exits normally, watchdog should be terminated immediately by cleanup()
      if (watchdogPid) {
        await waitFor(() => !alive(watchdogPid!), `watchdog ${watchdogPid} to be cleaned up`, 2_000)
      }

      const exitCode = await new Promise<number>((resolve) => parent.once("exit", (code) => resolve(code ?? 0)))
      expect(exitCode).toBe(0)
    },
    10_000,
  )

  test(
    "terminates MCP-style spawned child attached via attachWatchdog(pid, { group: false }) when parent receives SIGKILL",
    async () => {
      const watchdogModule = path.resolve(__dirname, "../../src/util/watchdog.ts")

      // Simulates MCP stdio transport: spawns a child in same process group (detached: false),
      // extracts numeric pid, and attaches watchdog via attachWatchdog(pid, { group: false })
      const parentCode = `
        import { spawn } from "node:child_process";
        import { attachWatchdog } from ${JSON.stringify(watchdogModule)};
        const server = spawn("sleep", ["60"], { detached: false });
        const watchdog = attachWatchdog(server.pid, { group: false });
        console.log("PARENT:" + process.pid);
        console.log("SERVER_PID:" + server.pid);
        console.log("WATCHDOG_PID:" + watchdog.pid);
        setInterval(() => {}, 1000);
      `

      const parent = spawn(process.execPath, ["-e", parentCode], {
        stdio: ["ignore", "pipe", "pipe"],
      })

      let parentPid: number | undefined
      let serverPid: number | undefined
      let watchdogPid: number | undefined

      parent.stdout?.on("data", (chunk: Buffer) => {
        const lines = chunk.toString().split("\n")
        for (const line of lines) {
          if (line.startsWith("PARENT:")) parentPid = Number(line.split(":")[1])
          if (line.startsWith("SERVER_PID:")) serverPid = Number(line.split(":")[1])
          if (line.startsWith("WATCHDOG_PID:")) watchdogPid = Number(line.split(":")[1])
        }
      })
      parent.stderr?.on("data", (chunk: Buffer) => {
        console.error("parent stderr:", chunk.toString())
      })

      await waitFor(() => Boolean(serverPid && alive(serverPid)), "MCP server child to be running", 5_000)

      expect(serverPid).toBeDefined()
      expect(alive(serverPid!)).toBe(true)
      expect(parentPid).toBeDefined()
      expect(alive(parentPid!)).toBe(true)

      // Kill parent with SIGKILL
      process.kill(parentPid!, "SIGKILL")

      // Verify parent is dead
      await waitFor(() => !alive(parentPid!), "parent process to be terminated", 2_000)

      // Verify MCP-style server child is terminated by the watchdog within 1-2 seconds
      const start = Date.now()
      await waitFor(() => !alive(serverPid!), `MCP server ${serverPid} to be terminated by watchdog`, 2_000)
      const elapsed = Date.now() - start
      expect(elapsed).toBeLessThan(2_000)

      if (watchdogPid) {
        await waitFor(() => !alive(watchdogPid!), `watchdog ${watchdogPid} to exit`, 2_000)
      }
    },
    10_000,
  )

  test(
    "terminates process.ts spawnProcess child when parent receives SIGKILL",
    async () => {
      const processModule = path.resolve(__dirname, "../../src/util/process.ts")

      const parentCode = `
        import { spawnProcess } from ${JSON.stringify(processModule)};
        const child = spawnProcess(["sleep", "60"]);
        console.log("PARENT:" + process.pid);
        console.log("CHILD:" + child.pid);
        console.log("WATCHDOG:" + child.watchdog?.pid);
        setInterval(() => {}, 1000);
      `

      const parent = spawn(process.execPath, ["-e", parentCode], {
        stdio: ["ignore", "pipe", "pipe"],
      })

      let parentPid: number | undefined
      let childPid: number | undefined
      let watchdogPid: number | undefined

      parent.stdout?.on("data", (chunk: Buffer) => {
        const lines = chunk.toString().split("\n")
        for (const line of lines) {
          if (line.startsWith("PARENT:")) parentPid = Number(line.split(":")[1])
          if (line.startsWith("CHILD:")) childPid = Number(line.split(":")[1])
          if (line.startsWith("WATCHDOG:")) watchdogPid = Number(line.split(":")[1])
        }
      })
      parent.stderr?.on("data", (chunk: Buffer) => {
        console.error("parent stderr:", chunk.toString())
      })

      await waitFor(() => Boolean(childPid && alive(childPid)), "spawnProcess child to be running", 5_000)

      expect(childPid).toBeDefined()
      expect(alive(childPid!)).toBe(true)

      process.kill(parentPid!, "SIGKILL")

      await waitFor(() => !alive(parentPid!), "parent process to be terminated", 2_000)
      await waitFor(() => !alive(childPid!), `child ${childPid} to be terminated by watchdog`, 2_000)

      if (watchdogPid) {
        await waitFor(() => !alive(watchdogPid!), `watchdog ${watchdogPid} to exit`, 2_000)
      }
    },
    10_000,
  )
})
