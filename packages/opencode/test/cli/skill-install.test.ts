import { describe, expect } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs"
import path from "node:path"
import { cliIt } from "../lib/cli-process"

function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawnSync(
    ["git", "-c", "user.email=t@example.test", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  )
  if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`)
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
})
