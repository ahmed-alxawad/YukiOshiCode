// Checks the answer of `yukioshi run --output-schema` against the schema. The StructuredOutput tool hands the
// model's arguments over without validating them, so this runs before the command exits 0.
// It covers the common JSON Schema keywords and local `#/…` references; remote references are rejected earlier.

const MAX_DEPTH = 128

function jsonType(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function resolveRef(root: Record<string, unknown>, ref: string): unknown {
  if (ref === "#") return root
  if (!ref.startsWith("#/")) return undefined
  let node: unknown = root
  for (const part of ref.slice(2).split("/")) {
    const key = decodeURIComponent(part).replace(/~1/g, "/").replace(/~0/g, "~")
    if (!node || typeof node !== "object") return undefined
    node = (node as Record<string, unknown>)[key]
  }
  return node
}

function check(
  root: Record<string, unknown>,
  schema: unknown,
  value: unknown,
  at: string,
  depth: number,
): string | undefined {
  if (schema === true || schema === undefined) return undefined
  if (schema === false) return `${at} is not allowed`
  if (!schema || typeof schema !== "object" || depth > MAX_DEPTH) return undefined
  const s = schema as Record<string, unknown>
  const sub = (child: unknown, v: unknown, where: string) => check(root, child, v, where, depth + 1)

  if (typeof s.$ref === "string") {
    const target = resolveRef(root, s.$ref)
    if (target === undefined) return `${at} has an unresolvable $ref ${s.$ref}`
    const failed = sub(target, value, at)
    if (failed) return failed
  }
  if (s.const !== undefined && !sameJson(s.const, value)) return `${at} must equal ${JSON.stringify(s.const)}`
  if (Array.isArray(s.enum) && !s.enum.some((item) => sameJson(item, value)))
    return `${at} must be one of ${JSON.stringify(s.enum)}`

  const kind = jsonType(value)
  if (s.type !== undefined) {
    const types = Array.isArray(s.type) ? s.type : [s.type]
    const ok = types.some(
      (t) => t === kind || (t === "integer" && kind === "number" && Number.isInteger(value)),
    )
    if (!ok) return `${at} must be ${types.join(" or ")}, not ${kind}`
  }
  if (Array.isArray(s.allOf)) {
    for (const part of s.allOf) {
      const failed = sub(part, value, at)
      if (failed) return failed
    }
  }
  if (Array.isArray(s.anyOf) && !s.anyOf.some((part) => !sub(part, value, at)))
    return `${at} does not match any allowed shape`
  if (Array.isArray(s.oneOf) && s.oneOf.filter((part) => !sub(part, value, at)).length !== 1)
    return `${at} must match exactly one allowed shape`
  if (s.not !== undefined && !sub(s.not, value, at)) return `${at} matches a shape that is not allowed`

  if (kind === "number") {
    const n = value as number
    if (typeof s.minimum === "number" && n < s.minimum) return `${at} must be at least ${s.minimum}`
    if (typeof s.maximum === "number" && n > s.maximum) return `${at} must be at most ${s.maximum}`
    if (typeof s.exclusiveMinimum === "number" && n <= s.exclusiveMinimum)
      return `${at} must be above ${s.exclusiveMinimum}`
    if (typeof s.exclusiveMaximum === "number" && n >= s.exclusiveMaximum)
      return `${at} must be below ${s.exclusiveMaximum}`
  }
  if (kind === "string") {
    const text = value as string
    if (typeof s.minLength === "number" && text.length < s.minLength) return `${at} is shorter than ${s.minLength}`
    if (typeof s.maxLength === "number" && text.length > s.maxLength) return `${at} is longer than ${s.maxLength}`
    if (typeof s.pattern === "string") {
      try {
        if (!new RegExp(s.pattern, "u").test(text)) return `${at} does not match the pattern ${s.pattern}`
      } catch {}
    }
  }
  if (kind === "array") {
    const list = value as unknown[]
    if (typeof s.minItems === "number" && list.length < s.minItems) return `${at} has fewer than ${s.minItems} items`
    if (typeof s.maxItems === "number" && list.length > s.maxItems) return `${at} has more than ${s.maxItems} items`
    if (s.uniqueItems === true && new Set(list.map((item) => JSON.stringify(item))).size !== list.length)
      return `${at} has duplicate items`
    const tuple = Array.isArray(s.prefixItems) ? s.prefixItems : Array.isArray(s.items) ? s.items : undefined
    for (let i = 0; i < list.length; i++) {
      const child = tuple ? (i < tuple.length ? tuple[i] : s.additionalItems) : s.items
      const failed = sub(child, list[i], `${at}[${i}]`)
      if (failed) return failed
    }
  }
  if (kind === "object") {
    const obj = value as Record<string, unknown>
    const props = (s.properties && typeof s.properties === "object" ? s.properties : {}) as Record<string, unknown>
    if (Array.isArray(s.required)) {
      for (const key of s.required) if (typeof key === "string" && !(key in obj)) return `${at} is missing "${key}"`
    }
    for (const [key, item] of Object.entries(obj)) {
      const where = `${at}.${key}`
      if (Object.prototype.hasOwnProperty.call(props, key)) {
        const failed = sub(props[key], item, where)
        if (failed) return failed
      } else if (s.additionalProperties === false) {
        return `${at} has the unexpected property "${key}"`
      } else if (s.additionalProperties && typeof s.additionalProperties === "object") {
        const failed = sub(s.additionalProperties, item, where)
        if (failed) return failed
      }
    }
  }
  return undefined
}

/** What is wrong with `value` under `schema`, or undefined when it matches. */
export function schemaViolation(schema: Record<string, unknown>, value: unknown): string | undefined {
  return check(schema, schema, value, "$", 0)
}
