import { cp, mkdir, rm } from "node:fs/promises"
import { resolve } from "node:path"
import { build, context } from "esbuild"

const root = resolve(import.meta.dir, "..")
const out = resolve(root, "dist")
const watch = process.argv.includes("--watch")

await rm(out, { recursive: true, force: true })
await mkdir(resolve(out, "renderer"), { recursive: true })

const shared = {
  bundle: true,
  logLevel: "info" as const,
  platform: "node" as const,
  sourcemap: true,
  target: "node22",
}

const builds = [
  { ...shared, entryPoints: [resolve(root, "src/main/index.ts")], outfile: resolve(out, "main/index.js"), external: ["electron", "electron-updater"] },
  { ...shared, entryPoints: [resolve(root, "src/preload/index.ts")], outfile: resolve(out, "preload/index.js"), external: ["electron"] },
  { bundle: true, entryPoints: [resolve(root, "src/renderer/index.ts")], outfile: resolve(out, "renderer/index.js"), platform: "browser" as const, sourcemap: true, target: "es2022" },
]

if (watch) {
  const contexts = await Promise.all(builds.map((options) => context(options)))
  await Promise.all(contexts.map((item) => item.watch()))
  console.log("desktop build watching")
} else {
  await Promise.all(builds.map((options) => build(options)))
  await cp(resolve(root, "src/renderer/index.html"), resolve(out, "renderer/index.html"))
  await cp(resolve(root, "src/renderer/styles.css"), resolve(out, "renderer/styles.css"))
}
