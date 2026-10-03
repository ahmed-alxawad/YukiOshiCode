import { expect, test } from "bun:test"
import { emblemLarge, emblemMedium, renderArt, renderCode, renderWordmark, wordmark } from "../../src/logo"
import { sessionEpilogue } from "../../src/util/presentation"

const visible = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "")

test("formats session continuation summary", () => {
  const epilogue = sessionEpilogue({ title: "A session", sessionID: "ses_123" })
  expect(epilogue).toContain("A session")
  expect(epilogue).toContain("yukioshi -s ses_123")
  expect(visible(epilogue)).toContain(wordmark.lines[0])
  expect(visible(epilogue)).toContain("C O D E")
})

test("traced logo art has a part for every character and fits the home layout", () => {
  for (const art of [emblemLarge, emblemMedium, wordmark]) {
    expect(art.parts).toHaveLength(art.lines.length)
    art.lines.forEach((line, row) => {
      expect(Array.from(line)).toHaveLength(art.parts[row].length)
      expect(art.parts[row]).toMatch(/^[wib ]*$/)
    })
  }
  expect(emblemLarge.lines).toHaveLength(12)
  expect(emblemMedium.lines).toHaveLength(10)
  expect(wordmark.lines).toHaveLength(5)
  // The home screen switches to plain text below 72 columns.
  expect(Math.max(...wordmark.lines.map((line) => Array.from(line).length))).toBeLessThanOrEqual(72)
})

test("plain logo output has no colour codes and coloured output matches it", () => {
  const plain = renderWordmark({ pad: "  " })
  expect(plain.join("\n")).not.toContain("\x1b[")
  expect(plain.at(-1)).toContain("< /  C O D E  >")
  expect(renderArt(wordmark, { color: true }).map(visible)).toEqual(renderArt(wordmark))
  expect(visible(renderCode({ color: true }))).toBe(renderCode())
})
