import { describe, expect, test } from "bun:test"
import { KothoraPrompts } from "../../src/session/kothora-prompts"
import { ConfigV1 } from "@yukioshi/core/v1/config/config"
import { ConfigParse } from "../../src/config/parse"
import type { SessionV1 } from "@yukioshi/core/v1/session"

const user = (id: string, parts: SessionV1.Part[]) =>
  ({ info: { id, role: "user" }, parts }) as unknown as SessionV1.WithParts
const text = (value: string, synthetic = false) =>
  ({ type: "text", id: "p", text: value, ...(synthetic ? { synthetic: true } : {}) }) as SessionV1.Part
const bengaliMessage = user("u1", [text("এই ফাংশনটা কীভাবে কাজ করে?")])
const englishMessage = user("u1", [text("How does this function work?")])
const assistant = { info: { id: "a1", role: "assistant" }, parts: [] } as unknown as SessionV1.WithParts

describe("bengali script detection", () => {
  test("detects the Bengali Unicode block U+0980-U+09FF", () => {
    expect(KothoraPrompts.hasBengaliScript("হ্যালো")).toBe(true)
    expect(KothoraPrompts.hasBengaliScript("this is বাংলা")).toBe(true)
  })

  test("latin text, even with accents, is not Bangla", () => {
    expect(KothoraPrompts.hasBengaliScript("hello world")).toBe(false)
    expect(KothoraPrompts.hasBengaliScript("ôndhô")).toBe(false)
    expect(KothoraPrompts.hasBengaliScript("")).toBe(false)
    expect(KothoraPrompts.hasBengaliScript("123 !@#")).toBe(false)
  })
})

describe("learn mode directive", () => {
  test("learning.mode teach adds the teaching directive", () => {
    const out = KothoraPrompts.directives({ learning: { mode: "teach" } }, [englishMessage])
    expect(out).toEqual([KothoraPrompts.TEACH_DIRECTIVE])
    expect(out[0]).toContain("Learn mode is on")
    expect(out[0]).toContain("what you are about to do and why")
  })

  test("learning.mode off or unset adds nothing", () => {
    expect(KothoraPrompts.directives({ learning: { mode: "off" } }, [englishMessage])).toEqual([])
    expect(KothoraPrompts.directives({ learning: {} }, [englishMessage])).toEqual([])
    expect(KothoraPrompts.directives({ learning: { nudges: true } }, [englishMessage])).toEqual([])
  })
})

describe("answer language directive", () => {
  test("each explicit value produces its own directive", () => {
    for (const language of ["english", "bangla", "mixed"] as const) {
      const out = KothoraPrompts.directives({ answers: { language } }, [englishMessage])
      expect(out).toEqual([KothoraPrompts.LANGUAGE_DIRECTIVES[language]])
    }
    expect(KothoraPrompts.LANGUAGE_DIRECTIVES.bangla).toContain("আপনি")
    expect(KothoraPrompts.LANGUAGE_DIRECTIVES.bangla).toContain("Bangla")
    expect(KothoraPrompts.LANGUAGE_DIRECTIVES.mixed).toContain("আপনি")
    expect(KothoraPrompts.LANGUAGE_DIRECTIVES.english).toContain("English")
  })

  test("code and commit messages stay English in every directive", () => {
    for (const directive of Object.values(KothoraPrompts.LANGUAGE_DIRECTIVES)) {
      expect(directive).toContain("commit messages stay English")
    }
  })

  test("unset or empty answers adds nothing", () => {
    expect(KothoraPrompts.directives({ answers: {} }, [englishMessage])).toEqual([])
    expect(KothoraPrompts.languageDirective(undefined, [englishMessage])).toBeUndefined()
  })

  test("auto: a Bengali message switches to the Bangla directive", () => {
    expect(KothoraPrompts.directives({ answers: { language: "auto" } }, [bengaliMessage])).toEqual([
      KothoraPrompts.LANGUAGE_DIRECTIVES.bangla,
    ])
  })

  test("auto: an English message keeps the English directive", () => {
    expect(KothoraPrompts.directives({ answers: { language: "auto" } }, [englishMessage])).toEqual([
      KothoraPrompts.LANGUAGE_DIRECTIVES.english,
    ])
  })

  test("auto: synthetic parts are ignored, the user's own words decide", () => {
    const wrapped = user("u1", [text("The following tool was executed by the user", true), text("আমাকে বাংলায় ব্যাখ্যা করুন")])
    expect(KothoraPrompts.lastUserText([wrapped])).toBe("আমাকে বাংলায় ব্যাখ্যা করুন")
    expect(KothoraPrompts.directives({ answers: { language: "auto" } }, [wrapped])).toEqual([
      KothoraPrompts.LANGUAGE_DIRECTIVES.bangla,
    ])
    const onlySynthetic = user("u2", [text("continue", true)])
    expect(KothoraPrompts.lastUserText([onlySynthetic])).toBe("")
    expect(KothoraPrompts.directives({ answers: { language: "auto" } }, [onlySynthetic])).toEqual([
      KothoraPrompts.LANGUAGE_DIRECTIVES.english,
    ])
  })

  test("auto: the latest user message decides, earlier ones do not", () => {
    const out = KothoraPrompts.directives({ answers: { language: "auto" } }, [
      bengaliMessage,
      assistant,
      englishMessage,
    ])
    expect(out).toEqual([KothoraPrompts.LANGUAGE_DIRECTIVES.english])
  })

  test("auto: no user text falls back to English", () => {
    expect(KothoraPrompts.directives({ answers: { language: "auto" } }, [])).toEqual([
      KothoraPrompts.LANGUAGE_DIRECTIVES.english,
    ])
  })
})

describe("combined", () => {
  test("learn mode and answer language both apply, teach first", () => {
    const out = KothoraPrompts.directives(
      { learning: { mode: "teach" }, answers: { language: "bangla" } },
      [bengaliMessage],
    )
    expect(out).toEqual([KothoraPrompts.TEACH_DIRECTIVE, KothoraPrompts.LANGUAGE_DIRECTIVES.bangla])
  })
})

describe("edition-off safety", () => {
  test("no options configured appends nothing at all", () => {
    expect(KothoraPrompts.directives(undefined, [englishMessage])).toEqual([])
    expect(KothoraPrompts.directives({}, [englishMessage])).toEqual([])
    expect(KothoraPrompts.directives({ learning: {}, answers: {} }, [englishMessage])).toEqual([])
  })
})

describe("config schema", () => {
  test("learning.mode and answers.language parse", () => {
    const parsed = ConfigParse.schema(ConfigV1.Info, { learning: { mode: "teach" }, answers: { language: "auto" } }, "test")
    expect(parsed.learning?.mode).toBe("teach")
    expect(parsed.answers?.language).toBe("auto")
    const off = ConfigParse.schema(ConfigV1.Info, { learning: { mode: "off" }, answers: { language: "mixed" } }, "test")
    expect(off.learning?.mode).toBe("off")
    expect(off.answers?.language).toBe("mixed")
  })

  test("unknown mode and language values are rejected", () => {
    expect(() => ConfigParse.schema(ConfigV1.Info, { learning: { mode: "always" } }, "test")).toThrow()
    expect(() => ConfigParse.schema(ConfigV1.Info, { answers: { language: "klingon" } }, "test")).toThrow()
  })
})
