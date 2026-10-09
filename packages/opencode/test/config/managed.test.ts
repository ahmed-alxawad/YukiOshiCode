import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { ConfigManaged } from "../../src/config/managed"

describe("systemManagedConfigDirs", () => {
  test("uses the platform's system location for both brand names", () => {
    expect(ConfigManaged.systemManagedConfigDirs("linux")).toEqual(["/etc/opencode", "/etc/yukioshi"])
    expect(ConfigManaged.systemManagedConfigDirs("freebsd")).toEqual(["/etc/opencode", "/etc/yukioshi"])
    expect(ConfigManaged.systemManagedConfigDirs("darwin")).toEqual([
      "/Library/Application Support/opencode",
      "/Library/Application Support/yukioshi",
    ])
  })

  test("windows paths are built from ProgramData", () => {
    const dirs = ConfigManaged.systemManagedConfigDirs("win32", "D:\\PD")
    expect(dirs).toEqual([path.join("D:\\PD", "opencode"), path.join("D:\\PD", "yukioshi")])
  })

  test("the more specific yukioshi directory comes last so it wins when merged in order", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      expect(ConfigManaged.systemManagedConfigDirs(platform, "C:\\ProgramData").at(-1)).toMatch(/yukioshi$/)
    }
  })
})

describe("managedConfigDirs", () => {
  const original = process.env.YUKIOSHI_TEST_MANAGED_CONFIG_DIR
  afterEach(() => {
    if (original === undefined) delete process.env.YUKIOSHI_TEST_MANAGED_CONFIG_DIR
    else process.env.YUKIOSHI_TEST_MANAGED_CONFIG_DIR = original
  })

  test("the test override replaces the system directories", () => {
    process.env.YUKIOSHI_TEST_MANAGED_CONFIG_DIR = "/tmp/managed-override"
    expect(ConfigManaged.managedConfigDirs()).toEqual(["/tmp/managed-override"])
    expect(ConfigManaged.managedConfigDir()).toBe("/tmp/managed-override")
  })

  test("an empty override is ignored", () => {
    process.env.YUKIOSHI_TEST_MANAGED_CONFIG_DIR = ""
    expect(ConfigManaged.managedConfigDirs()).toEqual(ConfigManaged.systemManagedConfigDirs())
  })

  test("without an override managedConfigDir is the last system directory", () => {
    delete process.env.YUKIOSHI_TEST_MANAGED_CONFIG_DIR
    expect(ConfigManaged.managedConfigDir()).toBe(ConfigManaged.systemManagedConfigDirs().at(-1)!)
  })
})

describe("managedPreferencePaths", () => {
  test("lists the per-user path before the machine-wide one for each domain, always with posix separators", () => {
    expect(ConfigManaged.managedPreferencePaths("alice")).toEqual([
      "/Library/Managed Preferences/alice/com.yukioshi.managed.plist",
      "/Library/Managed Preferences/com.yukioshi.managed.plist",
      "/Library/Managed Preferences/alice/ai.opencode.managed.plist",
      "/Library/Managed Preferences/ai.opencode.managed.plist",
    ])
  })
})

describe("parseManagedPlist", () => {
  test("drops MDM metadata keys and keeps real config", () => {
    const out = JSON.parse(
      ConfigManaged.parseManagedPlist(
        JSON.stringify({
          PayloadDisplayName: "x",
          PayloadIdentifier: "x",
          PayloadType: "x",
          PayloadUUID: "x",
          PayloadVersion: 1,
          _manualProfile: true,
          model: "a/b",
          permission: { bash: "deny" },
        }),
      ),
    )
    expect(out).toEqual({ model: "a/b", permission: { bash: "deny" } })
  })

  test("keys that merely look like metadata are kept", () => {
    const out = JSON.parse(ConfigManaged.parseManagedPlist('{"payloadUUID":"lower","PayloadUUIDX":"x"}'))
    expect(out).toEqual({ payloadUUID: "lower", PayloadUUIDX: "x" })
  })

  test("an empty object stays an empty object", () => {
    expect(ConfigManaged.parseManagedPlist("{}")).toBe("{}")
  })

  test("invalid JSON throws instead of yielding a half-trusted config", () => {
    expect(() => ConfigManaged.parseManagedPlist("not json")).toThrow()
    expect(() => ConfigManaged.parseManagedPlist("")).toThrow()
  })
})

describe("readManagedPreferences", () => {
  test("is a no-op outside macOS", async () => {
    if (process.platform === "darwin") return
    expect(await ConfigManaged.readManagedPreferences()).toBeUndefined()
  })
})
