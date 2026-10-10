import { Effect, Schema, Stream } from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { Parser } from "htmlparser2"
import * as Tool from "./tool"
import TurndownService from "turndown"
import DESCRIPTION from "./webfetch.txt"
import { isImageAttachment } from "@/util/media"

const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5MB
const MAX_REDIRECTS = 10
const DEFAULT_TIMEOUT = 30 * 1000 // 30 seconds
const MAX_TIMEOUT = 120 * 1000 // 2 minutes

export const Parameters = Schema.Struct({
  url: Schema.String.annotate({ description: "The URL to fetch content from" }),
  format: Schema.Literals(["text", "markdown", "html"])
    .annotate({
      description: "The format to return the content in (text, markdown, or html). Defaults to markdown.",
      default: "markdown",
    })
    .pipe(Schema.withDecodingDefault(Effect.succeed("markdown" as const))),
  timeout: Schema.optional(Schema.Number).annotate({ description: "Optional timeout in seconds (max 120)" }),
})

export const WebFetchTool = Tool.define(
  "webfetch",
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
            throw new Error("URL must start with http:// or https://")
          }

          yield* ctx.ask({
            permission: "webfetch",
            patterns: [params.url],
            always: ["*"],
            metadata: {
              url: params.url,
              format: params.format,
              timeout: params.timeout,
            },
          })

          const timeout = Math.min((params.timeout ?? DEFAULT_TIMEOUT / 1000) * 1000, MAX_TIMEOUT)

          // Build Accept header based on requested format with q parameters for fallbacks
          let acceptHeader = "*/*"
          switch (params.format) {
            case "markdown":
              acceptHeader = "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
              break
            case "text":
              acceptHeader = "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
              break
            case "html":
              acceptHeader =
                "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
              break
            default:
              acceptHeader =
                "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
          }
          const headers = {
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
            Accept: acceptHeader,
            "Accept-Language": "en-US,en;q=0.9",
          }

          // Redirects are followed by hand: a redirect can leave the host the permission was given for.
          const send = (url: string, ua: string) =>
            http
              .execute(HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders({ ...headers, "User-Agent": ua })))
              .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }))

          const fetchOnce = (url: string) =>
            send(url, headers["User-Agent"]).pipe(
              // Retry with honest UA if blocked by Cloudflare bot detection (TLS fingerprint mismatch)
              Effect.flatMap((res) =>
                res.status === 403 && res.headers["cf-mitigated"] === "challenge" ? send(url, "yukioshi") : Effect.succeed(res),
              ),
            )

          const follow = Effect.gen(function* () {
            let current = params.url
            for (let hops = 0; ; hops++) {
              const res = yield* fetchOnce(current)
              const location = res.headers["location"]
              if (res.status < 300 || res.status >= 400 || !location) {
                if (res.status < 200 || res.status >= 300) throw new Error(`Request failed with status code ${res.status}`)
                // Read the body here, under the same timeout, and stop at the size limit.
                const declared = res.headers["content-length"]
                if (declared && parseInt(declared) > MAX_RESPONSE_SIZE) {
                  throw new Error("Response too large (exceeds 5MB limit)")
                }
                const chunks: Uint8Array[] = []
                let total = 0
                yield* Stream.runForEach(res.stream, (chunk) =>
                  Effect.sync(() => {
                    total += chunk.byteLength
                    if (total > MAX_RESPONSE_SIZE) throw new Error("Response too large (exceeds 5MB limit)")
                    chunks.push(chunk)
                  }),
                )
                const arrayBuffer = new Uint8Array(total)
                let at = 0
                for (const chunk of chunks) {
                  arrayBuffer.set(chunk, at)
                  at += chunk.byteLength
                }
                return { response: res, arrayBuffer: arrayBuffer.buffer as ArrayBuffer }
              }
              if (hops >= MAX_REDIRECTS) throw new Error("Too many redirects")
              const next = new URL(location, current)
              if (next.protocol !== "http:" && next.protocol !== "https:") {
                throw new Error("Redirect to a non-http URL was refused")
              }
              if (next.origin !== new URL(current).origin) {
                yield* ctx.ask({
                  permission: "webfetch",
                  patterns: [next.toString()],
                  always: ["*"],
                  metadata: { url: next.toString(), redirectedFrom: current, format: params.format },
                })
              }
              current = next.toString()
            }
          })

          const { response, arrayBuffer } = yield* follow.pipe(
            Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.die(new Error("Request timed out")) }),
          )

          const contentType = response.headers["content-type"] || ""
          const mime = contentType.split(";")[0]?.trim().toLowerCase() || ""
          const title = `${params.url} (${contentType})`

          if (isImageAttachment(mime)) {
            const base64Content = Buffer.from(arrayBuffer).toString("base64")
            return {
              title,
              output: "Image fetched successfully",
              metadata: {},
              attachments: [
                {
                  type: "file" as const,
                  mime,
                  url: `data:${mime};base64,${base64Content}`,
                },
              ],
            }
          }

          const content = new TextDecoder().decode(arrayBuffer)

          // Handle content based on requested format and actual content type
          switch (params.format) {
            case "markdown":
              if (contentType.includes("text/html")) {
                const markdown = convertHTMLToMarkdown(content)
                return {
                  output: markdown,
                  title,
                  metadata: {},
                }
              }
              return { output: content, title, metadata: {} }

            case "text":
              if (contentType.includes("text/html")) {
                return { output: extractTextFromHTML(content), title, metadata: {} }
              }
              return { output: content, title, metadata: {} }

            case "html":
              return { output: content, title, metadata: {} }

            default:
              return { output: content, title, metadata: {} }
          }
        }).pipe(Effect.orDie),
    }
  }),
)

function extractTextFromHTML(html: string) {
  let text = ""
  let skipDepth = 0

  const parser = new Parser({
    onopentag(name) {
      if (skipDepth > 0 || ["script", "style", "noscript", "iframe", "object", "embed"].includes(name)) {
        skipDepth++
      }
    },
    ontext(input) {
      if (skipDepth === 0) text += input
    },
    onclosetag() {
      if (skipDepth > 0) skipDepth--
    },
  })

  parser.write(html)
  parser.end()

  return text.trim()
}

function convertHTMLToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  turndownService.remove(["script", "style", "meta", "link"])
  return turndownService.turndown(html)
}
