import { describe, expect, test } from "bun:test"
import { resolve } from "@yukioshi/core/edition"
import * as Mode from "../../src/agent/mode"
import { accountMode, LEARN_REMINDER, parseLanguage, reminders, resolveLanguage } from "../../src/kothora/tutor"

const yukioshi = resolve("yukioshi", undefined)
const kothora = resolve("kothora", undefined)
const learn = { name: "learn", native: true }

describe("kothora edition: Learn mode prompt", () => {
  test("the Learn mode text is added only in the Kothora edition, only for the native learn agent", () => {
    expect(reminders({ edition: kothora, agent: learn, language: "en" })[0]).toBe(LEARN_REMINDER)
    expect(reminders({ edition: yukioshi, agent: learn, language: "en" })).toEqual([])
    expect(reminders({ edition: kothora, agent: { name: "build", native: true }, language: "en" })).not.toContain(LEARN_REMINDER)
    // A user's own agent that happens to be called "learn" is not the mode.
    expect(reminders({ edition: kothora, agent: { name: "learn", native: false }, language: "en" })).not.toContain(LEARN_REMINDER)
  })

  test("it asks for the behaviours of the brief", () => {
    const text = LEARN_REMINDER.toLowerCase()
    expect(text).toContain("explain each step and why")
    expect(text).toContain("try first")
    expect(text).toContain("hints before code")
    expect(text).toContain("only after the student has tried")
    expect(text).toContain("never edit or create a file silently")
  })

  test("the mode is in Tab order only in the Kothora edition, and Auto never picks it", () => {
    expect(Mode.orderFor(yukioshi)).toEqual(["build", "plan", "goal", "reasoning", "research", "auto"])
    expect(Mode.orderFor(kothora)).toEqual(["build", "plan", "goal", "reasoning", "research", "learn", "auto"])
    expect(Mode.MODES as readonly string[]).not.toContain("learn")
    expect(Mode.guess("learn mode: explain loops")).not.toBe("learn")
  })
})

describe("kothora edition: explanation language", () => {
  test("the config setting wins, then the account answer mode, then English", () => {
    expect(resolveLanguage({})).toBe("en")
    expect(resolveLanguage({ account: "bn" })).toBe("bn")
    expect(resolveLanguage({ account: "Mixed" })).toBe("mixed")
    expect(resolveLanguage({ account: "bn", configured: "en" })).toBe("en")
    expect(resolveLanguage({ account: "en", configured: "auto" })).toBe("auto")
  })

  test("account names such as Bangla and English are understood; anything else falls back to English", () => {
    expect(parseLanguage("Bangla")).toBe("bn")
    expect(parseLanguage("English")).toBe("en")
    expect(parseLanguage("auto")).toBe("auto")
    expect(resolveLanguage({ account: "klingon" })).toBe("en")
    expect(resolveLanguage({ account: 5, configured: "xx" })).toBe("en")
  })

  test("the text keeps code English and asks for polite Bangla", () => {
    for (const language of ["en", "bn", "mixed", "auto"] as const) {
      const [text] = reminders({ edition: kothora, agent: { name: "build", native: true }, language })
      expect(text).toContain("commit messages")
      expect(text).toContain("tool calls")
    }
    const [bn] = reminders({ edition: kothora, agent: { name: "build", native: true }, language: "bn" })
    expect(bn).toContain("আপনি")
    expect(bn).toContain("interface itself stays English")
  })

  test("it is added for every visible agent in the Kothora edition and nowhere in the yukioshi edition", () => {
    expect(reminders({ edition: kothora, agent: { name: "build", native: true }, language: "bn" })).toHaveLength(1)
    expect(reminders({ edition: kothora, agent: learn, language: "bn" })).toHaveLength(2)
    expect(reminders({ edition: kothora, agent: { name: "title", native: true, hidden: true }, language: "bn" })).toEqual([])
    expect(reminders({ edition: yukioshi, agent: { name: "build", native: true }, language: "bn" })).toEqual([])
  })
})

describe("kothora edition: account answer mode lookup", () => {
  test("it asks once and keeps the answer until it expires", async () => {
    let calls = 0
    let clock = 0
    const mode = accountMode(async () => ({ answer_mode: (++calls, "bn") }), { now: () => clock, ttlMs: 1000 })
    expect(await mode()).toBe("bn")
    expect(await mode()).toBe("bn")
    expect(calls).toBe(1)
    clock = 1001
    await mode()
    expect(calls).toBe(2)
  })

  test("when the call fails the default applies, and it is tried again soon", async () => {
    let calls = 0
    let clock = 0
    const mode = accountMode(
      async () => {
        calls++
        if (calls === 1) throw new Error("offline")
        return { answer_mode: "mixed" }
      },
      { now: () => clock, failureTtlMs: 100 },
    )
    expect(resolveLanguage({ account: await mode() })).toBe("en")
    expect(await mode()).toBeUndefined()
    expect(calls).toBe(1)
    clock = 101
    expect(await mode()).toBe("mixed")
  })

  test("an account that sends no answer mode gives English", async () => {
    expect(resolveLanguage({ account: await accountMode(async () => ({}))() })).toBe("en")
  })
})
