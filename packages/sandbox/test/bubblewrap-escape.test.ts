import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createServer, type Server } from "node:net"
import os from "node:os"
import path from "node:path"
import { backendSupport } from "../src/backend"
import { generate, hostSocketMasks } from "../src/bubblewrap"
import type { Profile } from "../src/profile"

const available = process.platform === "linux" && backendSupport({ mode: "deny", allowedHosts: [] }).available

let base = ""
let work = ""
let outside = ""
let server: Server | undefined
let socket = ""

function profile(mode: Profile["network"]["mode"]): Profile {
  return {
    filesystem: { allowWrite: [{ path: work, kind: "subtree" }], denyWrite: [], denyNames: [".git"] },
    network: { mode, allowedHosts: [] },
    environment: { deny: [], set: {} },
  }
}

function sh(script: string, mode: Profile["network"]["mode"] = "deny", environment: Record<string, string> = {}) {
  const launch = generate(
    profile(mode),
    { command: script, args: [], cwd: work, shell: "/bin/sh", environment: { PATH: process.env.PATH, ...environment } },
    "/usr/bin/bwrap",
  )
  return spawnSync(launch.command, [...launch.args], {
    encoding: "utf8",
    env: launch.environment as NodeJS.ProcessEnv,
    timeout: 20_000,
  })
}

beforeAll(async () => {
  base = realpathSync(mkdtempSync(path.join(os.tmpdir(), "yk-escape-")))
  work = path.join(base, "work")
  outside = path.join(base, "outside")
  mkdirSync(path.join(work, ".git", "hooks"), { recursive: true })
  mkdirSync(outside)
  writeFileSync(path.join(outside, "secret"), "secret")
  socket = path.join(outside, "agent.sock")
  server = createServer()
  await new Promise<void>((resolve) => server!.listen(socket, resolve))
})

afterAll(() => {
  server?.close()
  rmSync(base, { recursive: true, force: true })
})

describe.skipIf(!available)("bubblewrap escape attempts", () => {
  test("writes outside the workspace fail through every path spelling", () => {
    symlinkSync(outside, path.join(work, "link"))
    const result = sh(
      [
        `echo x > ${outside}/a`,
        `echo x > ../outside/b`,
        `echo x > /proc/self/root${outside}/c`,
        `echo x > link/d`,
        `ln ${outside}/secret ./hard`,
        `echo x > .git/hooks/pre-commit`,
        `echo x > .git/config`,
        `echo x > ./inside`,
      ].join("\n"),
    )
    expect(result.status).toBe(0)
    expect(readdirSync(outside).sort()).toEqual(["agent.sock", "secret"])
    expect(existsSync(path.join(work, "hard"))).toBe(false)
    expect(existsSync(path.join(work, ".git", "hooks", "pre-commit"))).toBe(false)
    expect(existsSync(path.join(work, ".git", "config"))).toBe(false)
    expect(existsSync(path.join(work, "inside"))).toBe(true)
  })

  test("a host agent socket named by SSH_AUTH_SOCK cannot be reached", () => {
    const result = sh(`if [ -S "$SSH_AUTH_SOCK" ]; then echo reachable; else echo hidden; fi`, "deny", {
      SSH_AUTH_SOCK: socket,
    })
    expect(result.stdout.trim()).toBe("hidden")
    expect(sh(`[ -S ${socket} ] && echo reachable || echo hidden`, "deny").stdout.trim()).toBe("reachable")
  })

  test.skipIf(!existsSync("/run"))("the host /run is hidden when the network is denied", () => {
    expect(sh(`ls -A /run | wc -l`).stdout.trim()).toBe("0")
  })

  test.skipIf(!existsSync("/run/user"))("host session sockets under /run/user are hidden when the network is allowed", () => {
    expect(sh(`ls -A /run/user | wc -l`, "allow").stdout.trim()).toBe("0")
  })
})

describe("host socket masks", () => {
  test("sockets and socket directories in /tmp are masked, writable roots are not", () => {
    const tmp = path.join(base, "faketmp")
    mkdirSync(path.join(tmp, "ssh-abc"), { recursive: true })
    mkdirSync(path.join(tmp, "tmux-1000"))
    mkdirSync(path.join(tmp, "yukioshi"))
    const masks = hostSocketMasks([{ path: path.join(tmp, "yukioshi"), kind: "subtree" }], "allow", {}, tmp)
    expect(masks.dirs).toContain(path.join(tmp, "ssh-abc"))
    expect(masks.dirs).toContain(path.join(tmp, "tmux-1000"))
    expect(masks.dirs).not.toContain(path.join(tmp, "yukioshi"))
  })

  test.skipIf(!existsSync("/run"))("a writable root under /run keeps /run from being hidden wholesale", () => {
    expect(hostSocketMasks([{ path: "/run/media", kind: "subtree" }], "deny").dirs).not.toContain("/run")
    expect(hostSocketMasks([{ path: work, kind: "subtree" }], "deny").dirs).toContain("/run")
  })
})
