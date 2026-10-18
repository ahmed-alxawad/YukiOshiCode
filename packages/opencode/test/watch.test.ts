import { expect, test } from "bun:test"
import { commentLines, findTriggers, removeMarker } from "../src/watch"

test("detects every comment style and ignores code", () => {
  const src = ["// a AI!", "# b AI?", "-- c AI!", "/* d AI! */", "<!-- e AI? -->", "const x = 1 // f AI!", "// plain", "// notAI!"].join("\n")
  expect(findTriggers(src).map((t) => [t.line, t.kind, t.text])).toEqual([
    [1, "do", "a"], [2, "ask", "b"], [3, "do", "c"], [4, "do", "d"], [5, "ask", "e"],
  ])
})

test("removes the marker and writes the answer below in the same style", () => {
  const [t] = findTriggers("  /* why? AI? */\nx")
  expect(removeMarker("  /* why? AI? */\nx", t, "because")).toBe("  /* why? */\n  /* because */\nx")
  expect(commentLines("# q AI?", "a\nb")).toEqual(["# a", "# b"])
})
