import { expect, test } from "bun:test"
import { providerTimeoutDefaults, resolveTimeouts } from "@/provider/provider"

test("google and vertex default to 180000", () => {
  expect(providerTimeoutDefaults("google")).toEqual({ headerTimeout: 180000, chunkTimeout: 180000 })
  expect(providerTimeoutDefaults("google-vertex")).toEqual({ headerTimeout: 180000, chunkTimeout: 180000 })
})
test("other providers stay 60000", () => {
  expect(providerTimeoutDefaults("openai")).toEqual({ headerTimeout: 60000, chunkTimeout: 60000 })
})
test("user option wins over the default", () => {
  expect(resolveTimeouts("google", { chunkTimeout: 5000, headerTimeout: false })).toEqual({ chunkTimeout: 5000, headerTimeout: false })
  expect(resolveTimeouts("google", {})).toEqual({ chunkTimeout: 180000, headerTimeout: 180000 })
})
