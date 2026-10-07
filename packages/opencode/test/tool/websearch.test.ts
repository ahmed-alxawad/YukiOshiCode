import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { parseResponse } from "../../src/tool/mcp-websearch"
import { selectWebSearchProvider, webSearchProviderLabel } from "../../src/tool/websearch"

import { webSearchEnabled } from "../../src/tool/registry"
import { it } from "../lib/effect"

describe("websearch provider", () => {
  test("uses Exa unless something else is chosen", () => {
    expect(selectWebSearchProvider()).toBe("exa")
  })

  test("uses the provider chosen in the config", () => {
    expect(selectWebSearchProvider({ configured: "parallel" })).toBe("parallel")
    expect(selectWebSearchProvider({ configured: "exa", parallel: true })).toBe("exa")
  })

  test("supports an operational override", () => {
    const original = process.env.YUKIOSHI_WEBSEARCH_PROVIDER

    try {
      process.env.YUKIOSHI_WEBSEARCH_PROVIDER = "parallel"
      expect(selectWebSearchProvider({ configured: "exa" })).toBe("parallel")

      process.env.YUKIOSHI_WEBSEARCH_PROVIDER = "exa"
      expect(selectWebSearchProvider({ parallel: true })).toBe("exa")
    } finally {
      if (original === undefined) delete process.env.YUKIOSHI_WEBSEARCH_PROVIDER
      else process.env.YUKIOSHI_WEBSEARCH_PROVIDER = original
    }
  })

  test("routes to Parallel when the Parallel flag is enabled", () => {
    expect(selectWebSearchProvider({ parallel: true })).toBe("parallel")
  })

  test("is enabled only by the config or an explicit Exa or Parallel switch", () => {
    expect(webSearchEnabled({})).toBe(false)
    expect(webSearchEnabled({ configured: false, exa: false, parallel: false })).toBe(false)
    expect(webSearchEnabled({ configured: true })).toBe(true)
    expect(webSearchEnabled({ exa: true })).toBe(true)
    expect(webSearchEnabled({ parallel: true })).toBe(true)
  })

  test("uses branded labels", () => {
    expect(webSearchProviderLabel("parallel")).toBe("Parallel Web Search")
    expect(webSearchProviderLabel("exa")).toBe("Exa Web Search")
    expect(webSearchProviderLabel(undefined)).toBe("Web Search")
  })
})

describe("websearch MCP response parser", () => {
  const payload = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: {
      content: [
        {
          type: "text",
          text: "search results",
        },
      ],
    },
  })

  it.effect("parses plain JSON-RPC responses", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(payload)
      expect(result).toBe("search results")
    }),
  )

  it.effect("parses SSE JSON-RPC responses", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(`event: message\ndata: ${payload}\n\n`)
      expect(result).toBe("search results")
    }),
  )

  it.effect("ignores non-JSON SSE data frames", () =>
    Effect.gen(function* () {
      const result = yield* parseResponse(`data: [DONE]\ndata: ${payload}\n\n`)
      expect(result).toBe("search results")
    }),
  )
})
