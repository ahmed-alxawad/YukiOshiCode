import { describe, expect, test } from "bun:test"
import {
  deliverWebhook,
  enqueueWebhook,
  webhookBody,
  webhookSignature,
  webhookWants,
  type WebhookPayload,
} from "@/webhook"

const payload: WebhookPayload = {
  event: "turn.finished",
  time: "2026-10-05T00:00:00.000Z",
  session: { id: "ses_test", title: "A safe title" },
  project: { directory: "/tmp/project" },
  detail: { status: "ok" },
}

function server(handler: (request: Request) => Response | Promise<Response>) {
  return Bun.serve({ port: 0, fetch: handler })
}

describe("webhooks", () => {
  test("creates a safe payload and HMAC signature", () => {
    const body = webhookBody(payload)
    expect(body).toContain('"event":"turn.finished"')
    expect(body).not.toContain("message")
    expect(body).not.toContain("file")
    expect(webhookSignature(body, "secret")).toBe(
      "sha256=214d19153560c842fb2ada3d386b9e342cf3c1f9a40bd1d63ec2f92d7a4fa766",
    )
  })

  test("uses the default event set and configured filters", () => {
    const base = { url: "http://127.0.0.1:1" }
    expect(webhookWants(base, "turn.finished")).toBe(true)
    expect(webhookWants({ ...base, events: ["permission.asked"] }, "turn.finished")).toBe(false)
    expect(webhookWants({ ...base, events: ["permission.asked"] }, "permission.asked")).toBe(true)
  })

  test("retries server errors but not client errors", async () => {
    let fiveOhThree = 0
    const retryServer = server(() => {
      fiveOhThree++
      return new Response("retry", { status: fiveOhThree < 3 ? 503 : 200 })
    })
    await deliverWebhook({ url: retryServer.url.toString() }, payload, { timeoutMs: 100 })
    retryServer.stop()
    expect(fiveOhThree).toBe(3)

    let fourOhThree = 0
    const noRetryServer = server(() => {
      fourOhThree++
      return new Response("no", { status: 403 })
    })
    await expect(deliverWebhook({ url: noRetryServer.url.toString() }, payload, { timeoutMs: 100 })).rejects.toThrow(
      "HTTP 403",
    )
    noRetryServer.stop()
    expect(fourOhThree).toBe(1)
  })

  test("sends JSON and the configured signature", async () => {
    let received: { body: string; signature: string | null } | undefined
    const receiver = server(async (request) => {
      received = { body: await request.text(), signature: request.headers.get("X-YukiOshi-Signature") }
      return new Response("ok")
    })
    await deliverWebhook({ url: receiver.url.toString(), secret: "secret" }, payload)
    receiver.stop()
    expect(received?.body).toBe(webhookBody(payload))
    expect(received?.signature).toBe(webhookSignature(webhookBody(payload), "secret"))
  })

  test("enqueue does not wait for a hanging endpoint", async () => {
    const hanging = server(() => new Promise<Response>(() => undefined))
    const started = performance.now()
    enqueueWebhook(
      { url: hanging.url.toString() },
      payload,
      { timeoutMs: 10 },
    )
    expect(performance.now() - started).toBeLessThan(100)
    hanging.stop(true)
  })

  test("rejects non-http and non-https webhook URLs", async () => {
    await expect(
      deliverWebhook({ url: "file:///etc/passwd" }, payload, { timeoutMs: 100 }),
    ).rejects.toThrow("Webhook URL must be http: or https:")

    await expect(
      deliverWebhook({ url: "ftp://example.com/hook" }, payload, { timeoutMs: 100 }),
    ).rejects.toThrow("Webhook URL must be http: or https:")
  })

  test("refuses to follow redirect to different host with signature", async () => {
    const redirectServer = server((request) => {
      return new Response(null, {
        status: 302,
        headers: { location: "http://attacker.example/leak" },
      })
    })

    await expect(
      deliverWebhook({ url: redirectServer.url.toString(), secret: "my-secret" }, payload, { timeoutMs: 200 }),
    ).rejects.toThrow("Refusing to follow redirect to different host")
    redirectServer.stop()
  })

  test("follows redirect on the same host", async () => {
    let finalReceived = false
    const sameHostServer = server(async (request) => {
      const url = new URL(request.url)
      if (url.pathname === "/first") {
        return new Response(null, {
          status: 302,
          headers: { location: "/second" },
        })
      }
      if (url.pathname === "/second") {
        finalReceived = true
        return new Response("ok", { status: 200 })
      }
      return new Response("not found", { status: 404 })
    })

    const initialUrl = new URL("/first", sameHostServer.url).toString()
    await deliverWebhook({ url: initialUrl, secret: "my-secret" }, payload, { timeoutMs: 200 })
    sameHostServer.stop()
    expect(finalReceived).toBe(true)
  })
})
