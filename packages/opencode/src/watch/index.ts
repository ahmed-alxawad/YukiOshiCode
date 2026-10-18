// Watch mode: comment lines ending in `AI!` (do it) or `AI?` (answer) become runs.
// Pure helpers live here so the command stays small and the parsing is testable.

export type Kind = "do" | "ask"
export type Trigger = { line: number; kind: Kind; text: string; raw: string }

const OPEN = /^(\s*)(\/\/+|#+|--+|\/\*+|<!--)\s?(.*)$/
const CLOSE = /\s*(\*\/|-->)\s*$/

/** Comment-only lines (slash-slash, hash, double dash, c-style block, html comment) whose text ends in AI! or AI?. */
export function findTriggers(content: string): Trigger[] {
  const result: Trigger[] = []
  content.split("\n").forEach((raw, index) => {
    const match = OPEN.exec(raw.replace(/\r$/, ""))
    if (!match) return
    const body = match[3].replace(CLOSE, "").trimEnd()
    const marker = /(?:^|\s)AI([!?])$/.exec(body)
    if (!marker) return
    const text = body.replace(/\s*AI[!?]$/, "").trim()
    result.push({ line: index + 1, kind: marker[1] === "!" ? "do" : "ask", text, raw })
  })
  return result
}

/** Removes the trailing marker from the line that still holds `raw` (the file may have shifted during the run). */
export function removeMarker(content: string, trigger: Trigger, answer?: string): string | undefined {
  const lines = content.split("\n")
  const stripped = trigger.raw.replace(/\s*AI[!?](\s*(\*\/|-->))?\s*$/, (_m, close) => (close ? " " + close.trim() : ""))
  const near = [trigger.line - 1, ...lines.keys()]
  const index = near.find((i) => lines[i] === trigger.raw)
  if (index === undefined) return undefined
  lines[index] = stripped.trimEnd()
  if (answer) lines.splice(index + 1, 0, ...commentLines(trigger.raw, answer))
  return lines.join("\n")
}

/** Answer text as comment lines in the same style and indentation as the trigger line. */
export function commentLines(raw: string, answer: string): string[] {
  const match = OPEN.exec(raw)!
  const indent = match[1]
  const open = match[2]
  const style = open.startsWith("/*") ? ["/* ", " */"] : open === "<!--" ? ["<!-- ", " -->"] : [open + " ", ""]
  return answer
    .trim()
    .split("\n")
    .map((line) => line.trimEnd().replace(/\s*AI[!?]$/, "").replaceAll("*/", "* /").replaceAll("-->", "-- >"))
    .map((line) => `${indent}${style[0]}${line}${style[1]}`.trimEnd())
}

export function promptFor(file: string, trigger: Trigger) {
  if (trigger.kind === "ask")
    return `A comment in ${file} at line ${trigger.line} asks a question: "${trigger.text}". Read the file and answer it briefly in plain text. Do not modify any files; the answer will be written as a comment below the question.`
  return `A comment in ${file} at line ${trigger.line} asks for a change: "${trigger.text}". Make that change in the repository. Leave the comment line itself alone; it is cleaned up afterwards.`
}
