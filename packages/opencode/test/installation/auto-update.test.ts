import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { createHash, generateKeyPairSync, sign } from "crypto"
import { spawnSync } from "child_process"
import { Global } from "@yukioshi/core/global"
import { Flock } from "@yukioshi/core/util/flock"
import { AutoUpdate } from "../../src/installation/auto-update"
import { backgroundUpdate } from "../../src/cli/upgrade"
import { tmpdir } from "../fixture/fixture"

const DAY = 24 * 60 * 60 * 1000

describe("automatic update rules", () => {
  const base = { autoupdate: undefined, disabledByEnv: false, ci: false, current: "0.4.1" } as const

  test("a release build with default settings may check", () => {
    expect(AutoUpdate.blocked(base)).toBeUndefined()
  })

  test('"autoupdate": false turns the check off', () => {
    expect(AutoUpdate.blocked({ ...base, autoupdate: false })).toContain("autoupdate")
  })

  test("YUKIOSHI_DISABLE_AUTOUPDATE turns the check off", () => {
    expect(AutoUpdate.blocked({ ...base, disabledByEnv: true })).toContain("YUKIOSHI_DISABLE_AUTOUPDATE")
  })

  test("CI turns the check off", () => {
    expect(AutoUpdate.blocked({ ...base, ci: true })).toContain("CI")
    expect(AutoUpdate.isCI({ CI: "true" })).toBe(true)
    expect(AutoUpdate.isCI({ CI: "1" })).toBe(true)
    expect(AutoUpdate.isCI({})).toBe(false)
    expect(AutoUpdate.isCI({ CI: "false" })).toBe(false)
  })

  test("a development build never checks", () => {
    expect(AutoUpdate.blocked({ ...base, current: "local" })).toContain("not a release")
  })

  test("checks at most once a day", () => {
    const now = 1_000 * DAY
    expect(AutoUpdate.isDue({}, now)).toBe(true)
    expect(AutoUpdate.isDue({ checkedAt: now - DAY + 60_000 }, now)).toBe(false)
    expect(AutoUpdate.isDue({ checkedAt: now - DAY }, now)).toBe(true)
    expect(AutoUpdate.isDue({ checkedAt: now + 60_000 }, now)).toBe(true)
  })

  const curl = { current: "0.4.1", autoupdate: undefined, method: "curl", writable: true } as const

  test("installs newer minor and patch versions of a curl install", () => {
    expect(AutoUpdate.decide({ ...curl, latest: "0.5.0" })).toEqual({ action: "install", version: "0.5.0" })
    expect(AutoUpdate.decide({ ...curl, latest: "0.4.2" })).toEqual({ action: "install", version: "0.4.2" })
    expect(AutoUpdate.decide({ ...curl, autoupdate: true, latest: "0.4.2" }).action).toBe("install")
  })

  test("does nothing when already on the latest version", () => {
    expect(AutoUpdate.decide({ ...curl, latest: "0.4.1" }).action).toBe("none")
    expect(AutoUpdate.decide({ ...curl, latest: "0.4.0" }).action).toBe("none")
  })

  test("a major version only notifies", () => {
    expect(AutoUpdate.decide({ ...curl, current: "1.2.3", latest: "2.0.0" })).toEqual({
      action: "notify",
      version: "2.0.0",
      reason: "major",
    })
  })

  test('"autoupdate": "notify" only notifies', () => {
    expect(AutoUpdate.decide({ ...curl, autoupdate: "notify", latest: "0.5.0" })).toMatchObject({
      action: "notify",
      reason: "notify",
    })
  })

  test("package managers and unknown installs only notify, with the right command", () => {
    expect(AutoUpdate.decide({ ...curl, method: "npm", latest: "0.5.0" })).toMatchObject({
      action: "notify",
      reason: "package-manager",
    })
    expect(AutoUpdate.decide({ ...curl, method: "brew", latest: "0.5.0" }).action).toBe("notify")
    expect(AutoUpdate.decide({ ...curl, method: "unknown", latest: "0.5.0" })).toMatchObject({
      action: "notify",
      reason: "unknown-method",
    })
    expect(AutoUpdate.upgradeCommand("npm", "0.5.0")).toBe("npm install -g yukioshi-ai@0.5.0")
    expect(AutoUpdate.upgradeCommand("brew", "0.5.0")).toBe("brew upgrade yukioshi")
    expect(AutoUpdate.upgradeCommand("curl", "0.5.0")).toBe("yukioshi upgrade")
    expect(AutoUpdate.upgradeCommand("unknown", "0.5.0", "linux")).toContain("/install | bash")
    expect(AutoUpdate.upgradeCommand("unknown", "0.5.0", "win32")).toContain("install.ps1 | iex")
  })

  test("a binary that cannot be replaced only notifies", () => {
    expect(AutoUpdate.decide({ ...curl, writable: false, latest: "0.5.0" })).toMatchObject({
      action: "notify",
      reason: "not-writable",
    })
  })

  test.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "detects a binary it cannot replace",
    async () => {
      await using tmp = await tmpdir()
      const bin = path.join(tmp.path, "yukioshi")
      fs.writeFileSync(bin, "x")
      expect(AutoUpdate.canReplace(bin)).toBe(true)
      fs.chmodSync(tmp.path, 0o555)
      try {
        expect(AutoUpdate.canReplace(bin)).toBe(false)
      } finally {
        fs.chmodSync(tmp.path, 0o755)
      }
    },
  )

  test("only a compiled binary starts the background check", () => {
    expect(AutoUpdate.isCompiledBinary("/$bunfs/root/yukioshi")).toBe(true)
    expect(AutoUpdate.isCompiledBinary("B:/~BUN/root/yukioshi.exe")).toBe(true)
    expect(AutoUpdate.isCompiledBinary("/home/me/YukiOshiCode/packages/opencode/src/index.ts")).toBe(false)
    expect(AutoUpdate.isCompiledBinary()).toBe(false)
  })

  test("release archive names match the install script", () => {
    expect(AutoUpdate.assetName({ platform: "linux", arch: "x64", musl: false, baseline: false })).toBe(
      "yukioshi-linux-x64.tar.gz",
    )
    expect(AutoUpdate.assetName({ platform: "linux", arch: "x64", musl: true, baseline: true })).toBe(
      "yukioshi-linux-x64-baseline-musl.tar.gz",
    )
    expect(AutoUpdate.assetName({ platform: "darwin", arch: "arm64", musl: false, baseline: false })).toBe(
      "yukioshi-darwin-arm64.zip",
    )
    expect(AutoUpdate.assetName({ platform: "win32", arch: "x64", musl: false, baseline: false })).toBe(
      "yukioshi-windows-x64.zip",
    )
    expect(AutoUpdate.assetName({ platform: "freebsd", arch: "x64", musl: false, baseline: false })).toBeUndefined()
  })

  test("notices say which version was installed", () => {
    const installed = { kind: "installed", version: "0.5.0", from: "0.4.1", at: 0 } as const
    expect(AutoUpdate.noticeText(installed, "0.4.1")).toContain("v0.5.0 was installed in the background")
    expect(AutoUpdate.noticeText(installed, "0.5.0")).toContain("updated to v0.5.0")
    const warned = { ...installed, warning: "SHA256SUMS.sig is not published yet" } as const
    expect(AutoUpdate.noticeText(warned, "0.4.1")).toContain(
      "v0.5.0 was installed in the background (SHA256SUMS.sig is not published yet); it will be used",
    )
    expect(AutoUpdate.noticeText(warned, "0.5.0")).toBe(
      "YukiOshi was updated to v0.5.0 automatically (SHA256SUMS.sig is not published yet).",
    )
    const failed = { kind: "failed", version: "0.5.0", from: "0.4.1", reason: "boom", at: 0 } as const
    expect(AutoUpdate.noticeText(failed, "0.4.1")).toContain("failed (boom); still using v0.4.1")
  })

  test("an outcome is shown only once", async () => {
    await using tmp = await tmpdir()
    AutoUpdate.writeState(tmp.path, {
      checkedAt: 1,
      outcome: { kind: "installed", version: "0.5.0", from: "0.4.1", at: 1 },
    })
    expect(AutoUpdate.takeNotice(tmp.path)?.version).toBe("0.5.0")
    expect(AutoUpdate.takeNotice(tmp.path)).toBeUndefined()
    expect(AutoUpdate.readState(tmp.path).checkedAt).toBe(1)
  })

  test("a damaged state file cannot stop checks or garble notices", async () => {
    await using tmp = await tmpdir()
    const file = AutoUpdate.statePath(tmp.path)
    const read = (value: unknown) => {
      fs.writeFileSync(file, JSON.stringify(value))
      return AutoUpdate.readState(tmp.path)
    }
    expect(AutoUpdate.isDue(read({ checkedAt: "abc" }))).toBe(true)
    expect(AutoUpdate.isDue(read({ checkedAt: {} }))).toBe(true)
    expect(read([1, 2])).toEqual({})
    expect(read({ outcome: "x" }).outcome).toBeUndefined()
    expect(read({ outcome: { kind: "installed" } }).outcome).toBeUndefined()
    const good = { kind: "installed", version: "0.5.0", from: "0.4.1", at: 1 } as const
    expect(read({ checkedAt: 5, latest: "0.5.0", outcome: good })).toEqual({ checkedAt: 5, latest: "0.5.0", outcome: good })
    const withWarn = { ...good, warning: "unsigned release" } as const
    expect(read({ outcome: withWarn }).outcome).toEqual(withWarn)
    expect(read({ outcome: { ...good, warning: 123 } }).outcome).toEqual(good)
  })

  test("SHA256SUMS lines are matched by exact file name", () => {
    const sum = "a".repeat(64)
    const sums = `${"b".repeat(64)}  yukioshi-linux-x64-musl.tar.gz\n${sum} *yukioshi-linux-x64.tar.gz\n`
    expect(AutoUpdate.checksumFor(sums, "yukioshi-linux-x64.tar.gz")).toBe(sum)
    expect(AutoUpdate.checksumFor(sums, "yukioshi-linux-arm64.tar.gz")).toBeUndefined()
  })
})

