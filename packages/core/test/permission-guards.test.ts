import { describe, expect, test } from "bun:test"
import { SafetyGuards } from "@yukioshi/core/permission/guards"
import { RiskClassifier } from "@yukioshi/core/permission/risk"

describe("SafetyGuards", () => {
  test("blocks writes to protected paths regardless of action", () => {
    expect(SafetyGuards.check("edit", ["/project/.env"])?.reason).toMatch(/protected path/)
    expect(SafetyGuards.check("write", ["/project/.ssh/config"])?.reason).toMatch(/protected path/)
    expect(SafetyGuards.check("read", ["/project/.git/config"])?.reason).toMatch(/protected path/)
    expect(SafetyGuards.check("edit", ["/home/user/.aws/credentials"])?.reason).toMatch(/protected path/)
    expect(SafetyGuards.check("write", ["/project/id_rsa"])?.reason).toMatch(/protected path/)
  })

  test("allows ordinary paths through the path actions", () => {
    expect(SafetyGuards.check("edit", ["/project/src/index.ts"])).toBeUndefined()
    expect(SafetyGuards.check("read", ["/project/README.md"])).toBeUndefined()
    expect(SafetyGuards.check("write", ["/project/environment.ts"])).toBeUndefined()
  })

  test("does not block non-path actions on a protected-looking resource", () => {
    expect(SafetyGuards.check("grep", [".env"])).toBeUndefined()
    expect(SafetyGuards.check("glob", ["**/.git/**"])).toBeUndefined()
  })

  test("blocks destructive bash commands", () => {
    expect(SafetyGuards.check("bash", ["rm -rf /"])?.reason).toMatch(/destructive command/)
    expect(SafetyGuards.check("bash", ["rm -rf ~"])?.reason).toMatch(/destructive command/)
    expect(SafetyGuards.check("bash", ["sudo rm -fr /*"])?.reason).toMatch(/destructive command/)
    expect(SafetyGuards.check("bash", ["mkfs.ext4 /dev/sda1"])?.reason).toMatch(/destructive command/)
    expect(SafetyGuards.check("bash", ["dd if=/dev/zero of=/dev/sda"])?.reason).toMatch(/destructive command/)
    expect(SafetyGuards.check("bash", [":(){ :|:& };:"])?.reason).toMatch(/destructive command/)
    expect(SafetyGuards.check("bash", ["git push --force origin main"])?.reason).toMatch(/destructive command/)
    expect(SafetyGuards.check("bash", ["git branch -D main"])?.reason).toMatch(/destructive command/)
  })

  test("allows ordinary bash commands", () => {
    expect(SafetyGuards.check("bash", ["ls -la"])).toBeUndefined()
    expect(SafetyGuards.check("bash", ["rm old-file.txt"])).toBeUndefined()
    expect(SafetyGuards.check("bash", ["git push origin feature-branch"])).toBeUndefined()
    expect(SafetyGuards.check("bash", ["git push --force origin feature-branch"])).toBeUndefined()
    expect(SafetyGuards.check("bash", ["rm -rf node_modules"])).toBeUndefined()
  })
})

describe("RiskClassifier", () => {
  test("classifies known read-only actions as low", () => {
    expect(RiskClassifier.classify("read")).toBe("low")
    expect(RiskClassifier.classify("grep")).toBe("low")
    expect(RiskClassifier.classify("glob")).toBe("low")
    expect(RiskClassifier.classify("memory_recall")).toBe("low")
    expect(RiskClassifier.classify("code_search")).toBe("low")
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
