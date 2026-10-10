import path from "node:path"
import { LANGUAGE_EXTENSIONS } from "@yukioshi/core/util/language"

export { LANGUAGE_EXTENSIONS }

export function filetype(input?: string) {
  if (!input) return "none"
  const language = LANGUAGE_EXTENSIONS[path.extname(input)]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}
