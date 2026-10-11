import { expect, test } from "bun:test"
import { modelsCatalogOrigin, modelsCatalogUrl } from "../vite.config"

test("uses models.dev for the default catalog and provider logotypes", () => {
  expect(modelsCatalogUrl()).toBe("https://models.dev/api.json")
  expect(modelsCatalogOrigin()).toBe("https://models.dev")
})

test("accepts a base URL override for the catalog and provider logotypes", () => {
  const source = "https://catalog.example.test"

  expect(modelsCatalogUrl(source)).toBe("https://catalog.example.test/api.json")
  expect(modelsCatalogOrigin(source)).toBe("https://catalog.example.test")
})

test("accepts a full API URL override without duplicating its path", () => {
  const source = "https://catalog.example.test/api.json"

  expect(modelsCatalogUrl(source)).toBe(source)
  expect(modelsCatalogOrigin(source)).toBe("https://catalog.example.test")
})