// A fake GitHub release server: /releases.atom names the latest version and
// /releases/download/v<version>/<file> serves the archives and SHA256SUMS.
type Release = { version: string; script?: string; sums?: "ok" | "missing" | "wrong" | "unlisted" | "huge"; sig?: "valid" | "tampered" | "other-key" | "raw" }

const testKey = generateKeyPairSync("ed25519")
const otherKey = generateKeyPairSync("ed25519")
const spki = (k: typeof testKey) => k.publicKey.export({ type: "spki", format: "der" }).toString("base64")

function archive(dir: string, script: string) {
  const stage = fs.mkdtempSync(path.join(dir, "stage-"))
  fs.writeFileSync(path.join(stage, "yukioshi"), script, { mode: 0o755 })
  const out = path.join(stage, "release.tar.gz")
  const tar = spawnSync("tar", ["-czf", out, "-C", stage, "yukioshi"])
  if (tar.status !== 0) throw new Error(String(tar.stderr))
  return fs.readFileSync(out)
}

function fakeRelease(dir: string, asset: string, release: Release) {
  const requests: string[] = []
  const body = archive(dir, release.script ?? `#!/bin/sh\necho ${release.version}\n`)
  const hash = createHash("sha256").update(body).digest("hex")
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      requests.push(url.pathname)
      if (url.pathname === "/releases.atom")
        return new Response(
          `<feed><entry><link href="https://github.com/x/y/releases/tag/v${release.version}"/></entry></feed>`,
        )
      const prefix = `/releases/download/v${release.version}/`
      if (url.pathname === prefix + asset) return new Response(body)
      if (url.pathname === prefix + "SHA256SUMS.sig") {
        if (!release.sig) return new Response("not found", { status: 404 })
        const signed = Buffer.from(`${hash}  ${asset}\n`)
        const data = release.sig === "tampered" ? Buffer.from(`${hash}  ${asset}\n# x\n`) : signed
        const raw = sign(null, data, (release.sig === "other-key" ? otherKey : testKey).privateKey)
        return new Response(release.sig === "raw" ? raw : raw.toString("base64"))
      }
      if (url.pathname === prefix + "SHA256SUMS") {
        if (release.sums === "missing") return new Response("not found", { status: 404 })
        if (release.sums === "huge") return new Response(new Uint8Array(2 * 1024 * 1024).fill(97))
        if (release.sums === "unlisted") return new Response(`${hash}  yukioshi-other.tar.gz\n`)
        return new Response(`${release.sums === "wrong" ? "0".repeat(64) : hash}  ${asset}\n`)
      }
      return new Response("not found", { status: 404 })
    },
  })
  return { server, requests, url: server.url.toString().replace(/\/$/, "") }
}

