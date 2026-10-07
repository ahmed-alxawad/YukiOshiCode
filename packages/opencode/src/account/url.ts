export const normalizeServerUrl = (input: string): string => {
  const url = new URL(input)
  url.search = ""
  url.hash = ""

  const pathname = url.pathname.replace(/\/+$/, "")
  return pathname.length === 0 ? url.origin : `${url.origin}${pathname}`
}

export const isOpencodeUrl = (input: string): boolean => {
  try {
    const raw = input.trim()
    const target = raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`
    const url = new URL(target)
    const host = url.hostname.toLowerCase()
    return (
      host === "opencode.ai" ||
      host.endsWith(".opencode.ai") ||
      host === "opncd.ai" ||
      host.endsWith(".opncd.ai")
    )
  } catch {
    return false
  }
}

