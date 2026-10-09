export * as Wildcard from "./wildcard"

const ignoreCase = process.platform === "win32"

// Linear-space glob matcher. A regex built from "*a*a*a*b" backtracks polynomially on long
// non-matching input, and patterns come from user config, so match with two pointers instead.
function glob(input: string, pattern: string) {
  let i = 0
  let p = 0
  let star = -1
  let mark = 0
  while (i < input.length) {
    if (p < pattern.length && pattern[p] === "*") {
      star = p++
      mark = i
    } else if (p < pattern.length && (pattern[p] === "?" || pattern[p] === input[i])) {
      p++
      i++
    } else if (star !== -1) {
      p = star + 1
      i = ++mark
    } else {
      return false
    }
  }
  while (pattern[p] === "*") p++
  return p === pattern.length
}

export function match(input: string, pattern: string) {
  let normalized = input.replaceAll("\\", "/")
  let glued = pattern.replaceAll("\\", "/")
  if (ignoreCase) {
    normalized = normalized.toLowerCase()
    glued = glued.toLowerCase()
  }

  // A trailing " *" makes the arguments optional: "ls *" matches both "ls" and "ls -la".
  if (glued.endsWith(" *")) {
    const head = glued.slice(0, -2)
    return glob(normalized, head) || glob(normalized, head + " *")
  }
  return glob(normalized, glued)
}
