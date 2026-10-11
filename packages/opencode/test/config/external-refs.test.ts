import { describe, expect, test } from "bun:test"
import path from "path"
import { referencesOutsideProject } from "@/config/external-refs"

// Platform injected: the Windows rules run on any host with path.win32 and an in-memory file system.
const win = (files: Record<string, string> = {}) => {
  const exist = new Map(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]))
  return {
    platform: "win32" as const,
    pathModule: path.win32,
    home: "C:\\Users\\bob",
    canonical: (p: string) => path.win32.normalize(p),
    realpath: (p: string) => {
      const hit = exist.get(path.win32.normalize(p).toLowerCase())
      if (hit === undefined) throw new Error("ENOENT")
      return hit
    },
  }
}
const roots = { directory: "C:\\Users\\bob\\proj", worktree: "C:\\Users\\bob\\proj" }
const present = {
  "C:\\Users\\bob\\proj\\inside.txt": "C:\\Users\\bob\\proj\\inside.txt",
  "C:\\Users\\bob\\.ssh\\id_rsa": "C:\\Users\\bob\\.ssh\\id_rsa",
  "C:\\Users\\bob\\x": "C:\\Users\\bob\\x",
  "C:\\Windows\\win.ini": "C:\\Windows\\win.ini",
  "\\\\server\\share\\f.txt": "\\\\server\\share\\f.txt",
  "C:\\Users\\bob\\proj\\link.txt": "C:\\Users\\bob\\x", // junction or symlink pointing out
  "C:\\Users\\bob\\proj\\short": "C:\\Users\\bob\\proj\\sub\\file.txt", // 8.3 name resolving back inside
  "D:\\data.txt": "D:\\data.txt",
}
const check = (ref: string, r = roots) => referencesOutsideProject(`see @${ref} now`, r, win(present))

describe("referencesOutsideProject on Windows", () => {
  test.each([
    ["absolute backslash", "C:\\Windows\\win.ini"],
    ["absolute forward slash", "C:/Windows/win.ini"],
    ["lower-case drive", "c:\\windows\\win.ini"],
    ["other drive", "D:\\data.txt"],
    ["UNC", "\\\\server\\share\\f.txt"],
    ["parent backslash", "..\\x"],
    ["parent forward slash", "../x"],
    ["home backslash", "~\\.ssh\\id_rsa"],
    ["home forward slash", "~/.ssh/id_rsa"],
    ["link escaping the project", "link.txt"],
  ])("outside: %s", (_, ref) => expect(check(ref)).toBe(true))

  test.each([
    ["inside", "inside.txt"],
    ["inside with different case", "INSIDE.TXT"],
    ["8.3 name resolving inside", "short"],
    ["environment-style name is not expanded", "%USERPROFILE%\\.ssh\\id_rsa"],
    ["missing file", "missing.txt"],
  ])("kept: %s", (_, ref) => expect(check(ref)).toBe(false))

  test("project root differing only by case still contains its files", () => {
    expect(check("inside.txt", { directory: "c:\\users\\BOB\\proj", worktree: "c:\\users\\BOB\\proj" })).toBe(false)
  })

  test("a sibling directory sharing the project name prefix is outside", () => {
    const files = { "C:\\Users\\bob\\proj2\\a.txt": "C:\\Users\\bob\\proj2\\a.txt" }
    expect(referencesOutsideProject("@..\\proj2\\a.txt", roots, win(files))).toBe(true)
  })
})

describe("referencesOutsideProject on POSIX", () => {
  const posix = (files: string[]) => ({
    platform: "linux" as const,
    pathModule: path.posix,
    home: "/home/bob",
    canonical: (p: string) => p,
    realpath: (p: string) => {
      if (!files.includes(p)) throw new Error("ENOENT")
      return p
    },
  })
  const proot = { directory: "/home/bob/proj", worktree: "/home/bob/proj" }
  const files = ["/etc/passwd", "/home/bob/.ssh/id_rsa", "/home/bob/proj/a.txt"]
  test("home, absolute and parent references are outside", () => {
    for (const ref of ["~/.ssh/id_rsa", "/etc/passwd", "../.ssh/id_rsa"])
      expect(referencesOutsideProject(`@${ref}`, proot, posix(files))).toBe(true)
  })
  test("backslash is a file name character and ~\\ is not home", () => {
    expect(referencesOutsideProject("@~\\.ssh\\id_rsa", proot, posix(files))).toBe(false)
  })
  test("inside is kept", () => expect(referencesOutsideProject("@a.txt", proot, posix(files))).toBe(false))
})
