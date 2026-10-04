import { describe, expect, test } from "bun:test"
import { SafetyGuards } from "@yukioshi/core/permission/guards"
import { RiskClassifier } from "@yukioshi/core/permission/risk"

describe("SafetyGuards", () => {
  test("blocks secret files and protected directories for every path action", () => {
    const resources = [
      ".env",
      ".env.local",
      "id_rsa",
      "server.pem",
      ".ssh/config",
      ".git/config",
      ".aws/credentials",
      ".gnupg/private-keys-v1.d/key",
      ".kube/config",
      "/home/me/.config/gcloud/application_default_credentials.json",
      "/home/me/.config/gcloud/credentials.db",
      "/home/me/.config/gcloud/access_tokens.db",
      "/home/me/.config/gcloud/legacy_credentials/me@example.com/adc.json",
    ]
    for (const action of ["read", "edit", "write", "apply_patch"]) {
      for (const resource of resources) {
        expect(SafetyGuards.check(action, [resource])?.reason).toMatch(/protected path/)
      }
    }
  })

  test("allows env templates and ordinary paths through the path actions", () => {
    expect(SafetyGuards.check("edit", ["/project/src/index.ts"])).toBeUndefined()
    expect(SafetyGuards.check("read", ["/project/README.md"])).toBeUndefined()
    expect(SafetyGuards.check("write", ["/project/environment.ts"])).toBeUndefined()
    expect(SafetyGuards.check("edit", [".env.example"])).toBeUndefined()
    expect(SafetyGuards.check("edit", ["config/.env.sample"])).toBeUndefined()
    expect(SafetyGuards.check("read", ["/home/me/.config/gcloud/configurations/config_default"])).toBeUndefined()
    expect(SafetyGuards.check("read", ["/project/data/credentials.db"])).toBeUndefined()
    expect(SafetyGuards.check("write", [".env.local.template"])).toBeUndefined()
    expect(SafetyGuards.check("apply_patch", ["config/.env.production.dist"])).toBeUndefined()
  })

  test("blocks shell startup files only when their permission resource is outside the project", () => {
    const outside = [
      "/home/user/.bashrc",
      "../.bash_profile",
      "../../.bash_login",
      "/home/user/.profile",
      "../.zshrc",
      "/home/user/.zprofile",
      "../.zshenv",
      "/home/user/.zlogin",
      "../fish/config.fish",
      "C:\\Users\\user\\Documents\\PowerShell\\Microsoft.PowerShell_profile.ps1",
    ]
    for (const action of ["read", "edit", "write", "apply_patch"]) {
      for (const resource of outside) {
        expect(SafetyGuards.check(action, [resource])?.reason).toMatch(/protected path/)
      }
    }

    const projectFiles = [
      ".bashrc",
      ".bash_profile",
      ".bash_login",
      ".profile",
      ".zshrc",
      ".zprofile",
      ".zshenv",
      ".zlogin",
      "fish/config.fish",
      ".config/fish/config.fish",
      "Microsoft.PowerShell_profile.ps1",
    ]
    for (const resource of projectFiles) {
      expect(SafetyGuards.check("edit", [resource])).toBeUndefined()
    }
  })

  test("does not block non-path actions on a protected-looking resource", () => {
    expect(SafetyGuards.check("grep", [".env"])).toBeUndefined()
    expect(SafetyGuards.check("glob", ["**/.git/**"])).toBeUndefined()
  })

  test("blocks recursive or forced rm only for exact catastrophic targets", () => {
    const commands = [
      "rm -rf /",
      "rm -rf /*",
      "rm -rf ~",
      "rm -rf ~/",
      "rm -rf ~/*",
      "rm -rf $HOME",
      "rm -rf ${HOME}",
      "rm -rf $HOME/",
      "rm -rf *",
      "rm -rf .",
      "rm -rf ./",
      "sudo rm -rf /",
      "sudo -n rm --recursive --force /*",
    ]
    for (const command of commands) {
      expect(SafetyGuards.check("bash", [command])?.reason).toMatch(/destructive command/)
    }
  })

  test("allows recursive rm below catastrophic roots", () => {
    const commands = [
      "rm -rf /tmp/build-cache",
      "rm -rf ~/.cache/my-tool",
      "rm -rf $HOME/.cache/my-tool",
      "rm -rf ./build-cache",
      "rm -rf node_modules",
    ]
    for (const command of commands) {
      expect(SafetyGuards.check("bash", [command])).toBeUndefined()
    }
  })

  test("blocks power programs only at executable command positions", () => {
    const commands = [
      "shutdown -h now",
      "sudo reboot",
      "sudo -n reboot",
      "sudo -u root reboot",
      "echo hi && sudo --user=root poweroff",
      "echo hi && poweroff",
      "echo hi; shutdown -h now",
      "false || reboot",
      "printf hi | halt",
      "sleep 1 & poweroff",
      "printf hi\nshutdown -h now",
      "echo $(reboot)",
      'echo "$(reboot)"',
      "echo `halt`",
      'echo "`halt`"',
    ]
    for (const command of commands) {
      expect(SafetyGuards.check("bash", [command])?.reason).toMatch(/destructive command/)
    }
  })

  test("allows power-command words in arguments and quoted strings", () => {
    const commands = [
      'rg "graceful shutdown" src',
      'git commit -m "fix reboot loop"',
      "grep -rn halt src/",
      "echo poweroff",
      `printf '%s' "safe; shutdown -h now"`,
      `rg 'poweroff | reboot' src`,
      `echo '$(reboot)'`,
      "echo '`halt`'",
    ]
    for (const command of commands) {
      expect(SafetyGuards.check("bash", [command])).toBeUndefined()
    }
  })

  test("blocks the remaining catastrophic shell operations", () => {
    const commands = [
      "mkfs.ext4 /dev/sda1",
      "dd if=/dev/zero of=/dev/sda",
      ":(){ :|:& };:",
      "git push --force origin main",
      "git push -f origin main",
      "git push origin +main",
      "git branch -D main",
      "chmod -R 000 /",
      'rm -rf "$HOME"',
      'rm -rf "${HOME}/"',
    ]
    for (const command of commands) {
      expect(SafetyGuards.check("bash", [command])?.reason).toMatch(/destructive command/)
    }
  })

  test("allows ordinary bash commands", () => {
    expect(SafetyGuards.check("bash", ["ls -la"])).toBeUndefined()
    expect(SafetyGuards.check("bash", ["rm old-file.txt"])).toBeUndefined()
    expect(SafetyGuards.check("bash", ["git push origin feature-branch"])).toBeUndefined()
    expect(SafetyGuards.check("bash", ["git push --force origin feature-branch"])).toBeUndefined()
    expect(SafetyGuards.check("bash", ['echo "git push --force origin main"'])).toBeUndefined()
    expect(SafetyGuards.check("bash", ['echo "rm -rf /"'])).toBeUndefined()
    expect(SafetyGuards.check("bash", ["git push -f origin feature-branch"])).toBeUndefined()
    expect(SafetyGuards.check("bash", ["git push -u origin main"])).toBeUndefined()
    expect(SafetyGuards.check("bash", ["rm -rf '$HOME'"])).toBeUndefined()
  })
})

describe("RiskClassifier", () => {
  test("classifies known read-only actions as low", () => {
    expect(RiskClassifier.classify("read")).toBe("low")
    expect(RiskClassifier.classify("grep")).toBe("low")
    expect(RiskClassifier.classify("glob")).toBe("low")
    expect(RiskClassifier.classify("memory_recall")).toBe("low")
    expect(RiskClassifier.classify("code_search")).toBe("low")
    expect(RiskClassifier.classify("session_search")).toBe("low")
  })

  test("classifies network actions as medium", () => {
    expect(RiskClassifier.classify("webfetch")).toBe("medium")
    expect(RiskClassifier.classify("websearch")).toBe("medium")
  })

  test("classifies mutating actions as high", () => {
    expect(RiskClassifier.classify("bash")).toBe("high")
    expect(RiskClassifier.classify("edit")).toBe("high")
    expect(RiskClassifier.classify("write")).toBe("high")
    expect(RiskClassifier.classify("memory_save")).toBe("high")
  })

  test("defaults unknown actions to high", () => {
    expect(RiskClassifier.classify("some_future_tool")).toBe("high")
  })
})
