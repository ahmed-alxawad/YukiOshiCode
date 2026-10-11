#!/usr/bin/env bun
// Generates THIRD-PARTY-NOTICES.md at the repo root.
// Usage: bun run notices   (from the repo root)
//
// The package set is the one that ends up in the compiled binary: the entry points are bundled with
// Bun's bundler (same options as script/build.ts, without compile) and every node_modules package
// that appears in the metafile inputs is listed. Workspace packages are skipped.
import fs from "node:fs"
import path from "node:path"
import { createSolidTransformPlugin } from "@opentui/solid/bun-plugin"

const pkgDir = path.resolve(import.meta.dirname, "..")
const repoRoot = path.resolve(pkgDir, "../..")
const outFile = path.join(repoRoot, "THIRD-PARTY-NOTICES.md")
const LICENSE_NAME = /^(licen[cs]e|copying|unlicense)([-_.].*)?$/i

process.chdir(pkgDir)
const result = await Bun.build({
  conditions: ["bun", "node"],
  tsconfig: "./tsconfig.json",
  plugins: [createSolidTransformPlugin()],
  // Native platform packages are optional and not installed for every platform.
  external: ["node-gyp", "@opentui/core-*"],
  format: "esm",
  splitting: true,
  target: "bun",
  metafile: true,
  entrypoints: ["./src/index.ts", "./src/cli/tui/worker.ts"],
  write: false,
})
if (!result.success || !result.metafile) {
  for (const log of result.logs) console.error(String(log))
  throw new Error("bundling failed")
}

const roots = new Set<string>()
for (const input of Object.keys(result.metafile.inputs)) {
  const abs = path.resolve(pkgDir, input)
  const marker = `${path.sep}node_modules${path.sep}`
  const at = abs.lastIndexOf(marker)
  if (at < 0) continue
  const parts = abs.slice(at + marker.length).split(path.sep)
  const n = parts[0].startsWith("@") ? 2 : 1
  roots.add(abs.slice(0, at + marker.length) + parts.slice(0, n).join(path.sep))
}

type Entry = { name: string; version: string; license: string; repository: string; text?: string; file?: string }
const entries: Entry[] = []
for (const root of [...roots].sort()) {
  const json = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"))
  const name: string = json.name
  if (name === "yukioshi" || name.startsWith("@yukioshi/")) continue
  const lic = json.license ?? json.licenses
  const license = !lic
    ? "UNKNOWN"
    : typeof lic === "string"
      ? lic
      : Array.isArray(lic)
        ? lic.map((l: any) => l.type ?? String(l)).join(" OR ")
        : (lic.type ?? "UNKNOWN")
  const repo = typeof json.repository === "string" ? json.repository : (json.repository?.url ?? "")
  const file = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isFile() && LICENSE_NAME.test(d.name))
    .map((d) => d.name)
    .sort()[0]
  entries.push({
    name,
    version: json.version,
    license,
    repository: repo.replace(/^git\+/, "").replace(/\.git$/, "") || "not specified",
    file,
    text: file ? fs.readFileSync(path.join(root, file), "utf8").replace(/\r\n/g, "\n").trim() : undefined,
  })
}
entries.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))

const out: string[] = [
  "# Third-party notices",
  "",
  "YukiOshi Code bundles the open-source packages below. Each one is used under its own licence, reproduced here.",
  "",
  "This file is generated. Do not edit it by hand. Regenerate it with `bun run notices` from the repo root.",
  "",
  `Packages listed: ${entries.length}`,
  "",
]
for (const e of entries) {
  out.push(`## ${e.name}@${e.version}`, "", `- Licence: ${e.license}`, `- Repository: ${e.repository}`, "")
  if (e.text) out.push(`Licence text (${e.file}):`, "", "``````text", e.text, "``````", "")
  else out.push("licence file not found", "")
}
fs.writeFileSync(outFile, out.join("\n"))

const counts = new Map<string, number>()
for (const e of entries) counts.set(e.license, (counts.get(e.license) ?? 0) + 1)
console.log(`packages: ${entries.length}`)
console.log(`with licence text: ${entries.filter((e) => e.text).length}`)
console.log(`without licence file: ${entries.filter((e) => !e.text).map((e) => `${e.name}@${e.version}`).join(", ") || "none"}`)
console.log(`bytes: ${fs.statSync(outFile).size}`)
for (const [l, c] of [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) console.log(`${c}\t${l}`)
