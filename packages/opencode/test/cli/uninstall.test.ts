import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import os from "os"
import {
  cleanShellConfig,
  getShellConfigFile,
  isYukiOshiOrOpenCodePathLine,
} from "../../src/cli/cmd/uninstall"

describe("uninstall shell-config cleanup", () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "yukioshi-uninstall-test-"))
  })

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {})
  })

  describe("isYukiOshiOrOpenCodePathLine", () => {
    test("detects YukiOshi export PATH lines", () => {
      expect(isYukiOshiOrOpenCodePathLine("export PATH=/home/user/.yukioshi/bin:$PATH")).toBe(true)
      expect(isYukiOshiOrOpenCodePathLine('export PATH="$HOME/.yukioshi/bin:$PATH"')).toBe(true)
      expect(isYukiOshiOrOpenCodePathLine("export PATH=$HOME/.yukioshi/bin:$PATH")).toBe(true)
      expect(isYukiOshiOrOpenCodePathLine("PATH=$HOME/.yukioshi/bin:$PATH")).toBe(true)
    })

    test("detects YukiOshi fish_add_path lines", () => {
      expect(isYukiOshiOrOpenCodePathLine("fish_add_path /home/user/.yukioshi/bin")).toBe(true)
      expect(isYukiOshiOrOpenCodePathLine("fish_add_path $HOME/.yukioshi/bin")).toBe(true)
      expect(isYukiOshiOrOpenCodePathLine("fish_add_path -m /home/user/.yukioshi/bin")).toBe(true)
    })

    test("detects fish set -gx PATH lines", () => {
      expect(isYukiOshiOrOpenCodePathLine("set -gx PATH $HOME/.yukioshi/bin $PATH")).toBe(true)
      expect(isYukiOshiOrOpenCodePathLine("set -U fish_user_paths $HOME/.yukioshi/bin $fish_user_paths")).toBe(true)
    })

    test("detects legacy OpenCode PATH lines", () => {
      expect(isYukiOshiOrOpenCodePathLine("export PATH=/home/user/.opencode/bin:$PATH")).toBe(true)
      expect(isYukiOshiOrOpenCodePathLine('export PATH="$HOME/.opencode/bin:$PATH"')).toBe(true)
      expect(isYukiOshiOrOpenCodePathLine("fish_add_path /home/user/.opencode/bin")).toBe(true)
      expect(isYukiOshiOrOpenCodePathLine("set -gx PATH $HOME/.opencode/bin $PATH")).toBe(true)
    })

    test("does not match unrelated PATH or non-PATH lines", () => {
      expect(isYukiOshiOrOpenCodePathLine("export PATH=/usr/local/bin:$PATH")).toBe(false)
      expect(isYukiOshiOrOpenCodePathLine("fish_add_path /opt/homebrew/bin")).toBe(false)
      expect(isYukiOshiOrOpenCodePathLine('echo "visit https://github.com/ahmed-alxawad/YukiOshiCode"')).toBe(false)
      expect(isYukiOshiOrOpenCodePathLine("export YUKIOSHI_CONFIG=/path/to/config")).toBe(false)
      expect(isYukiOshiOrOpenCodePathLine("# yukioshi")).toBe(false)
    })
  })

  describe("cleanShellConfig", () => {
    test("cleans standard YukiOshi bash config with # yukioshi comment", async () => {
      const file = path.join(tempDir, ".bashrc")
      const initial = [
        "# User environment",
        "export EDITOR=vim",
        "",
        "# yukioshi",
        "export PATH=/home/user/.yukioshi/bin:$PATH",
        "",
      ].join("\n")

      await fs.writeFile(file, initial, "utf8")
      await cleanShellConfig(file)

      const result = await fs.readFile(file, "utf8")
      expect(result).not.toContain("# yukioshi")
      expect(result).not.toContain(".yukioshi/bin")
      expect(result).toContain("# User environment")
      expect(result).toContain("export EDITOR=vim")
    })

    test("cleans standard YukiOshi fish config with fish_add_path", async () => {
      const file = path.join(tempDir, "config.fish")
      const initial = [
        "set -x FOO bar",
        "",
        "# yukioshi",
        "fish_add_path /home/user/.yukioshi/bin",
        "",
      ].join("\n")

      await fs.writeFile(file, initial, "utf8")
      await cleanShellConfig(file)

      const result = await fs.readFile(file, "utf8")
      expect(result).not.toContain("# yukioshi")
      expect(result).not.toContain(".yukioshi/bin")
      expect(result).not.toContain("fish_add_path")
      expect(result).toContain("set -x FOO bar")
    })

    test("cleans legacy OpenCode bash config", async () => {
      const file = path.join(tempDir, ".bashrc")
      const initial = [
        "export SOME_VAR=1",
        "",
        "# opencode",
        "export PATH=/home/user/.opencode/bin:$PATH",
      ].join("\n")

      await fs.writeFile(file, initial, "utf8")
      await cleanShellConfig(file)

      const result = await fs.readFile(file, "utf8")
      expect(result).not.toContain("# opencode")
      expect(result).not.toContain(".opencode/bin")
      expect(result).toContain("export SOME_VAR=1")
    })

    test("cleans legacy OpenCode fish config", async () => {
      const file = path.join(tempDir, "config.fish")
      const initial = [
        "# opencode",
        "fish_add_path /home/user/.opencode/bin",
        "",
        "alias l='ls -l'",
      ].join("\n")

      await fs.writeFile(file, initial, "utf8")
      await cleanShellConfig(file)

      const result = await fs.readFile(file, "utf8")
      expect(result).not.toContain("# opencode")
      expect(result).not.toContain(".opencode/bin")
      expect(result).toContain("alias l='ls -l'")
    })

    test("cleans both YukiOshi and legacy OpenCode entries in same file", async () => {
      const file = path.join(tempDir, ".zshrc")
      const initial = [
        "export ALIAS=1",
        "",
        "# opencode",
        "export PATH=/home/user/.opencode/bin:$PATH",
        "",
        "# yukioshi",
        "export PATH=/home/user/.yukioshi/bin:$PATH",
        "",
        "export DONE=true",
      ].join("\n")

      await fs.writeFile(file, initial, "utf8")
      await cleanShellConfig(file)

      const result = await fs.readFile(file, "utf8")
      expect(result).not.toContain("# opencode")
      expect(result).not.toContain(".opencode/bin")
      expect(result).not.toContain("# yukioshi")
      expect(result).not.toContain(".yukioshi/bin")
      expect(result).toContain("export ALIAS=1")
      expect(result).toContain("export DONE=true")
    })

    test("cleans YukiOshi PATH line even without preceding comment", async () => {
      const file = path.join(tempDir, ".bash_profile")
      const initial = [
        "export PATH=/home/user/.yukioshi/bin:$PATH",
        "export KEEP=yes",
      ].join("\n")

      await fs.writeFile(file, initial, "utf8")
      await cleanShellConfig(file)

      const result = await fs.readFile(file, "utf8")
      expect(result).not.toContain(".yukioshi/bin")
      expect(result).toContain("export KEEP=yes")
    })

    test("cleans fish_add_path even without preceding comment", async () => {
      const file = path.join(tempDir, "config.fish")
      const initial = [
        "fish_add_path /home/user/.yukioshi/bin",
        "set -g fish_greeting ''",
      ].join("\n")

      await fs.writeFile(file, initial, "utf8")
      await cleanShellConfig(file)

      const result = await fs.readFile(file, "utf8")
      expect(result).not.toContain(".yukioshi/bin")
      expect(result).toContain("set -g fish_greeting ''")
    })

    test("preserves unrelated PATH modifications and comments intact", async () => {
      const file = path.join(tempDir, ".profile")
      const initial = [
        "# Unrelated path addition",
        "export PATH=/usr/local/go/bin:$PATH",
        "export PATH=$HOME/.cargo/bin:$PATH",
        "",
        "# yukioshi",
        "export PATH=$HOME/.yukioshi/bin:$PATH",
        "",
        "# Another comment",
        "export NVM_DIR=$HOME/.nvm",
      ].join("\n")

      await fs.writeFile(file, initial, "utf8")
      await cleanShellConfig(file)

      const result = await fs.readFile(file, "utf8")
      expect(result).not.toContain("# yukioshi")
      expect(result).not.toContain(".yukioshi/bin")
      expect(result).toContain("# Unrelated path addition")
      expect(result).toContain("export PATH=/usr/local/go/bin:$PATH")
      expect(result).toContain("export PATH=$HOME/.cargo/bin:$PATH")
      expect(result).toContain("# Another comment")
      expect(result).toContain("export NVM_DIR=$HOME/.nvm")
    })
  })

  describe("getShellConfigFile", () => {
    test("finds bash config containing # yukioshi in temporary home", async () => {
      const bashrc = path.join(tempDir, ".bashrc")
      await fs.writeFile(bashrc, "# yukioshi\nexport PATH=/home/user/.yukioshi/bin:$PATH\n", "utf8")

      const found = await getShellConfigFile({ home: tempDir, shell: "bash" })
      expect(found).toBe(bashrc)
    })

    test("finds fish config containing .yukioshi/bin in xdgConfig", async () => {
      const fishDir = path.join(tempDir, ".config", "fish")
      await fs.mkdir(fishDir, { recursive: true })
      const fishConfig = path.join(fishDir, "config.fish")
      await fs.writeFile(fishConfig, "fish_add_path /home/user/.yukioshi/bin\n", "utf8")

      const found = await getShellConfigFile({
        home: tempDir,
        shell: "fish",
        xdgConfig: path.join(tempDir, ".config"),
      })
      expect(found).toBe(fishConfig)
    })

    test("finds zsh config with legacy # opencode", async () => {
      const zshrc = path.join(tempDir, ".zshrc")
      await fs.writeFile(zshrc, "# opencode\nexport PATH=/home/user/.opencode/bin:$PATH\n", "utf8")

      const found = await getShellConfigFile({ home: tempDir, shell: "zsh" })
      expect(found).toBe(zshrc)
    })

    test("returns null if no shell config contains yukioshi or opencode references", async () => {
      const bashrc = path.join(tempDir, ".bashrc")
      await fs.writeFile(bashrc, "export FOO=bar\n", "utf8")

      const found = await getShellConfigFile({ home: tempDir, shell: "bash" })
      expect(found).toBeNull()
    })
  })
})
