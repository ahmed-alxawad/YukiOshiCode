import { logoArt, type LogoArt, type LogoVariant } from "./logo-art"

export { logoArt, type LogoArt, type LogoVariant } from "./logo-art"

const reset = "\x1b[0m"

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

// Plain terminal output can't tell a light background from a dark one, so it uses the dark
// logo with its white parts in the terminal's default foreground (bold): visible either way.
function ansi(hex: string) {
  if (luminance(hex) > 0.85) return "\x1b[1m"
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  return `\x1b[38;2;${r};${g};${b}m`
}

type RenderOptions = { pad?: string; color?: boolean; variant?: LogoVariant }

/** Renders traced logo art for plain terminal output, with or without colour. */
export function renderArt(art: LogoArt, options: RenderOptions = {}): string[] {
  const pad = options.pad ?? ""
  const palette = (options.variant ?? logoArt.dark).palette
  return art.lines.map((line, row) => {
    if (!options.color) return pad + line
    const parts = art.parts[row] ?? ""
    let out = pad
    let current = ""
    for (const [index, char] of Array.from(line).entries()) {
      const part = char === " " ? " " : (parts[index] ?? "0")
      if (part !== current) {
        if (current && current !== " ") out += reset
        if (part !== " ") out += ansi(palette[Number(part)] ?? palette[0])
        current = part
      }
      out += char
    }
    return out + (current && current !== " " ? reset : "")
  })
}

/** The "< / CODE >" line under the wordmark, centred under it. */
export function renderCode(options: RenderOptions = {}): string {
  const variant = options.variant ?? logoArt.dark
  const text = "< /  C O D E  >"
  const width = Math.max(...variant.wordmark.lines.map((line) => Array.from(line).length))
  const indent = (options.pad ?? "") + " ".repeat(Math.max(0, Math.floor((width - text.length) / 2)))
  if (!options.color) return indent + text
  const bracket = `${ansi(variant.code.bracket)}\x1b[1m`
  const letters = `${ansi(variant.code.text)}\x1b[1m`
  return `${indent}${bracket}< /  ${reset}${letters}C O D E${reset}${bracket}  >${reset}`
}

/** Wordmark plus the CODE line, for CLI banners. */
export function renderWordmark(options: RenderOptions = {}): string[] {
  const variant = options.variant ?? logoArt.dark
  return [...renderArt(variant.wordmark, { ...options, variant }), renderCode({ ...options, variant })]
}

export const go = {
  left: ["    ", "█▀▀▀", "█_^█", "▀▀▀▀"],
  right: ["    ", "█▀▀█", "█__█", "▀▀▀▀"],
}

export const marks = "_^~,"
