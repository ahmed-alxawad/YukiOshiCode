#!/usr/bin/env bun
import fs from "node:fs"
import path from "node:path"

/**
 * GitHub's slug rules for Markdown headings:
 * - Markdown links [text](url) -> text
 * - Strip formatting markers (`*_~)
 * - Lowercase
 * - Drop punctuation (anything except alphanumeric, whitespace, hyphens)
 * - Convert spaces to hyphens
 * - Trim leading/trailing hyphens
 */
export function slugify(heading: string): string {
  return heading
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function extractHeadings(markdown: string): Set<string> {
  const headings = new Set<string>()
  const counts = new Map<string, number>()
  const lines = markdown.split(/\r?\n/)
  let inCode = false

  for (const line of lines) {
    if (line.trim().startsWith("```")) {
      inCode = !inCode
      continue
    }
    if (inCode) continue

    const match = line.match(/^#{1,6}\s+(.+)$/)
    if (!match) continue

    const baseSlug = slugify(match[1].trim())
    if (!baseSlug) continue

    const count = counts.get(baseSlug) ?? 0
    counts.set(baseSlug, count + 1)
    headings.add(count === 0 ? baseSlug : `${baseSlug}-${count}`)
  }

  return headings
}

export type BrokenLink = {
  file: string
  line: number
  link: string
  targetPath: string
  reason: "file_not_found" | "anchor_not_found"
}

export function findLinksInText(text: string): { line: number; url: string }[] {
  const results: { line: number; url: string }[] = []
  const lines = text.split(/\r?\n/)
  let inCode = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim().startsWith("```")) {
      inCode = !inCode
      continue
    }
    if (inCode) continue

    // Markdown links: [text](url)
    const mdMatches = line.matchAll(/\[(?:[^\]]|\\\])+\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)
    for (const match of mdMatches) {
      results.push({ line: i + 1, url: match[1] })
    }

    // HTML links: <a href="url">
    const htmlMatches = line.matchAll(/<a\s+[^>]*href=["']([^"']+)["']/gi)
    for (const match of htmlMatches) {
      results.push({ line: i + 1, url: match[1] })
    }
  }

  return results
}

export function isExternalLink(url: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(url)
}

export function checkFileLinks(
  filePath: string,
  content: string,
  headingCache: Map<string, Set<string>> = new Map(),
  readFileFn: (p: string) => string | null = (p) => {
    try {
      return fs.readFileSync(p, "utf8")
    } catch {
      return null
    }
  },
  existsFn: (p: string) => boolean = (p) => fs.existsSync(p),
): BrokenLink[] {
  const broken: BrokenLink[] = []
  const links = findLinksInText(content)

  for (const { line, url } of links) {
    if (isExternalLink(url)) continue

    let targetFile = ""
    let anchor = ""
    if (url.includes("#")) {
      const idx = url.indexOf("#")
      targetFile = url.slice(0, idx)
      anchor = url.slice(idx + 1)
    } else {
      targetFile = url
    }

    const resolvedTarget = targetFile
      ? path.resolve(path.dirname(filePath), targetFile)
      : path.resolve(filePath)

    if (!existsFn(resolvedTarget)) {
      broken.push({
        file: filePath,
        line,
        link: url,
        targetPath: resolvedTarget,
        reason: "file_not_found",
      })
      continue
    }

    if (anchor && (resolvedTarget.endsWith(".md") || resolvedTarget.endsWith(".markdown"))) {
      let headings = headingCache.get(resolvedTarget)
      if (!headings) {
        const targetContent = readFileFn(resolvedTarget)
        if (targetContent !== null) {
          headings = extractHeadings(targetContent)
          headingCache.set(resolvedTarget, headings)
        }
      }

      if (headings && !headings.has(anchor)) {
        broken.push({
          file: filePath,
          line,
          link: url,
          targetPath: resolvedTarget,
          reason: "anchor_not_found",
        })
      }
    }
  }

  return broken
}

export function checkAllDocs(repoRoot: string): BrokenLink[] {
  const docsDir = path.join(repoRoot, "docs")
  const files: string[] = []
  const readme = path.join(repoRoot, "README.md")
  if (fs.existsSync(readme)) files.push(readme)
  if (fs.existsSync(docsDir)) {
    for (const entry of fs.readdirSync(docsDir)) {
      if (entry.endsWith(".md")) {
        files.push(path.join(docsDir, entry))
      }
    }
  }

  const headingCache = new Map<string, Set<string>>()
  const allBroken: BrokenLink[] = []

  for (const file of files) {
    const content = fs.readFileSync(file, "utf8")
    const broken = checkFileLinks(file, content, headingCache)
    allBroken.push(...broken)
  }

  return allBroken
}

// CLI execution
if (import.meta.main) {
  const repoRoot = fs.existsSync(path.resolve(process.cwd(), "docs"))
    ? process.cwd()
    : path.resolve(import.meta.dir, "../../..")

  const broken = checkAllDocs(repoRoot)

  if (broken.length > 0) {
    for (const item of broken) {
      const relPath = path.relative(repoRoot, item.file)
      console.error(`${relPath}:${item.line}: ${item.link}`)
    }
    process.exit(1)
  }
}
