import { describe, expect, test } from "bun:test"
import { sortModelOptions } from "../../../../src/component/dialog-model"

describe("sortModelOptions", () => {
  test("orders model choices newest release first, then by name", () => {
    const sorted = sortModelOptions([
      { title: "GPT 5.2", releaseDate: "2025-12-11" },
      { title: "GPT 5.4", releaseDate: "2026-03-05" },
      { title: "GPT 5.1", releaseDate: "2025-11-13" },
      { title: "Alpha 5.4", releaseDate: "2026-03-05" },
    ])

    expect(sorted.map((model) => model.title)).toEqual(["Alpha 5.4", "GPT 5.4", "GPT 5.2", "GPT 5.1"])
  })
})
