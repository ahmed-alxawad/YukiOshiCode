import { wordmark, type LogoArt } from "./logo-art"

export { emblemLarge, emblemMedium, wordmark, type LogoArt, type LogoPart } from "./logo-art"

const reset = "\x1b[0m"
// White parts use the terminal's default foreground (bold) so they stay visible on light and
// dark terminals; the blues are YukiOshi's brand sky and ice blue.
const ansi: Record<string, string> = {
  w: "\x1b[1m",
  i: "\x1b[38;2;159;224;242m",
  b: "\x1b[38;2;92;184;245m",
}

/** Renders traced logo art for plain terminal output, with or without colour. */
export function renderArt(art: LogoArt, options: { pad?: string; color?: boolean } = {}): string[] {
  const pad = options.pad ?? ""
  return art.lines.map((line, row) => {
    if (!options.color) return pad + line
    const parts = art.parts[row] ?? ""
    let out = pad
    let current = ""
    for (const [index, char] of Array.from(line).entries()) {
      const part = char === " " ? " " : (parts[index] ?? "w")
      if (part !== current) {
        if (current && current !== " ") out += reset
        if (part !== " ") out += ansi[part]
        current = part
      }
      out += char
    }
    return out + (current && current !== " " ? reset : "")
  })
}

/** The "< / C O D E >" line under the wordmark, centred under it. */
export function renderCode(options: { pad?: string; color?: boolean } = {}): string {
  const text = "< /  C O D E  >"
  const width = Math.max(...wordmark.lines.map((line) => Array.from(line).length))
  const indent = (options.pad ?? "") + " ".repeat(Math.max(0, Math.floor((width - text.length) / 2)))
  if (!options.color) return indent + text
  return `${indent}${ansi.b}\x1b[1m< /  ${reset}\x1b[1mC O D E${reset}${ansi.b}\x1b[1m  >${reset}`
}

/** Wordmark plus the CODE line, for CLI banners. */
export function renderWordmark(options: { pad?: string; color?: boolean } = {}): string[] {
  return [...renderArt(wordmark, options), renderCode(options)]
}

export const go = {
  left: ["    ", "█▀▀▀", "█_^█", "▀▀▀▀"],
  right: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
}

export const marks = "_^~,"
