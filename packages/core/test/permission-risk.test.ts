import { describe, expect, test } from "bun:test"
import { RiskClassifier } from "../src/permission/risk"

describe("RiskClassifier.classify", () => {
  test("read-only tools are low risk", () => {
    for (const action of ["read", "grep", "glob", "list", "todoread", "question", "code_search", "session_search"]) {
      expect(RiskClassifier.classify(action)).toBe("low")
    }
  })

  test("network and out-of-tree access is medium risk", () => {
    for (const action of ["webfetch", "websearch", "external_directory"]) {
      expect(RiskClassifier.classify(action)).toBe("medium")
    }
  })

  test("anything that writes, executes or delegates is high risk", () => {
    for (const action of ["bash", "edit", "write", "apply_patch", "memory_save", "skill_save", "delegate"]) {
      expect(RiskClassifier.classify(action)).toBe("high")
    }
  })

  test("unknown actions fail closed to high", () => {
    for (const action of ["", "mystery_tool", "mcp_server_tool", "task", "*"]) {
      expect(RiskClassifier.classify(action)).toBe("high")
    }
  })

  test("matching is exact: case, whitespace and prefixes do not downgrade risk", () => {
    for (const action of ["READ", "Read", " read", "read ", "read\n", "reader", "read_file", "grep*", "webfetch2", "bash:read"]) {
      expect(RiskClassifier.classify(action)).toBe("high")
    }
  })

  test("object prototype keys are not mistaken for known actions", () => {
    for (const action of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      expect(RiskClassifier.classify(action)).toBe("high")
    }
  })
})
