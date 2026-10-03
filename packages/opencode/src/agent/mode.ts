// The primary modes the user switches between with Tab, in that order. "auto" picks one of the
// others for each message.
export const AUTO = "auto"
export const MODES = ["build", "plan", "goal", "reasoning", "research"] as const
export type Mode = (typeof MODES)[number]
export const ORDER: readonly string[] = [...MODES, AUTO]

function isMode(value: string): value is Mode {
  return (MODES as readonly string[]).includes(value)
}

/** Reads the router model's answer: the first mode name it mentions. */
export function parse(text: string): Mode | undefined {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").toLowerCase()
  return cleaned.match(/\b(build|plan|goal|reasoning|research)\b/)?.[1] as Mode | undefined
}

/** Picks a mode from the message's wording; used when the router model is unavailable. */
export function guess(text: string): Mode {
  const message = text.trim().toLowerCase()
  const named = message.match(/\b(build|plan|goal|reasoning|research) mode\b/)?.[1]
  if (named && isMode(named)) return named
  if (/^(plan|design|outline|propose)\b|\b(make|write|create|draft) (a|an|the) plan\b|\bhow should (i|we) (approach|structure|design)\b/.test(message))
    return "plan"
  if (/\b(research|investigate|look up|find out|search the web|latest version|what are the options)\b/.test(message))
    return "research"
  if (/^(why|explain|how does|how do|what happens|is it possible)\b|\b(explain|analy[sz]e|reason about|think through|trade-?offs?|prove)\b/.test(message))
    return "reasoning"
  if (/\b(end[ -]to[ -]end|until (it|they|all|every)|keep going|all (the )?tests pass|every test|migrate|the whole|the entire|from scratch)\b/.test(message))
    return "goal"
  return "build"
}