const unix = process.platform !== "win32"

describe.skipIf(!unix)("installRelease", () => {
  const asset = "yukioshi-linux-x64.tar.gz"

  async function setup(release: Release, signing?: { key?: string; requiredFrom?: string }, warn?: (m: string) => void) {
    const tmp = await tmpdir()
    const binDir = path.join(tmp.path, "bin")
    fs.mkdirSync(binDir)
    const execPath = path.join(binDir, "yukioshi")
    fs.writeFileSync(execPath, "#!/bin/sh\necho 0.4.1\n", { mode: 0o755 })
    const fake = fakeRelease(tmp.path, asset, release)
    const install = () =>
      AutoUpdate.installRelease({
        version: release.version,
        asset,
        execPath,
        workDir: path.join(tmp.path, "work"),
        baseUrl: fake.url,
        signing,
        warn,
      })
    return {
      tmp,
      binDir,
      execPath,
      install,
      version: () => spawnSync(execPath, ["--version"], { encoding: "utf8" }).stdout.trim(),
      [Symbol.asyncDispose]: async () => {
        void fake.server.stop(true)
        await tmp[Symbol.asyncDispose]()
      },
    }
  }

  test("installs a verified release and keeps the old binary as a backup", async () => {
    await using env = await setup({ version: "0.5.0" })
    await env.install()
    expect(env.version()).toBe("0.5.0")
    expect(fs.readFileSync(env.execPath + ".old", "utf8")).toContain("echo 0.4.1")
    expect(fs.readdirSync(env.binDir).sort()).toEqual(["yukioshi", "yukioshi.old"])
  })

  test("refuses an archive that does not match SHA256SUMS", async () => {
    await using env = await setup({ version: "0.5.0", sums: "wrong" })
    await expect(env.install()).rejects.toThrow("does not match its SHA256SUMS checksum")
    expect(env.version()).toBe("0.4.1")
    expect(fs.readdirSync(env.binDir)).toEqual(["yukioshi"])
  })

  describe("SHA256SUMS signature", () => {
    const key = spki(testKey)
    test("accepts a valid signature (base64 and raw)", async () => {
      for (const sig of ["valid", "raw"] as const) {
        await using env = await setup({ version: "0.5.0", sig }, { key })
        await env.install()
        expect(env.version()).toBe("0.5.0")
      }
    })
    test("rejects a tampered SHA256SUMS", async () => {
      await using env = await setup({ version: "0.5.0", sig: "tampered" }, { key })
      await expect(env.install()).rejects.toThrow("signature of SHA256SUMS is not valid")
      expect(env.version()).toBe("0.4.1")
    })
    test("rejects a signature from another key", async () => {
      await using env = await setup({ version: "0.5.0", sig: "other-key" }, { key })
      await expect(env.install()).rejects.toThrow("signature of SHA256SUMS is not valid")
      expect(env.version()).toBe("0.4.1")
    })
    test("missing .sig is allowed with a warning below the cutoff, or with no cutoff", async () => {
      for (const requiredFrom of ["0.6.0", undefined]) {
        const warnings: string[] = []
        await using env = await setup({ version: "0.5.0" }, { key, requiredFrom }, (m) => warnings.push(m))
        await env.install()
        expect(env.version()).toBe("0.5.0")
        expect(warnings.length).toBe(1)
      }
    })
    test("missing .sig is refused from the cutoff on", async () => {
      await using env = await setup({ version: "0.5.0" }, { key, requiredFrom: "0.5.0" })
      await expect(env.install()).rejects.toThrow("must be signed")
      expect(env.version()).toBe("0.4.1")
    })
    test("no key configured leaves behaviour unchanged, even with a bad .sig", async () => {
      await using env = await setup({ version: "0.5.0", sig: "tampered" }, { key: "" })
      await env.install()
      expect(env.version()).toBe("0.5.0")
    })
  })

  test("refuses a release without SHA256SUMS", async () => {
    await using env = await setup({ version: "0.5.0", sums: "missing" })
    await expect(env.install()).rejects.toThrow("no SHA256SUMS")
    expect(env.version()).toBe("0.4.1")
  })

  test("refuses a SHA256SUMS larger than 1 MiB", async () => {
    await using env = await setup({ version: "0.5.0", sums: "huge" })
    await expect(env.install()).rejects.toThrow("SHA256SUMS is larger")
    expect(env.version()).toBe("0.4.1")
  })
  test("refuses an archive that SHA256SUMS does not list", async () => {
    await using env = await setup({ version: "0.5.0", sums: "unlisted" })
    await expect(env.install()).rejects.toThrow("is not listed")
    expect(env.version()).toBe("0.4.1")
  })

  test("keeps the current binary when the new one does not start", async () => {
    await using env = await setup({ version: "0.5.0", script: "#!/bin/sh\nexit 3\n" })
    await expect(env.install()).rejects.toThrow("failed its start check")
    expect(env.version()).toBe("0.4.1")
    expect(fs.readdirSync(env.binDir)).toEqual(["yukioshi"])
  })
})

