import type { Info as EditionInfo } from "@yukioshi/core/edition"
import LEARN from "./prompt/learn.txt"
import LANGUAGE_EN from "./prompt/language-en.txt"
import LANGUAGE_BN from "./prompt/language-bn.txt"
import LANGUAGE_MIXED from "./prompt/language-mixed.txt"
import LANGUAGE_AUTO from "./prompt/language-auto.txt"

/** The agent's explanation language: the same four choices as the Kothora account's answer mode. */
export type Language = "en" | "bn" | "mixed" | "auto"

export const LANGUAGES: readonly Language[] = ["en", "bn", "mixed", "auto"]

export const DEFAULT_LANGUAGE: Language = "en"

const REMINDERS: Record<Language, string> = { en: LANGUAGE_EN, bn: LANGUAGE_BN, mixed: LANGUAGE_MIXED, auto: LANGUAGE_AUTO }

/** The Learn mode text, added to a message when the Learn agent runs. */
export const LEARN_REMINDER = LEARN

const NAMES: Record<string, Language> = {
  en: "en",
  english: "en",
  bn: "bn",
  bangla: "bn",
  bengali: "bn",
  mixed: "mixed",
  auto: "auto",
}

/** Reads a language name from config or from the account answer. Anything unknown is not a language. */
export function parseLanguage(value: unknown): Language | undefined {
  if (typeof value !== "string") return undefined
  return NAMES[value.trim().toLowerCase()]
}

/**
 * The explanation language: the `explanationLanguage` setting wins, then the account's answer mode
 * (the `answer_mode` field of GET /code/me, when the API sends it), then English.
 */
export function resolveLanguage(input: { configured?: unknown; account?: unknown }): Language {
  return parseLanguage(input.configured) ?? parseLanguage(input.account) ?? DEFAULT_LANGUAGE
}

/** The extra text for a user message, in order: the Learn mode text, then the language text. Empty outside Kothora. */
export function reminders(input: { edition: Pick<EditionInfo, "learnMode" | "explanationLanguage">; agent: { name: string; native?: boolean; hidden?: boolean }; language: Language }) {
  const result: string[] = []
  if (input.edition.learnMode && input.agent.native && input.agent.name === "learn") result.push(LEARN_REMINDER)
  // Hidden agents (title, summary, router) never talk to the student.
  if (input.edition.explanationLanguage && !input.agent.hidden) result.push(REMINDERS[input.language])
  return result
}

/** Asks for the account's answer mode and keeps the answer for a while; a failed call is remembered briefly. */
export function accountMode(
  fetchMe: () => Promise<{ answer_mode?: unknown }>,
  options: { now?: () => number; ttlMs?: number; failureTtlMs?: number } = {},
) {
  const now = options.now ?? Date.now
  const ttl = options.ttlMs ?? 10 * 60_000
  const failureTtl = options.failureTtlMs ?? 60_000
  let cached: { value: unknown; until: number } | undefined
  return async (): Promise<unknown> => {
    if (cached && cached.until > now()) return cached.value
    try {
      const value = (await fetchMe()).answer_mode
      cached = { value, until: now() + ttl }
      return value
    } catch {
      // Offline or signed out: explain in the default language, and try again soon.
      cached = { value: undefined, until: now() + failureTtl }
      return undefined
    }
  }
}
