// A fetch that cannot wait forever. The limit covers the wait for the response and then every gap between
// chunks of the body, so a server that goes quiet part way through a download is also stopped.
export const FETCH_TIMEOUT_MS = 30_000

// YUKIOSHI_FETCH_TIMEOUT_MS shortens or lengthens the limit. Anything that is not a positive number of
// milliseconds is ignored, so a typo cannot make every request fail at once or never time out.
function configuredTimeout() {
  const value = Number(typeof process !== "undefined" ? process.env["YUKIOSHI_FETCH_TIMEOUT_MS"] : undefined)
  return Number.isFinite(value) && value > 0 ? value : FETCH_TIMEOUT_MS
}

// Names the host only: a URL's query string can carry tokens.
const hostOf = (input: string | URL | Request) => {
  try {
    return new URL(input instanceof Request ? input.url : input).host
  } catch {
    return "the server"
  }
}

export async function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs: number = configuredTimeout(),
): Promise<Response> {
  const controller = new AbortController()
  const outer = init.signal
  if (outer?.aborted) controller.abort(outer.reason)
  else outer?.addEventListener("abort", () => controller.abort(outer.reason), { once: true })

  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
  }
  const failure = () =>
    new Error(`No response from ${hostOf(input)} for ${Math.round(timeoutMs / 1000)}s; the request was stopped`)

  arm()
  let response: Response
  try {
    response = await fetch(input, { ...init, signal: controller.signal })
  } catch (error) {
    clearTimeout(timer)
    if (timedOut) throw failure()
    throw error
  }
  if (!response.body) {
    clearTimeout(timer)
    return response
  }

  const reader = response.body.getReader()
  const body = new ReadableStream<Uint8Array>({
    async pull(stream) {
      arm()
      try {
        const chunk = await reader.read()
        if (chunk.done) {
          clearTimeout(timer)
          stream.close()
          return
        }
        stream.enqueue(chunk.value)
      } catch (error) {
        clearTimeout(timer)
        stream.error(timedOut ? failure() : error)
      }
    },
    cancel(reason) {
      clearTimeout(timer)
      controller.abort(reason)
      return reader.cancel(reason).catch(() => undefined)
    },
  })
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
}