describe.skipIf(!unix)("update safety", () => {
  const asset = "yukioshi-linux-x64.tar.gz"
  const good = (v: string) => `#!/bin/sh\necho ${v}\n`

  async function setup() {
    const tmp = await tmpdir()
    const binDir = path.join(tmp.path, "bin")
    fs.mkdirSync(binDir)
    const execPath = path.join(binDir, "yukioshi")
    fs.writeFileSync(execPath, good("0.4.1"), { mode: 0o755 })
    const servers: { stop: (force: boolean) => unknown }[] = []
    const install = async (version: string, script?: string) => {
      const fake = fakeRelease(tmp.path, asset, { version, script })
      servers.push(fake.server)
      await AutoUpdate.installRelease({
        version,
        asset,
        execPath,
        workDir: path.join(tmp.path, "work"),
        baseUrl: fake.url,
      })
    }
    return {
      tmp,
      binDir,
      execPath,
      install,
      [Symbol.asyncDispose]: async () => {
        for (const server of servers) void server.stop(true)
        await tmp[Symbol.asyncDispose]()
      },
    }
  }

  test("rejects a binary that prints its version but fails a real command", async () => {
    await using env = await setup()
    const script = `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.5.0; else echo boom >&2; exit 99; fi\n`
    await expect(env.install("0.5.0", script)).rejects.toThrow("failed a real command")
    expect(fs.readFileSync(env.execPath, "utf8")).toContain("echo 0.4.1")
  })

  test("a second install does not overwrite the backup with an unverified binary", async () => {
    await using env = await setup()
    await env.install("0.5.0")
    await env.install("0.6.0")
    expect(fs.readFileSync(env.execPath + ".old", "utf8")).toContain("echo 0.4.1")
    expect(fs.readFileSync(env.execPath, "utf8")).toContain("echo 0.6.0")
  })

  test("once the installed binary has run, the next install backs it up", async () => {
    await using env = await setup()
    await env.install("0.5.0")
    AutoUpdate.markVerified(path.join(env.tmp.path, "work"), env.execPath, "0.5.0")
    await env.install("0.6.0")
    expect(fs.readFileSync(env.execPath + ".old", "utf8")).toContain("echo 0.5.0")
  })

  test("sweeps staged binaries left by crashed updates", async () => {
    await using env = await setup()
    fs.writeFileSync(path.join(env.binDir, ".yukioshi.new.99999"), "stale")
    await env.install("0.5.0")
    expect(fs.readdirSync(env.binDir).sort()).toEqual(["yukioshi", "yukioshi.old"])
  })

  test("the test release URL is ignored outside tests unless the unsafe flag is set", () => {
    const url = "http://127.0.0.1:9"
    const write = process.stderr.write.bind(process.stderr)
    const logged: string[] = []
    process.stderr.write = ((chunk: string) => (logged.push(String(chunk)), true)) as typeof process.stderr.write
    try {
      expect(AutoUpdate.testReleaseBaseUrl({ YUKIOSHI_TEST_RELEASE_BASE_URL: url, NODE_ENV: "production" })).toBeUndefined()
      expect(AutoUpdate.testReleaseBaseUrl({ YUKIOSHI_TEST_RELEASE_BASE_URL: url, NODE_ENV: "test" })).toBe(url)
      expect(
        AutoUpdate.testReleaseBaseUrl({ YUKIOSHI_TEST_RELEASE_BASE_URL: url, YUKIOSHI_UNSAFE_DEV_RELEASE_URL: "1" }),
      ).toBe(url)
    } finally {
      process.stderr.write = write
    }
    expect(logged.join("")).toContain("ignoring YUKIOSHI_TEST_RELEASE_BASE_URL")
  })
})

