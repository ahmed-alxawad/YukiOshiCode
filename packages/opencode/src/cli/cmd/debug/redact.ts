import { Redact } from "@yukioshi/core/redact"

// Redact only the debug output; the resolved configuration must remain usable by providers.
const secretName = /(?:api.?key|secret|password|token$|authorization$|cookie$|credential|private.?key)/i

const secretFlag = /^--?[a-z0-9-]*(?:api-?key|password|passwd|secret|token|credential)[a-z0-9-]*$/i

export function redactConfig(value: unknown, headers = false): unknown {
  // A secret can sit in any string (a command line, a URL, a note), whatever its key is called.
  if (typeof value === "string") return Redact.scrubKnown(Redact.mask(value))
  if (Array.isArray(value))
    // A command given as an argument list: `["tool", "--token", "abc"]` holds the secret in the next item.
    return value.map((item, i) =>
      typeof item === "string" && typeof value[i - 1] === "string" && secretFlag.test(value[i - 1])
        ? "***"
        : redactConfig(item, headers),
    )
  if (value === null || typeof value !== "object") return value

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (typeof item === "string" && (headers || secretName.test(key))) return [key, "***"]
      if (typeof item === "string" && /^https?:\/\//i.test(item)) {
        if (!URL.canParse(item)) return [key, "***"]
        const url = new URL(item)
        if (url.username || url.password || [...url.searchParams.keys()].some((name) => secretName.test(name)))
          return [key, "***"]
      }
      return [key, redactConfig(item, headers || key.toLowerCase() === "headers")]
    }),
  )
}
