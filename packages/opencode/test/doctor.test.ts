import { describe, expect, it } from "bun:test"
import { runDoctor } from "../src/cli/cmd/doctor"

describe("doctor", () => {
  it("reports safe provider presence without exposing values", async () => {
    const report = await runDoctor({
      cwd: "/workspace/project",
      env: { OPENAI_API_KEY: "secret-value" },
      executable: "/home/me/.yukioshi/bin/yukioshi",
      paths: { config: "/missing-config", state: "/missing-state" },
      command: (name) => `/bin/${name}`,
      platform: "linux",
    })
    const provider = report.checks.find((check) => check.name === "provider keys")
    expect(provider?.status).toBe("ok")
    expect(JSON.stringify(report)).not.toContain("secret-value")
  })

  it("supports optional network checks and marks failures", async () => {
    const report = await runDoctor({
      env: { OPENAI_API_KEY: "present" },
      paths: { config: "/missing-config", state: "/missing-state" },
      command: () => "/bin/tool",
      network: true,
      fetch: async () => { throw new Error("offline") },
    })
    expect(report.checks.find((check) => check.name === "network")?.status).toBe("problem")
    expect(report.ok).toBe(false)
  })
})
