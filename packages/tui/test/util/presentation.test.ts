import { expect, test } from "bun:test"
import { logoArt, renderArt, renderCode, renderWordmark } from "../../src/logo"
import { sessionEpilogue } from "../../src/util/presentation"

const visible = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "")

test("formats session continuation summary", () => {
  const epilogue = sessionEpilogue({ title: "A session", sessionID: "ses_123" })
  expect(epilogue).toContain("A session")
  expect(epilogue).toContain("yukioshi -s ses_123")
  expect(visible(epilogue)).toContain(logoArt.dark.wordmark.lines[0])
  expect(visible(epilogue)).toContain("C O D E")
})

test("both logo variants are traced completely and fit the home layout", () => {
  for (const variant of [logoArt.dark, logoArt.light]) {
    expect(variant.palette.length).toBeGreaterThan(0)
    for (const colour of [...variant.palette, variant.code.text, variant.code.bracket]) {
      expect(colour).toMatch(/^#[0-9a-f]{6}$/)
    }
    for (const art of [variant.emblemLarge, variant.emblemMedium, variant.wordmark]) {
      expect(art.parts).toHaveLength(art.lines.length)
      art.lines.forEach((line, row) => {
        expect(Array.from(line)).toHaveLength(art.parts[row].length)
        // Every part is a palette index or a space.
        for (const part of art.parts[row]) {
          if (part !== " ") expect(Number(part)).toBeLessThan(variant.palette.length)
        }
      })
    }
    expect(variant.emblemLarge.lines).toHaveLength(16)
    expect(variant.emblemMedium.lines).toHaveLength(12)
    // The emblem is traced symmetrically: every row reads the same mirrored left to right.
    for (const art of [variant.emblemLarge, variant.emblemMedium]) {
      const width = Math.max(...art.lines.map((line) => Array.from(line).length))
      const mirror: Record<string, string> = { "▘": "▝", "▝": "▘", "▖": "▗", "▗": "▖", "▌": "▐", "▐": "▌", "▛": "▜", "▜": "▛", "▙": "▟", "▟": "▙", "▞": "▚", "▚": "▞" }
      for (const line of art.lines) {
        const cells = Array.from(line.padEnd(width, " "))
        expect(cells.map((cell) => mirror[cell] ?? cell).reverse().join("")).toBe(cells.join(""))
      }
    }
    expect(variant.wordmark.lines).toHaveLength(5)
    // The home screen switches to plain text below 72 columns.
    expect(Math.max(...variant.wordmark.lines.map((line) => Array.from(line).length))).toBeLessThanOrEqual(72)
  }
})

test("plain logo output has no colour codes and coloured output matches it", () => {
  const plain = renderWordmark({ pad: "  " })
  expect(plain.join("\n")).not.toContain("\x1b[")
  expect(plain.at(-1)).toContain("< /  C O D E  >")
  for (const variant of [logoArt.dark, logoArt.light]) {
    expect(renderArt(variant.wordmark, { color: true, variant }).map(visible)).toEqual(renderArt(variant.wordmark))
    expect(visible(renderCode({ color: true, variant }))).toBe(renderCode({ variant }))
  }
})