describe.skipIf(!unix)("binary swap", () => {
  async function setup() {
    const tmp = await tmpdir()
    const execPath = path.join(tmp.path, "yukioshi")
    const staged = path.join(tmp.path, ".yukioshi.new")
    fs.writeFileSync(execPath, "#!/bin/sh\necho old\n", { mode: 0o755 })
    fs.writeFileSync(staged, "#!/bin/sh\necho new\n", { mode: 0o755 })
    const run = () => spawnSync(execPath, [], { encoding: "utf8" }).stdout.trim()
    return { tmp, execPath, staged, run, [Symbol.asyncDispose]: () => tmp[Symbol.asyncDispose]() }
  }
  const boom = () => Promise.reject(new Error("killed"))

  test("on Linux/macOS never moves the current binary away; the swap is one rename over it", async () => {
    await using env = await setup()
    const renames: string[] = []
    await AutoUpdate.swapBinary({
      execPath: env.execPath,
      staged: env.staged,
      windows: false,
      ops: { rename: async (a, b) => (renames.push(a), fs.renameSync(a, b)) },
    })
    expect(renames).toEqual([env.staged])
    expect(env.run()).toBe("new")
    expect(fs.readFileSync(env.execPath + ".old", "utf8")).toContain("echo old")
  })

  test("a failure at any step leaves a working binary", async () => {
    for (const step of ["rm", "link", "copyFile", "rename"] as const) {
      await using env = await setup()
      await AutoUpdate.swapBinary({
        execPath: env.execPath,
        staged: env.staged,
        windows: false,
        ops: { [step]: boom, ...(step === "link" ? { copyFile: boom } : {}) },
      }).catch(() => {})
      expect(["old", "new"]).toContain(env.run())
    }
  })

  test("Windows order restores the old binary when the new one cannot be put in place", async () => {
    await using env = await setup()
    let calls = 0
    await expect(
      AutoUpdate.swapBinary({
        execPath: env.execPath,
        staged: env.staged,
        windows: true,
        ops: { rename: async (a, b) => (++calls === 2 ? boom() : fs.renameSync(a, b)) },
      }),
    ).rejects.toThrow("could not put the new binary in place")
    expect(env.run()).toBe("old")
  })

  test("Windows: a restore that fails once is retried, so the old binary comes back", async () => {
    await using env = await setup()
    let calls = 0
    await expect(
      AutoUpdate.swapBinary({
        execPath: env.execPath,
        staged: env.staged,
        windows: true,
        ops: { rename: async (a, b) => (++calls === 2 || calls === 3 ? boom() : fs.renameSync(a, b)) },
      }),
    ).rejects.toThrow("could not put the new binary in place")
    expect(env.run()).toBe("old")
  })

  test("Windows: tells how to go back when even the restore fails", async () => {
    await using env = await setup()
    let calls = 0
    await expect(
      AutoUpdate.swapBinary({
        execPath: env.execPath,
        staged: env.staged,
        windows: true,
        ops: { rename: async (a, b) => (++calls === 1 ? fs.renameSync(a, b) : boom()) },
      }),
    ).rejects.toThrow(`to go back, rename ${env.execPath}.old to ${env.execPath}`)
  })

  test("Windows: a still-running .old that cannot be removed is skipped, not an error", async () => {
    await using env = await setup()
    fs.writeFileSync(env.execPath + ".old", "running")
    const busy = Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" })
    await AutoUpdate.swapBinary({
      execPath: env.execPath,
      staged: env.staged,
      windows: true,
      ops: { rm: () => Promise.reject(busy) },
    })
    expect(env.run()).toBe("new")
    expect(fs.readFileSync(env.execPath + ".old", "utf8")).toBe("running")
    expect(fs.readFileSync(`${env.execPath}.old.${process.pid}`, "utf8")).toContain("echo old")
    const eperm = Object.assign(new Error("EPERM"), { code: "EPERM" })
    await AutoUpdate.cleanStaleBackups(env.execPath, { rm: () => Promise.reject(eperm) })
    await AutoUpdate.cleanStaleBackups(env.execPath)
    expect(fs.existsSync(`${env.execPath}.old.${process.pid}`)).toBe(false)
  })

  test("an update download larger than the limit is aborted while streaming", async () => {
    await using env = await setup()
    let sent = 0
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname.endsWith("SHA256SUMS")) return new Response(`${"a".repeat(64)}  yukioshi-linux-x64.tar.gz\n`)
        if (url.pathname.endsWith(".sig")) return new Response("not found", { status: 404 })
        const chunk = new Uint8Array(64 * 1024)
        return new Response(
          new ReadableStream({
            async pull(controller) {
              await Bun.sleep(1)
              sent += chunk.length
              controller.enqueue(chunk)
            },
          }),
        )
      },
    })
    try {
      await expect(
        AutoUpdate.installRelease({
          version: "0.5.0",
          asset: "yukioshi-linux-x64.tar.gz",
          execPath: env.execPath,
          workDir: path.join(env.tmp.path, "work"),
          baseUrl: server.url.toString().replace(/\/$/, ""),
          maxBytes: 1024 * 1024,
        }),
      ).rejects.toThrow("refusing it")
      expect(sent).toBeLessThan(8 * 1024 * 1024)
      expect(AutoUpdate.downloadLimit()).toBe(1024 ** 3)
      expect(AutoUpdate.downloadLimit(100 * 1024 * 1024)).toBe(300 * 1024 * 1024)
    } finally {
      void server.stop(true)
    }
  })
})

