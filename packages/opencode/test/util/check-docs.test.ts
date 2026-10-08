import { describe, expect, it } from "bun:test"
import {
  slugify,
  extractHeadings,
  findLinksInText,
  isExternalLink,
  checkFileLinks,
} from "../../script/check-docs"

describe("check-docs", () => {
  describe("slug rule", () => {
    it("converts uppercase to lowercase", () => {
      expect(slugify("Hello World")).toBe("hello-world")
    })

    it("converts spaces to hyphens", () => {
      expect(slugify("multiple   spaces   here")).toBe("multiple-spaces-here")
    })

    it("drops punctuation marks", () => {
      expect(slugify("Review, commit, and pull requests!")).toBe("review-commit-and-pull-requests")
      expect(slugify("What's new in v0.3.5?")).toBe("whats-new-in-v035")
      expect(slugify("Codex (OpenAI): Quick-start")).toBe("codex-openai-quick-start")
    })

    it("strips markdown formatting syntax", () => {
      expect(slugify("`yukioshi run` command")).toBe("yukioshi-run-command")
      expect(slugify("**Bold Heading** and *Italic*")).toBe("bold-heading-and-italic")
      expect(slugify("Heading with [Link Text](https://example.com)")).toBe("heading-with-link-text")
    })

    it("handles duplicate headings with incremental numbers", () => {
      const doc = [
        "# Section",
        "## Configuration",
        "### Options",
        "## Configuration",
        "## Configuration",
      ].join("\n")

      const headings = extractHeadings(doc)
      expect(headings.has("section")).toBe(true)
      expect(headings.has("configuration")).toBe(true)
      expect(headings.has("options")).toBe(true)
      expect(headings.has("configuration-1")).toBe(true)
      expect(headings.has("configuration-2")).toBe(true)
    })
  })

  describe("link parser and external links", () => {
    it("identifies external links", () => {
      expect(isExternalLink("https://github.com")).toBe(true)
      expect(isExternalLink("http://localhost:4096")).toBe(true)
      expect(isExternalLink("mailto:security@example.com")).toBe(true)
      expect(isExternalLink("features.md#modes")).toBe(false)
      expect(isExternalLink("#anchor")).toBe(false)
      expect(isExternalLink("../README.md")).toBe(false)
    })

    it("extracts inline markdown and html links", () => {
      const content = [
        "Check [our features](docs/features.md#modes) for details.",
        'Also see <a href="docs/commands.md#exit-codes">exit codes</a>.',
        "```",
        "[not a link](in-code-block.md)",
        "```",
      ].join("\n")

      const links = findLinksInText(content)
      expect(links).toEqual([
        { line: 1, url: "docs/features.md#modes" },
        { line: 2, url: "docs/commands.md#exit-codes" },
      ])
    })
  })

  describe("link checker", () => {
    const mockFiles: Record<string, string> = {
      "/workspace/docs/features.md": [
        "# Features",
        "## Modes",
        "Content about modes.",
        "## Subagents",
        "Content about subagents.",
      ].join("\n"),
      "/workspace/docs/commands.md": [
        "# Commands",
        "## Exit Codes",
        "Content about exit codes.",
      ].join("\n"),
    }

    const readFile = (p: string) => mockFiles[p] ?? null
    const exists = (p: string) => p in mockFiles

    it("reports broken relative file link", () => {
      const testDoc = "See [missing](nonexistent.md) file."
      const broken = checkFileLinks(
        "/workspace/docs/guide.md",
        testDoc,
        new Map(),
        readFile,
        exists,
      )

      expect(broken.length).toBe(1)
      expect(broken[0].link).toBe("nonexistent.md")
      expect(broken[0].reason).toBe("file_not_found")
      expect(broken[0].line).toBe(1)
    })

    it("reports broken anchor link in existing file", () => {
      const testDoc = "See [invalid anchor](features.md#does-not-exist)."
      const broken = checkFileLinks(
        "/workspace/docs/guide.md",
        testDoc,
        new Map(),
        readFile,
        exists,
      )

      expect(broken.length).toBe(1)
      expect(broken[0].link).toBe("features.md#does-not-exist")
      expect(broken[0].reason).toBe("anchor_not_found")
      expect(broken[0].line).toBe(1)
    })

    it("accepts valid file and anchor links and ignores external links", () => {
      const testDoc = [
        "Valid links:",
        "- [Modes](features.md#modes)",
        "- [Subagents](features.md#subagents)",
        "- [Exit Codes](commands.md#exit-codes)",
        "- [External](https://example.com/some/path#anchor)",
      ].join("\n")

      const broken = checkFileLinks(
        "/workspace/docs/guide.md",
        testDoc,
        new Map(),
        readFile,
        exists,
      )

      expect(broken.length).toBe(0)
    })
  })
})
