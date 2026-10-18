import { describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { ConfigAgent } from "../../src/config/agent"
import { MAX_SESSION_AGENTS_BYTES, parseSessionAgents } from "../../src/config/session-agents"
import { deriveSubagentSessionPermission } from "../../src/agent/subagent-permissions"

const ok = { reviewer: { description: "reviews", prompt: " Review it. ", tools: ["Read", "Grep"], model: "opus" } }

describe("--agents", () => {
  test("parses inline JSON and a file path, with markdown-agent field handling", () => {
    const text = parseSessionAgents(JSON.stringify(ok))
    const agents = ConfigAgent.fromRecord(JSON.parse(text))
    expect(agents.reviewer.prompt).toBe("Review it.")
    expect(agents.reviewer.permission).toEqual({ "*": "deny", read: "allow", grep: "allow" })
    expect(agents.reviewer.model).toBeUndefined()
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "agents-"))
    fs.writeFileSync(path.join(dir, "a.json"), JSON.stringify(ok))
    expect(parseSessionAgents("a.json", dir)).toBe(text)
  })

  test("rejects bad JSON, non-objects, missing prompt and missing files", () => {
    expect(() => parseSessionAgents("{nope")).toThrow("invalid JSON")
    expect(() => parseSessionAgents("[1]", "/")).toThrow("neither a JSON object nor a readable file")
    expect(() => parseSessionAgents(JSON.stringify({ a: { description: "x" } }))).toThrow('needs a non-empty "prompt"')
    expect(() => parseSessionAgents(JSON.stringify({ a: 1 }))).toThrow("must be an object")
    expect(() => parseSessionAgents("missing-file.json")).toThrow("neither a JSON object nor a readable file")
  })

  test("rejects oversize input, inline and from a file", () => {
    const big = JSON.stringify({ a: { prompt: "x".repeat(MAX_SESSION_AGENTS_BYTES) } })
    expect(() => parseSessionAgents(big)).toThrow("64 KB")
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "agents-"))
    fs.writeFileSync(path.join(dir, "big.json"), big)
    expect(() => parseSessionAgents("big.json", dir)).toThrow("64 KB")
  })

  test("a flag agent cannot escape parent deny rules and bypassPermissions is ignored", () => {
    const agents = ConfigAgent.fromRecord({
      sneaky: { prompt: "p", tools: ["Bash"], permissionMode: "bypassPermissions" },
    })
    expect(JSON.stringify(agents.sneaky.permission)).not.toContain("bypass")
    expect(agents.sneaky.permission).toEqual({ "*": "deny", bash: "allow" })
    const rules = deriveSubagentSessionPermission({
      parentSessionPermission: [{ permission: "bash", pattern: "*", action: "deny" }],
      subagent: { permission: [{ permission: "bash", pattern: "*", action: "allow" }] } as any,
    })
    // Parent deny comes first in the child ruleset; the agent's own rules are evaluated after
    // it by the session, so the deny must be carried over for last-match merging to see it.
    expect(rules).toContainEqual({ permission: "bash", pattern: "*", action: "deny" })
  })
})
