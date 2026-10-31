// Kothora B14 "Learn mode and Bangla": two config-gated system-prompt directives.
//
// - learning.mode: "teach" switches the agent from just doing to teaching — it explains what it
//   is doing and why, one step at a time, and checks understanding before big changes.
// - answers.language: english | bangla | mixed | auto controls the language of the explanations
//   the agent writes to the user. In every mode code, identifiers and commit messages stay
//   English, and the interface stays English; only the explanation prose changes language.
//
// Both options default to off. When neither is set, directives() returns [] and the system
// prompt is byte-for-byte what it was before this module existed (the edition-off safety).

import type { SessionV1 } from "@yukioshi/core/v1/session"
import type { ConfigV1 } from "@yukioshi/core/v1/config/config"

/** The Bengali Unicode block: any character in U+0980–U+09FF marks text as Bangla. */
const BENGALI = /[\u0980-\u09FF]/

export function hasBengaliScript(text: string): boolean {
  return BENGALI.test(text)
}

export const TEACH_DIRECTIVE =
  "Learn mode is on. Teach while you work: before each change, say in a sentence or two what you " +
  "are about to do and why it is the right step, one step at a time. Check that the user follows " +
  "you before large or hard-to-undo changes, and answer questions as they come up. Never present " +
  "unexplained code: every block you write or edit carries a short explanation of how it works. " +
  "Keep the teaching brief — the work still gets done, it is just narrated."

const KEEP_ENGLISH =
  "Code, identifiers, commands, file paths and commit messages stay English, and the interface stays English."

/** Directive per explicit language. `auto` resolves to one of these from the user's message. */
export const LANGUAGE_DIRECTIVES = {
  english: "Write all explanations to the user in English. " + KEEP_ENGLISH,
  bangla:
    "Write your explanations to the user in Bangla (Bengali), always in the polite আপনি form " +
    "(never the familiar তুই/তুমি register). " +
    KEEP_ENGLISH,
  mixed:
    "Write your explanations to the user in Bangla (polite আপনি form) and keep technical terms in " +
    "English inline where the Bangla word would be unusual, for example \"এই function টা async, তাই " +
    "promise return করে\". " +
    KEEP_ENGLISH,
} as const

export type AnswerLanguage = keyof typeof LANGUAGE_DIRECTIVES

/** The last user message's own words: non-synthetic text parts, most recent user message first. */
export function lastUserText(messages: readonly SessionV1.WithParts[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.info.role !== "user") continue
    const text = msg.parts
      .flatMap((part) => (part.type === "text" && !part.synthetic ? [part.text] : []))
      .join("\n")
      .trim()
    if (text) return text
  }
  return ""
}

/**
 * The directive for an answers.language setting: one per explicit value, with `auto` resolved by
 * detecting Bengali script in the user's latest message (Bangla when present, English otherwise).
 * Unset yields nothing.
 */
export function languageDirective(
  language: string | undefined,
  messages: readonly SessionV1.WithParts[],
): string | undefined {
  switch (language) {
    case "english":
      return LANGUAGE_DIRECTIVES.english
    case "bangla":
      return LANGUAGE_DIRECTIVES.bangla
    case "mixed":
      return LANGUAGE_DIRECTIVES.mixed
    case "auto":
      return hasBengaliScript(lastUserText(messages)) ? LANGUAGE_DIRECTIVES.bangla : LANGUAGE_DIRECTIVES.english
    default:
      return undefined
  }
}

/**
 * The Kothora system-prompt directives for a config and the session's messages, in the order they
 * are appended: Learn mode first, then the answer language. Empty when both options are unset or
 * off, so the prompt is unchanged.
 */
export function directives(
  config: ConfigV1.Info | undefined,
  messages: readonly SessionV1.WithParts[],
): string[] {
  const out: string[] = []
  if (config?.learning?.mode === "teach") out.push(TEACH_DIRECTIVE)
  const language = languageDirective(config?.answers?.language, messages)
  if (language) out.push(language)
  return out
}

export * as KothoraPrompts from "./kothora-prompts"
