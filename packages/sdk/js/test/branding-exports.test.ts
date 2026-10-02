import { expect, test } from "bun:test"
import {
  createYukiOshi,
  createOpencode,
  createYukiOshiClient,
  createOpencodeClient,
  createYukiOshiServer,
  createOpencodeServer,
  createYukiOshiTui,
  createOpencodeTui,
  YukiOshiClient,
  OpencodeClient,
} from "../src"
import * as v2 from "../src/v2"

test("SDK exports YukiOshi names with backward-compatible aliases", () => {
  expect(createYukiOshi).toBe(createOpencode)
  expect(createYukiOshiClient).toBe(createOpencodeClient)
  expect(createYukiOshiServer).toBe(createOpencodeServer)
  expect(createYukiOshiTui).toBe(createOpencodeTui)
  expect(YukiOshiClient).toBe(OpencodeClient)

  expect(v2.createYukiOshi).toBe(v2.createOpencode)
  expect(v2.createYukiOshiClient).toBe(v2.createOpencodeClient)
  expect(v2.createYukiOshiServer).toBe(v2.createOpencodeServer)
  expect(v2.createYukiOshiTui).toBe(v2.createOpencodeTui)
  expect(v2.YukiOshiClient).toBe(v2.OpencodeClient)
})
