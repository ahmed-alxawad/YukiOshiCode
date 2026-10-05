import { describe, expect, test } from "bun:test"
import { lazyValues } from "../../src/provider/provider"

describe("lazyValues", () => {
  test("builds each value once, on first read, and lists keys without building", () => {
    const built: string[] = []
    const out = lazyValues({ a: 1, b: 2, c: 3 } as Record<string, number>, (value) => {
      built.push(String(value))
      return value * 10
    })
    expect(Object.keys(out)).toEqual(["a", "b", "c"])
    expect("b" in out).toBe(true)
    expect(built).toEqual([])
    expect(out.b).toBe(20)
    expect(out.b).toBe(20)
    expect(built).toEqual(["2"])
  })

  test("assigning replaces a value, deleting removes it, and entries build the rest", () => {
    const out = lazyValues({ a: 1, b: 2 } as Record<string, number>, (value) => value + 100)
    out.a = 5
    out.z = 9
    delete out.b
    expect(out).toEqual({ a: 5, z: 9 })
    expect(Object.entries(lazyValues({ x: 1 } as Record<string, number>, (v) => v * 2))).toEqual([["x", 2]])
  })
})