describe.skipIf(!unix)("background update", () => {
  const stateDir = Global.Path.state
  const saved = { ...process.env }

  beforeEach(() => {
    fs.rmSync(AutoUpdate.statePath(stateDir), { force: true })
    delete process.env.CI
    delete process.env.YUKIOSHI_DISABLE_AUTOUPDATE
  })
  afterEach(() => {
    process.env = { ...saved }
  })

  async function setup(release: Release) {
    const tmp = await tmpdir()
    const execPath = path.join(tmp.path, "yukioshi")
    fs.writeFileSync(execPath, "#!/bin/sh\necho 0.4.1\n", { mode: 0o755 })
    const asset = AutoUpdate.detectAsset()!
    const fake = fakeRelease(tmp.path, asset, release)
    process.env.YUKIOSHI_TEST_RELEASE_BASE_URL = fake.url
    return {
      execPath,
      requests: fake.requests,
      run: () => backgroundUpdate({ execPath, current: "0.4.1", method: "curl" }),
      version: () => spawnSync(execPath, ["--version"], { encoding: "utf8" }).stdout.trim(),
      [Symbol.asyncDispose]: async () => {
        void fake.server.stop(true)
        await tmp[Symbol.asyncDispose]()
      },
    }
  }

  test("installs a newer minor version once a day and records it for the next start", async () => {
    await using env = await setup({ version: "0.5.0" })
    await env.run()
    expect(env.version()).toBe("0.5.0")
    const state = AutoUpdate.readState(stateDir)
    expect(state.outcome).toMatchObject({ kind: "installed", version: "0.5.0", from: "0.4.1" })
    expect(Date.now() - state.checkedAt!).toBeLessThan(60_000)

    const before = env.requests.length
    await env.run()
    expect(env.requests.length).toBe(before)
  })

  test("a failed update keeps the current binary and is reported once", async () => {
    await using env = await setup({ version: "0.5.0", sums: "wrong" })
    await env.run()
    expect(env.version()).toBe("0.4.1")
    const notice = AutoUpdate.takeNotice(stateDir)
    expect(notice).toMatchObject({ kind: "failed", version: "0.5.0" })
    expect(AutoUpdate.takeNotice(stateDir)).toBeUndefined()
  })

  test("a failed latest-version lookup retries in an hour, not in a day", async () => {
    await using env = await setup({ version: "0.5.0" })
    process.env.YUKIOSHI_TEST_RELEASE_BASE_URL = "http://127.0.0.1:1"
    await env.run()
    const state = AutoUpdate.readState(stateDir)
    expect(state.checkedAt).toBeDefined()
    expect(AutoUpdate.isDue(state, Date.now() + 5 * 60_000)).toBe(false)
    expect(AutoUpdate.isDue(state, Date.now() + AutoUpdate.RETRY_AFTER_FAILED_CHECK_MS + 60_000)).toBe(true)
  })

  test("a major version is recorded as available, not installed", async () => {
    await using env = await setup({ version: "1.0.0" })
    await env.run()
    expect(env.version()).toBe("0.4.1")
    expect(AutoUpdate.readState(stateDir).outcome).toMatchObject({ kind: "available", reason: "major" })
  })

  test("does nothing while another yukioshi process holds the update lock", async () => {
    await using env = await setup({ version: "0.5.0" })
    const lock = await Flock.acquire(AutoUpdate.LOCK_KEY, { timeoutMs: 0 })
    try {
      await env.run()
    } finally {
      await lock.release()
    }
    expect(env.requests).toEqual([])
    expect(env.version()).toBe("0.4.1")
  })

  test("does nothing in CI", async () => {
    await using env = await setup({ version: "0.5.0" })
    process.env.CI = "true"
    await env.run()
    delete process.env.CI
    expect(env.requests).toEqual([])
    expect(env.version()).toBe("0.4.1")
  })
})
