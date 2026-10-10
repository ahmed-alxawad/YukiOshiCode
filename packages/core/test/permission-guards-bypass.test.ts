import { describe, expect, test } from "bun:test"
import { SafetyGuards } from "../src/permission/guards"

const blocked = (command: string) => SafetyGuards.check("bash", [command]) !== undefined
const pathBlocked = (resource: string, action = "read") => SafetyGuards.check(action, [resource]) !== undefined

describe("destructive command detection resists shell tricks", () => {
  test.each([
    "ls && rm -rf /",
    "ls;rm -rf /",
    "ls | rm -rf /",
    "ls || rm -rf /",
    "ls & rm -rf /",
    "echo $(rm -rf /)",
    "echo `rm -rf /`",
    'echo "$(rm -rf /)"',
    "ls\nrm -rf /",
    "FOO=1 rm -rf /",
    "A=1 B=2 rm -rf /",
    "env rm -rf /",
    "env -i FOO=1 rm -rf /",
    "sudo -u root rm -rf /",
    "sudo env rm -rf /",
    "nohup rm -rf /",
    "command rm -rf /",
    "/bin/rm -rf /",
    "\\rm -rf /",
    "rm -r -f /",
    "rm -fr /",
    "rm -Rf /",
    "RM -rf /",
    "rm -rf -- /",
    "rm -rf '/'",
    'rm -rf "/"',
    "rm -rf //",
    "rm -rf /.",
    "rm -rf /*",
    "rm -rf ~",
    "rm -rf $HOME",
    'rm -rf "$HOME"',
    "rm --recursive --force /",
    "bash -c 'rm -rf /'",
    'sh -c "rm -rf /"',
    "git -C . push -f origin main",
    "git push --force origin main",
    "git push origin +main",
    "git push --force-with-lease origin master",
    "git branch -D main",
    "dd if=/dev/zero of=/dev/sda",
    "mkfs.ext4 /dev/sda1",
    "chmod -R 000 /",
    "cat x > /dev/sda",
    ":(){ :|:& };:",
    "sudo shutdown now",
  ])("blocks %p", (command) => {
    expect(blocked(command)).toBe(true)
  })

  test.each([
    "rm -rf node_modules",
    "rm -rf ./build",
    "rm -rf /tmp/x",
    "rm file.txt",
    "rm -rf '$HOME'",
    "echo rm -rf /",
    "echo 'rm -rf /'",
    'echo "git push --force origin main"',
    "git push origin feature",
    "git push --force origin feature",
    "git status",
    "bash -c 'echo hi'",
    "FOO=rm echo hi",
    "dd if=/dev/zero of=./file.img",
    "grep shutdown log.txt",
    "",
    "   ",
  ])("allows %p", (command) => {
    expect(blocked(command)).toBe(false)
  })

  test("unbalanced quotes and huge inputs do not throw or hang", () => {
    expect(() => blocked("echo 'unterminated")).not.toThrow()
    expect(() => blocked('echo "$(')).not.toThrow()
    expect(() => blocked("`")).not.toThrow()
    expect(blocked("ls ".repeat(100_000) + "&& rm -rf /")).toBe(true)
    expect(blocked("$(".repeat(2000) + "rm -rf /" + ")".repeat(2000))).toBe(true)
  })

  test("unicode arguments do not confuse the parser", () => {
    expect(blocked("echo 日本語 && rm -rf /")).toBe(true)
    expect(blocked("rm -rf ./日本語")).toBe(false)
  })

  test("only the bash action is checked for commands", () => {
    expect(SafetyGuards.check("read", ["rm -rf /"])).toBeUndefined()
    expect(SafetyGuards.check("webfetch", ["rm -rf /"])).toBeUndefined()
  })
})

describe("protected paths resist platform spelling tricks", () => {
  test.each([
    "/home/u/.ssh/id_rsa",
    "C:\\Users\\u\\.ssh\\config",
    "C:\\Users\\u\\.SSH\\config",
    "a/.GIT/config",
    "a/.git./config",
    "a/.ssh /config",
    "\\\\srv\\share\\.ssh\\x",
    "repo/.git/hooks/pre-commit",
    "x/.ENV",
    "x/.Env.local",
    "server.PEM",
    "~/.NPMRC",
    "dir/Credentials.JSON",
    "/etc/shadow",
    "./sub/../.env",
  ])("blocks %p", (resource) => {
    expect(pathBlocked(resource)).toBe(true)
    expect(pathBlocked(resource, "edit")).toBe(true)
    expect(pathBlocked(resource, "write")).toBe(true)
    expect(pathBlocked(resource, "apply_patch")).toBe(true)
  })

  test.each([".env.example", "app/.env.sample", "src/index.ts", "README.md", "notes/ssh.md", "..", ".", "a/b/.gitignore", ".github/workflows/ci.yml"])(
    "allows %p",
    (resource) => {
      expect(pathBlocked(resource)).toBe(false)
    },
  )

  test("path checks apply to every resource, not only the first", () => {
    expect(SafetyGuards.check("read", ["ok.txt", "also/ok.txt", ".ssh/id_rsa"])?.reason).toContain(".ssh/id_rsa")
    expect(SafetyGuards.check("read", [])).toBeUndefined()
  })
})
