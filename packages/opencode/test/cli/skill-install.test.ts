import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"
import zlib from "node:zlib"
import { cliIt } from "../lib/cli-process"

function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawnSync(
    ["git", "-c", "user.email=t@example.test", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  )
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`)
}

// Windows has no `zip`, `python3` or reliable symlink rights, so test archives are written in-process.
function tarGz(file: string, entries: { name: string; content?: string; link?: string }[]) {
  const blocks: Buffer[] = []
  for (const e of entries) {
    const body = Buffer.from(e.content ?? "")
    const h = Buffer.alloc(512)
    h.write(e.name, 0, 100)
    h.write("0000644\0", 100)
    h.write("0000000\0", 108)
    h.write("0000000\0", 116)
    h.write(body.length.toString(8).padStart(11, "0") + "\0", 124)
    h.write("00000000000\0", 136)
    h.fill(" ", 148, 156)
    h.write(e.link ? "2" : "0", 156)
    if (e.link) h.write(e.link, 157, 100)
    h.write("ustar\0" + "00", 257)
    const sum = h.reduce((a, b) => a + b, 0)
    h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148)
    blocks.push(h, body, Buffer.alloc((512 - (body.length % 512)) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  fs.writeFileSync(file, zlib.gzipSync(Buffer.concat(blocks)))
}

// Builds a local bare repository (no network) holding the given files and returns its path.
function bareRepo(root: string, name: string, files: Record<string, string>, links: Record<string, string> = {}) {
  const work = path.join(root, `${name}-work`)
  fs.mkdirSync(work, { recursive: true })
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true })
    fs.writeFileSync(path.join(work, file), content)
  }
  for (const [file, target] of Object.entries(links)) fs.symlinkSync(target, path.join(work, file))
  git(work, "init", "-q", "-b", "main")
  git(work, "add", "-A")
  git(work, "commit", "-q", "-m", "init")
  const bare = path.join(root, `${name}.git`)
  git(root, "clone", "-q", "--bare", work, bare)
  return bare
}

const skillMd = (name: string) => `---\nname: ${name}\ndescription: Test skill ${name}\n---\n\nDo the ${name} thing.\n`

describe("skill add/list/remove", () => {
  cliIt.live(
    "adds from a git repository, lists it with its source, shows it to the agent, and removes it",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const repo = bareRepo(home, "demo", {
          "skills/alpha/SKILL.md": skillMd("alpha-skill"),
          "skills/beta/SKILL.md": skillMd("beta-skill"),
          "README.md": "readme",
        })

        const added = yield* opencode.spawn(["skill", "add", repo, "--name", "demo"], { cwd: home })
        opencode.expectExit(added, 0, "skill add")
        expect(added.stderr + added.stdout).toContain("alpha-skill")
        expect(added.stderr + added.stdout).toContain("beta-skill")

        const listed = yield* opencode.spawn(["skill", "list"], { cwd: home })
        opencode.expectExit(listed, 0, "skill list")
        expect(listed.stderr + listed.stdout).toContain(repo)
        expect(listed.stderr + listed.stdout).toContain("demo")

        const visible = yield* opencode.spawn(["debug", "skill"], { cwd: home })
        opencode.expectExit(visible, 0, "debug skill")
        expect(visible.stdout).toContain("alpha-skill")
        expect(visible.stdout).toContain("beta-skill")

        // The .git folder is dropped: only the files are kept.
        expect(fs.existsSync(path.join(home, ".config/yukioshi/skills/demo/.git"))).toBe(false)

        const removed = yield* opencode.spawn(["skill", "remove", "demo"], { cwd: home })
        opencode.expectExit(removed, 0, "skill remove")
        expect(fs.existsSync(path.join(home, ".config/yukioshi/skills/demo"))).toBe(false)

        const after = yield* opencode.spawn(["debug", "skill"], { cwd: home })
        opencode.expectExit(after, 0, "debug skill")
        expect(after.stdout).not.toContain("alpha-skill")
      }),
    120_000,
  )

  cliIt.live(
    "refuses a repository without SKILL.md and installs nothing",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const repo = bareRepo(home, "empty", { "README.md": "no skills here" })
        const result = yield* opencode.spawn(["skill", "add", repo], { cwd: home })
        expect(result.exitCode).not.toBe(0)
        expect(result.stderr).toContain("no SKILL.md")
        expect(fs.existsSync(path.join(home, ".config/yukioshi/skills/empty"))).toBe(false)
      }),
    60_000,
  )

  cliIt.live(
    "removes symlinks from the clone and refuses option-like URLs and unmanaged folders",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const secret = path.join(home, "secret.txt")
        fs.writeFileSync(secret, "top secret")
        const repo = bareRepo(home, "linky", { "SKILL.md": skillMd("linky-skill") }, { "leak.md": secret })
        const added = yield* opencode.spawn(["skill", "add", repo, "--name", "linky"], { cwd: home })
        opencode.expectExit(added, 0, "skill add")
        const installed = path.join(home, ".config/yukioshi/skills/linky")
        expect(fs.existsSync(path.join(installed, "SKILL.md"))).toBe(true)
        expect(fs.existsSync(path.join(installed, "leak.md"))).toBe(false)

        const option = yield* opencode.spawn(["skill", "add", "--name", "x", "--", "--upload-pack=touch /tmp/pwned"], {
          cwd: home,
        })
        expect(option.exitCode).not.toBe(0)

        // A folder the user wrote by hand has no install marker and is never removed.
        const manual = path.join(home, ".config/yukioshi/skills/mine")
        fs.mkdirSync(manual, { recursive: true })
        fs.writeFileSync(path.join(manual, "SKILL.md"), skillMd("mine"))
        const refused = yield* opencode.spawn(["skill", "remove", "mine"], { cwd: home })
        expect(refused.exitCode).not.toBe(0)
        expect(fs.existsSync(path.join(manual, "SKILL.md"))).toBe(true)

        const traversal = yield* opencode.spawn(["skill", "remove", "../x"], { cwd: home })
        expect(traversal.exitCode).not.toBe(0)
      }),
    90_000,
  )

  cliIt.live(
    "refuses hostile URLs, file:// protocol, names like .., and symlinked SKILL.md",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const secret = path.join(home, "secret.txt")
        fs.writeFileSync(secret, "sensitive content")

        // 1. Refuse file:// URLs
        const fileRes = yield* opencode.spawn(["skill", "add", `file://${secret}`, "--name", "filetest"], { cwd: home })
        expect(fileRes.exitCode).not.toBe(0)
        expect(fileRes.stderr + fileRes.stdout).toMatch(/file:\/\//i)

        // 2. Refuse URL with embedded options/whitespace
        const spaceRes = yield* opencode.spawn(["skill", "add", "https://github.com/foo/bar.git --upload-pack=calc", "--name", "spacer"], { cwd: home })
        expect(spaceRes.exitCode).not.toBe(0)

        // 3. Refuse URL with option-like ssh host
        const sshRes = yield* opencode.spawn(["skill", "add", "ssh://-oProxyCommand=calc/foo", "--name", "sshtest"], { cwd: home })
        expect(sshRes.exitCode).not.toBe(0)

        // 4. Refuse names like ".." or path traversal
        const validRepo = bareRepo(home, "valid-skills", { "SKILL.md": skillMd("valid-skill") })
        const dotDotName = yield* opencode.spawn(["skill", "add", validRepo, "--name", ".."], { cwd: home })
        expect(dotDotName.exitCode).not.toBe(0)
        expect(fs.existsSync(path.join(home, ".config/yukioshi/skills/valid-skills"))).toBe(false)
        expect(fs.existsSync(path.join(home, ".config/yukioshi/skills/valid-skill"))).toBe(false)

        const travName = yield* opencode.spawn(["skill", "add", validRepo, "--name", "../escape"], { cwd: home })
        expect(travName.exitCode).not.toBe(0)
        expect(fs.existsSync(path.join(home, ".config/yukioshi/escape"))).toBe(false)
        expect(fs.existsSync(path.join(home, ".config/yukioshi/skills/escape"))).toBe(false)

        // 5. Refuse repo where SKILL.md is a symlink
        const symlinkSkillRepo = bareRepo(
          home,
          "symlink-skill-repo",
          {},
          { "SKILL.md": secret },
        )
        const symResult = yield* opencode.spawn(["skill", "add", symlinkSkillRepo, "--name", "symskill"], { cwd: home })
        expect(symResult.exitCode).not.toBe(0)
        expect(fs.existsSync(path.join(home, ".config/yukioshi/skills/symskill"))).toBe(false)
      }),
    90_000,
  )

  const out = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr
  const installedDir = (home: string, name: string) => path.join(home, ".config/yukioshi/skills", name)

  function folder(root: string, name: string, files: Record<string, string>) {
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, name, file)), { recursive: true })
      fs.writeFileSync(path.join(root, name, file), content)
    }
    return path.join(root, name)
  }

  cliIt.live(
    "adds many sources at once (git, folder, zip, tar.gz) and prints a summary",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const repo = bareRepo(home, "gitsrc", { "a/SKILL.md": skillMd("git-skill") })
        const dir = folder(home, "dirsrc", { "b/SKILL.md": skillMd("dir-skill") })
        folder(home, "zipsrc", { "c/SKILL.md": skillMd("zip-skill") })
        folder(home, "tarsrc", { "d/SKILL.md": skillMd("tar-skill") })
        // bsdtar (Windows 10+) writes zip with -a; elsewhere use zip.
        if (process.platform === "win32")
          Bun.spawnSync([path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), "-a", "-cf", path.join(home, "zipsrc.zip"), "c"], { cwd: path.join(home, "zipsrc") })
        else Bun.spawnSync(["zip", "-qr", path.join(home, "zipsrc.zip"), "c"], { cwd: path.join(home, "zipsrc") })
        tarGz(path.join(home, "tarsrc.tar.gz"), [{ name: "d/SKILL.md", content: skillMd("tar-skill") }])
        const result = yield* opencode.spawn(
          ["skill", "add", repo, dir, path.join(home, "zipsrc.zip"), path.join(home, "tarsrc.tar.gz")],
          { cwd: home },
        )
        opencode.expectExit(result, 0, "skill add many")
        for (const name of ["git-skill", "dir-skill", "zip-skill", "tar-skill"]) expect(out(result)).toContain(name)
        expect(out(result)).toContain("4 installed, 0 skipped, 0 failed")
        expect(fs.existsSync(path.join(installedDir(home, "zipsrc"), "c/SKILL.md"))).toBe(true)
        expect(fs.existsSync(path.join(installedDir(home, "tarsrc"), "d/SKILL.md"))).toBe(true)
      }),
    120_000,
  )

  cliIt.live(
    "--select installs only the named skills and --list installs nothing",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const dir = folder(home, "multi", {
          "one/SKILL.md": skillMd("one"),
          "two/SKILL.md": skillMd("two"),
          "three/SKILL.md": skillMd("three"),
        })
        const listed = yield* opencode.spawn(["skill", "add", dir, "--list"], { cwd: home })
        opencode.expectExit(listed, 0, "skill add --list")
        expect(out(listed)).toContain("one")
        expect(out(listed)).toContain("three")
        expect(fs.existsSync(installedDir(home, "multi"))).toBe(false)

        const result = yield* opencode.spawn(["skill", "add", dir, "--select", "one,three"], { cwd: home })
        opencode.expectExit(result, 0, "skill add --select")
        expect(fs.existsSync(path.join(installedDir(home, "multi"), "one/SKILL.md"))).toBe(true)
        expect(fs.existsSync(path.join(installedDir(home, "multi"), "three/SKILL.md"))).toBe(true)
        expect(fs.existsSync(path.join(installedDir(home, "multi"), "two"))).toBe(false)

        const missing = yield* opencode.spawn(["skill", "add", dir, "--select", "nope", "--name", "other"], { cwd: home })
        expect(missing.exitCode).toBe(1)
        expect(fs.existsSync(installedDir(home, "other"))).toBe(false)
      }),
    120_000,
  )

  cliIt.live(
    "--from-file reads sources and ignores comments; a failed source gives exit 1 but others install",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const good = folder(home, "good", { "SKILL.md": skillMd("good-skill") })
        const bad = folder(home, "bad", { "README.md": "nothing" })
        const list = path.join(home, "skills.txt")
        fs.writeFileSync(list, `# my skills\n\n${good}  # trailing comment\n${bad}\n`)
        const result = yield* opencode.spawn(["skill", "add", "--from-file", list], { cwd: home })
        expect(result.exitCode).toBe(1)
        expect(out(result)).toContain("1 installed, 0 skipped, 1 failed")
        expect(out(result)).toContain("no SKILL.md")
        expect(fs.existsSync(path.join(installedDir(home, "good"), "SKILL.md"))).toBe(true)
      }),
    90_000,
  )

  cliIt.live(
    "reports a collision as skipped and only overwrites with --force",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const dir = folder(home, "dup", { "SKILL.md": skillMd("first") })
        opencode.expectExit(yield* opencode.spawn(["skill", "add", dir], { cwd: home }), 0, "first add")
        fs.writeFileSync(path.join(dir, "SKILL.md"), skillMd("second"))
        const again = yield* opencode.spawn(["skill", "add", dir], { cwd: home })
        opencode.expectExit(again, 0, "second add")
        expect(out(again)).toContain("0 installed, 1 skipped, 0 failed")
        expect(fs.readFileSync(path.join(installedDir(home, "dup"), "SKILL.md"), "utf8")).toContain("first")
        const forced = yield* opencode.spawn(["skill", "add", dir, "--force"], { cwd: home })
        opencode.expectExit(forced, 0, "forced add")
        expect(fs.readFileSync(path.join(installedDir(home, "dup"), "SKILL.md"), "utf8")).toContain("second")
      }),
    90_000,
  )

  cliIt.live(
    "rejects archives with path traversal or symlinks and installs nothing from them",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        // A tar whose entry escapes via "..", and one holding a symlink; built in-process so names stay verbatim.
        const evil = path.join(home, "evil.tar.gz")
        tarGz(evil, [{ name: "../escape/SKILL.md", content: "x" }])
        tarGz(path.join(home, "linked.tgz"), [
          { name: "s/SKILL.md", content: skillMd("linked") },
          { name: "s/leak", link: "/etc/passwd" },
        ])
        const result = yield* opencode.spawn(["skill", "add", evil, path.join(home, "linked.tgz")], { cwd: home })
        expect(result.exitCode).toBe(1)
        expect(out(result)).toContain("escapes")
        expect(out(result)).toContain("link")
        expect(out(result)).toContain("0 installed, 0 skipped, 2 failed")
        expect(fs.existsSync(installedDir(home, "evil"))).toBe(false)
        expect(fs.existsSync(installedDir(home, "linked"))).toBe(false)
        expect(fs.existsSync(path.join(home, ".config/yukioshi/escape"))).toBe(false)
      }),
    90_000,
  )

  cliIt.live(
    "--project needs a trusted project, then installs into .yukioshi/skills",
    ({ home, opencode }) =>
      Effect.gen(function* () {
        const dir = folder(home, "psrc", { "SKILL.md": skillMd("proj-skill") })
        const project = path.join(home, "proj")
        fs.mkdirSync(project, { recursive: true })
        const refused = yield* opencode.spawn(["skill", "add", dir, "--project"], { cwd: project })
        expect(refused.exitCode).toBe(1)
        expect(out(refused)).toContain("trust")
        expect(fs.existsSync(path.join(project, ".yukioshi/skills/psrc"))).toBe(false)
        opencode.expectExit(yield* opencode.spawn(["trust", project], { cwd: project }), 0, "trust")
        const ok = yield* opencode.spawn(["skill", "add", dir, "--project"], { cwd: project })
        opencode.expectExit(ok, 0, "project add")
        expect(fs.existsSync(path.join(project, ".yukioshi/skills/psrc/SKILL.md"))).toBe(true)
      }),
    120_000,
  )
})
