import { Schema } from "effect"
import { NamedError } from "@yukioshi/core/util/error"
import { Process } from "@/util/process"
import { IdeEvent } from "@yukioshi/schema/ide-event"

const SUPPORTED_IDES = [
  { name: "Windsurf" as const, cmd: "windsurf" },
  { name: "Visual Studio Code - Insiders" as const, cmd: "code-insiders" },
  { name: "Visual Studio Code" as const, cmd: "code" },
  { name: "Cursor" as const, cmd: "cursor" },
  { name: "VSCodium" as const, cmd: "codium" },
]

export const Event = IdeEvent

export const AlreadyInstalledError = NamedError.create("AlreadyInstalledError", {})

export const InstallFailedError = NamedError.create("InstallFailedError", {
  stderr: Schema.String,
})

export const PUBLISHED_EXTENSIONS: readonly string[] = []

export const REFUSAL_MESSAGE =
  "no YukiOshi editor extension is published; connect your editor over ACP: `yukioshi acp`"

export function ide() {
  if (process.env["TERM_PROGRAM"] === "vscode") {
    const v = process.env["GIT_ASKPASS"]
    for (const ide of SUPPORTED_IDES) {
      if (v?.includes(ide.name)) return ide.name
    }
  }
  return "unknown"
}

export function alreadyInstalled() {
  return process.env["YUKIOSHI_CALLER"] === "vscode" || process.env["YUKIOSHI_CALLER"] === "vscode-insiders"
}

export async function install(ide: (typeof SUPPORTED_IDES)[number]["name"]) {
  const cmd = SUPPORTED_IDES.find((i) => i.name === ide)?.cmd
  if (!cmd) throw new Error(`Unknown IDE: ${ide}`)

  // Refuse to install any extension unless the id is one we publish.
  // YukiOshi does not publish editor extensions; users connect editors via ACP.
  // Never install untrusted extensions or legacy sst-dev.opencode / yukioshi.yukioshi.
  const extensionId = ""
  if (!extensionId || !PUBLISHED_EXTENSIONS.includes(extensionId)) {
    process.stderr.write(REFUSAL_MESSAGE + "\n")
    process.exit(1)
  }

  const p = await Process.run([cmd, "--install-extension", extensionId], {
    nothrow: true,
  })
  const stdout = p.stdout.toString()
  const stderr = p.stderr.toString()

  if (p.code !== 0) {
    throw new InstallFailedError({ stderr })
  }
  if (stdout.includes("already installed")) {
    throw new AlreadyInstalledError({})
  }
}

export * as Ide from "."
