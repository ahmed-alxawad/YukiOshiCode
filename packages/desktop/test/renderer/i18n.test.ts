import { describe, expect, test } from "bun:test"
import { catalogs, interpolate, locales, messageKeys, selectLocale, translate } from "../../src/renderer/i18n"

describe("desktop renderer localization", () => {
  test("each locale has every message with non-empty text", () => {
    for (const locale of locales) {
      expect(Object.keys(catalogs[locale]).sort()).toEqual([...messageKeys].sort())
      for (const key of messageKeys) expect(catalogs[locale][key].trim().length).toBeGreaterThan(0)
    }
  })

  test("uses English by default and for unsupported locales", () => {
    expect(selectLocale()).toBe("en")
    expect(selectLocale(null)).toBe("en")
    expect(selectLocale("fr-FR")).toBe("en")
    expect(selectLocale(" EN-us ")).toBe("en")
  })

  test("recognizes Bangla locale tags", () => {
    expect(selectLocale("bn")).toBe("bn")
    expect(selectLocale("bn-BD")).toBe("bn")
    expect(selectLocale("BN_bd")).toBe("bn")
  })

  test("interpolates values without interpreting markup", () => {
    const untrusted = "<img src=x onerror=alert(1)>"
    expect(translate("en", "errorStatus", { message: untrusted })).toBe(`Error: ${untrusted}`)
    expect(translate("bn", "fileHeading", { path: "src/app.ts" })).toBe("ফাইল: src/app.ts")
  })

  test("retains unknown and missing placeholders as plain text", () => {
    expect(interpolate("{known} {missing}", { known: 7 })).toBe("7 {missing}")
    expect(interpolate("Value: {constructor}", {})).toBe("Value: {constructor}")
  })
})
