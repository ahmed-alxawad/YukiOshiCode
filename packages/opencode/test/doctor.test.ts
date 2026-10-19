import { describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { runDoctor } from "../src/cli/cmd/doctor"

describe("doctor", () => {
  it("reports safe provider presence without exposing values", async () => {
    const report = await runDoctor({
      cwd: path.resolve(os.tmpdir(), "workspace", "project"),
      env: { OPENAI_API_KEY: "secret-value" },
      executable: path.join("/home", "me", ".yukioshi", "bin", "yukioshi"),
      paths: {
        config: path.join(os.tmpdir(), "missing-config"),
        state: path.join(os.tmpdir(), "missing-state"),
      },
      command: (name) => path.join("/bin", name),
      platform: "linux",
    })
    const provider = report.checks.find((check) => check.name === "provider keys")
    expect(provider?.status).toBe("ok")
    expect(JSON.stringify(report)).not.toContain("secret-value")
  })

  it("supports optional network checks and marks failures", async () => {
    const report = await runDoctor({
      env: { OPENAI_API_KEY: "present" },
      paths: {
        config: path.join(os.tmpdir(), "missing-config"),
        state: path.join(os.tmpdir(), "missing-state"),
      },
      command: () => path.join("/bin", "tool"),
      network: true,
      fetch: async () => {
        throw new Error("offline")
      },
    })
    expect(report.checks.find((check) => check.name === "network")?.status).toBe("problem")
    expect(report.ok).toBe(false)
  })

  it("does not treat unrelated token environment variables as provider keys", async () => {
    const report = await runDoctor({
      env: { DEPLOYMENT_TOKEN: "not-a-provider-key", RANDOM_API_KEY: "also-not-supported" },
      paths: {
        config: path.join(os.tmpdir(), "missing-config"),
        state: path.join(os.tmpdir(), "missing-state"),
      },
      command: () => path.join("/bin", "tool"),
    })
    expect(report.checks.find((check) => check.name === "provider keys")?.status).toBe("problem")
  })

  it("requires a non-empty provider key value in config", async () => {
    const config = await mkdtemp(path.join(os.tmpdir(), "yukioshi-doctor-"))
    try {
      await writeFile(
        path.join(config, "yukioshi.json"),
        `// "apiKey": "comment-only"
       { "provider": { "openai": { "options": { "apiKey": "  " } } } }`,
      )
      const report = await runDoctor({
        cwd: config,
        env: {},
        paths: { config, state: path.join(os.tmpdir(), "missing-state") },
        command: () => path.join("/bin", "tool"),
      })
      expect(report.checks.find((check) => check.name === "provider keys")?.status).toBe("problem")
    } finally {
      await rm(config, { recursive: true, force: true })
    }
  })

  it("checks the loader's global config.json path", async () => {
    const config = await mkdtemp(path.join(os.tmpdir(), "yukioshi-doctor-"))
    try {
      await writeFile(
        path.join(config, "config.json"),
        '{ "provider": { "openai": { "options": { "apiKey": "configured" } } } }',
      )
      const report = await runDoctor({
        cwd: config,
        env: {},
        paths: { config, state: path.join(os.tmpdir(), "missing-state") },
        command: () => path.join("/bin", "tool"),
      })
      expect(report.checks.find((check) => check.name === "provider keys")?.status).toBe("ok")
      expect(report.checks.find((check) => check.name === "config files")?.path).toBe(path.join(config, "config.json"))
      expect(JSON.stringify(report)).not.toContain("configured")
    } finally {
      await rm(config, { recursive: true, force: true })
    }
  })
})
