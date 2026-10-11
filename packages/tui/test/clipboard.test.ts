import { expect, test } from "bun:test"
import { copyCommand } from "../src/clipboard"

test("prefers Wayland clipboard when available", () => {
  expect(copyCommand("linux", true, (name) => name === "wl-copy")).toEqual(["wl-copy"])
})

test("uses osascript on macOS", () => {
  expect(copyCommand("darwin", false, (name) => name === "osascript")).toEqual(["osascript"])
})

test("falls back through X11 clipboard commands", () => {
  expect(copyCommand("linux", true, (name) => name === "xclip")).toEqual(["xclip", "-selection", "clipboard"])
  expect(copyCommand("linux", false, (name) => name === "xsel")).toEqual(["xsel", "--clipboard", "--input"])
})

test("returns undefined when native clipboard is unavailable", () => {
  expect(copyCommand("linux", false, () => false)).toBeUndefined()
})

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { copyTo } from "../src/clipboard"

function fake(body: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "clip-"))
  const file = path.join(dir, "tool")
  writeFileSync(file, `#!/bin/sh\n${body}\n`)
  chmodSync(file, 0o755)
  return { dir, file }
}

test("copyTo resolves when the tool forks a daemon that keeps stdio open", async () => {
  const { file } = fake(`cat > /dev/null\n( sleep 3 ) &\nexit 0`)
  const start = Date.now()
  await copyTo(file, [], "hello")
  expect(Date.now() - start).toBeLessThan(2000)
})

test("copyTo rejects when the tool fails", async () => {
  const { file } = fake("exit 1")
  await expect(copyTo(file, [], "x")).rejects.toThrow()
})

test("copyTo rejects when the tool is missing", async () => {
  await expect(copyTo("/nonexistent/clip-tool", [], "x")).rejects.toThrow()
})

test("copyTo times out a hung tool", async () => {
  const { file } = fake("sleep 5")
  await expect(copyTo(file, [], "x", 200)).rejects.toThrow("timed out")
})

test("copyTo passes text on stdin", async () => {
  const out = path.join(mkdtempSync(path.join(tmpdir(), "clip-")), "out")
  const { file } = fake(`cat > ${out}`)
  await copyTo(file, [], "a\nb\tc")
  expect(readFileSync(out, "utf8")).toBe("a\nb\tc")
})

function dir0() {
  return mkdtempSync(path.join(tmpdir(), "clip-"))
}

import { pasteCommands } from "../src/clipboard"

test("reads text with wl-paste on Wayland, then X11 tools", () => {
  const all = () => true
  expect(pasteCommands(true, all)[0]).toEqual(["wl-paste", "--no-newline"])
  expect(pasteCommands(false, all)[0]).toEqual(["xclip", "-selection", "clipboard", "-o"])
  expect(pasteCommands(true, (name) => name === "xsel")).toEqual([["xsel", "--clipboard", "--output"]])
  expect(pasteCommands(true, () => false)).toEqual([])
})
