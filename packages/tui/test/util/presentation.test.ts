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
    const art = variant.wordmark
    expect(art.parts).toHaveLength(art.lines.length)
    art.lines.forEach((line, row) => {
      expect(Array.from(line)).toHaveLength(art.parts[row].length)
      // Every part is a palette index or a space.
      for (const part of art.parts[row]) {
        if (part !== " ") expect(Number(part)).toBeLessThan(variant.palette.length)
      }
    })
    for (const emblem of [variant.emblemLarge, variant.emblemMedium]) {
      expect(emblem.fg).toHaveLength(emblem.lines.length)
      expect(emblem.bg).toHaveLength(emblem.lines.length)
      emblem.lines.forEach((line, row) => {
        const cells = Array.from(line).length
        // One foreground and one background entry per character; empty means none.
        const fg = emblem.fg[row].split(" ")
        const bg = emblem.bg[row].split(" ")
        expect(fg).toHaveLength(cells)
        expect(bg).toHaveLength(cells)
        for (const colour of [...fg, ...bg]) expect(colour).toMatch(/^([0-9a-f]{6})?$/)
        Array.from(line).forEach((char, index) => {
          if (char !== " ") expect(fg[index]).not.toBe("")
        })
      })
    }
    expect(variant.emblemLarge.lines).toHaveLength(16)
    expect(variant.emblemMedium.lines).toHaveLength(12)
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
