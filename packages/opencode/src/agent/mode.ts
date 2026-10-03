// The primary modes the user switches between with Tab, in that order. "auto" picks one of the
// others for each message.
export const AUTO = "auto"
export const MODES = ["build", "plan", "goal", "reasoning", "research"] as const
export type Mode = (typeof MODES)[number]
export const ORDER: readonly string[] = [...MODES, AUTO]

function isMode(value: string): value is Mode {
  return (MODES as readonly string[]).includes(value)
}

/** The mode a message asks for by name ("use research mode: …"), if any. */
export function named(text: string): Mode | undefined {
  const name = text.toLowerCase().match(/\b(build|plan|goal|reasoning|research) mode\b/)?.[1]
  return name && isMode(name) ? name : undefined
}

/**
 * Reads the router model's answer: a bare mode name, or else the last mode name it mentions
 * (models put their conclusion last: "not research, it is build").
 */
export function parse(text: string): Mode | undefined {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim().toLowerCase()
  const bare = cleaned.replace(/[^a-z]/g, "")
  if (isMode(bare)) return bare
  return cleaned.match(/\b(build|plan|goal|reasoning|research)\b/g)?.at(-1) as Mode | undefined
}

/** Picks a mode from the message's wording; used when the router model is unavailable. */
export function guess(text: string): Mode {
  const message = text.trim().toLowerCase()
  const asked = named(message)
  if (asked) return asked
  if (/^(plan|design|outline|propose)\b|\b(make|write|create|draft) (a|an|the) plan\b|\bhow should (i|we) (approach|structure|design)\b/.test(message))
    return "plan"
  if (/\b(end[ -]to[ -]end|until (it|they|all|every)|keep going|all (the )?tests pass|every test|migrate|the whole|the entire|from scratch)\b/.test(message))
    return "goal"
  // A request to change something is Build, even when it also asks to explain or investigate.
  if (/\b(fix|implement|add|refactor|update|remove|rename|delete|write|create|change|edit|install|bump)\b/.test(message))
    return "build"
  if (/\b(research|investigate|look up|find out|search the web|latest version|what are the options)\b/.test(message))
    return "research"
  if (/^(why|explain|how does|how do|what happens|is it possible)\b|\b(explain|analy[sz]e|reason about|think through|trade-?offs?|prove)\b/.test(message))
    return "reasoning"
  return "build"
}
