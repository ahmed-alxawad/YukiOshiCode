import { expect, test } from "bun:test"
import { modelsCatalogUrl } from "../vite.config"

test("uses the models.dev API catalog by default", () => {
  expect(modelsCatalogUrl()).toBe("https://models.dev/api.json")
})

test("keeps YUKIOSHI_MODELS_URL as a base URL override", () => {
  expect(modelsCatalogUrl("https://catalog.example.test")).toBe("https://catalog.example.test/api.json")
})
