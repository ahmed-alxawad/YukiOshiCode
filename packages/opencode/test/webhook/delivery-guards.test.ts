import { describe, expect, test } from "bun:test"
import { deliverWebhook, webhookSignature, webhookWants, type WebhookPayload } from "@/webhook"

const payload: WebhookPayload = {
  event: "turn.finished",
  time: "2026-10-05T00:00:00.000Z",
  session: { id: "ses_test", title: "t" },
  project: { directory: "/tmp/project" },
  detail: { status: "ok" },
}

type Call = { url: string; headers: Record<string, string> }

function fake(responses: Array<() => Response>) {
  const calls: Call[] = []
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string> })
    const next = responses[Math.min(calls.length - 1, responses.length - 1)]
    return next()
  }) as unknown as typeof globalThis.fetch
  return { calls, fetch }
}

const redirect = (location: string | null, status = 302) => () =>
  new Response(null, { status, headers: location === null ? {} : { location } })
const ok = () => new Response("ok", { status: 200 })

describe("webhook URL validation", () => {
  test.each(["", "not a url", "ftp://example.com/x", "file:///etc/passwd", "javascript:alert(1)", "data:text/plain,hi", "ws://example.com", "//example.com/x"])(
    "rejects %p without calling fetch",
    async (url) => {
      const { calls, fetch } = fake([ok])
      await expect(deliverWebhook({ url }, payload, { fetch })).rejects.toThrow()
      expect(calls).toHaveLength(0)
    },
  )

  test("does not retry a validation failure", async () => {
    const started = Date.now()
    await expect(deliverWebhook({ url: "ftp://x" }, payload, { fetch: fake([ok]).fetch })).rejects.toThrow("http: or https:")
    expect(Date.now() - started).toBeLessThan(90)
  })

  test("accepts http and https, including loopback and uppercase schemes", async () => {
    for (const url of ["http://127.0.0.1:9/h", "https://example.com/h", "HTTPS://EXAMPLE.COM/h", "http://[::1]:8080/h"]) {
      const { calls, fetch } = fake([ok])
      await deliverWebhook({ url }, payload, { fetch })
      expect(calls).toHaveLength(1)
    }
  })
})

describe("webhook redirect handling", () => {
  test("does not leak the signature or custom headers across hosts, even via lookalike hosts", async () => {
    for (const target of [
      "https://example.com.evil.test/x",
      "https://evil.test/x",
      "https://example.com:8443/x",
      "https://sub.example.com/x",
      "//evil.test/x",
    ]) {
      const { calls, fetch } = fake([redirect(target), ok])
      await expect(
        deliverWebhook({ url: "https://example.com/hook", secret: "s", headers: { authorization: "Bearer t" } }, payload, { fetch }),
      ).rejects.toThrow("different host")
      expect(calls).toHaveLength(1)
    }
  })

  test("a userinfo trick in the redirect target does not pass the host check", async () => {
    const { calls, fetch } = fake([redirect("https://example.com@evil.test/x"), ok])
    await expect(deliverWebhook({ url: "https://example.com/hook", secret: "s" }, payload, { fetch })).rejects.toThrow(
      "different host",
    )
    expect(calls).toHaveLength(1)
  })

  test("follows same-host relative redirects and keeps the signature", async () => {
    const { calls, fetch } = fake([redirect("/v2/hook", 307), ok])
    await deliverWebhook({ url: "https://example.com/hook", secret: "s" }, payload, { fetch })
    expect(calls.map((c) => c.url)).toEqual(["https://example.com/hook", "https://example.com/v2/hook"])
    expect(calls[1].headers["X-YukiOshi-Signature"]).toStartWith("sha256=")
  })

  test("refuses non-http redirect targets", async () => {
    for (const target of ["file:///etc/passwd", "ftp://example.com/x", "javascript:alert(1)"]) {
      const { fetch } = fake([redirect(target), ok])
      await expect(deliverWebhook({ url: "https://example.com/h" }, payload, { fetch })).rejects.toThrow()
    }
  })

  test("stops after five redirects", async () => {
    const { calls, fetch } = fake([redirect("/loop")])
    await expect(deliverWebhook({ url: "https://example.com/h" }, payload, { fetch })).rejects.toThrow("Too many redirects")
    expect(calls).toHaveLength(6)
  })

  test("a redirect without a location header fails without retrying", async () => {
    const { calls, fetch } = fake([redirect(null, 301)])
    await expect(deliverWebhook({ url: "https://example.com/h" }, payload, { fetch })).rejects.toThrow("without location")
    expect(calls).toHaveLength(1)
  })
})

describe("webhook headers and signature", () => {
  test("rejects CR or LF in header names and values", async () => {
    for (const headers of [{ "x-a": "v\r\nx-evil: 1" }, { "x-a\nb": "v" }, { "x-a": "v\n" }] as Array<Record<string, string>>) {
      const { calls, fetch } = fake([ok])
      await expect(deliverWebhook({ url: "https://example.com/h", headers }, payload, { fetch })).rejects.toThrow("newline")
      expect(calls).toHaveLength(0)
    }
  })

  test("signs the exact body that is sent and omits the signature without a secret", async () => {
    const seen: string[] = []
    const fetch = (async (_url: string, init: RequestInit) => {
      seen.push(String(init.body))
      expect((init.headers as Record<string, string>)["X-YukiOshi-Signature"]).toBe(webhookSignature(String(init.body), "k"))
      return ok()
    }) as unknown as typeof globalThis.fetch
    await deliverWebhook({ url: "https://example.com/h", secret: "k" }, payload, { fetch })
    expect(seen).toHaveLength(1)

    const plain = fake([ok])
    await deliverWebhook({ url: "https://example.com/h" }, payload, { fetch: plain.fetch })
    expect(plain.calls[0].headers["X-YukiOshi-Signature"]).toBeUndefined()
  })

  test("signature differs per secret and per body", () => {
    expect(webhookSignature("a", "k1")).not.toBe(webhookSignature("a", "k2"))
    expect(webhookSignature("a", "k")).not.toBe(webhookSignature("b", "k"))
    expect(webhookSignature("日本", "k")).toMatch(/^sha256=[0-9a-f]{64}$/)
  })

  test("an empty event list subscribes to nothing", () => {
    expect(webhookWants({ url: "https://example.com", events: [] }, "turn.finished")).toBe(false)
  })
})
