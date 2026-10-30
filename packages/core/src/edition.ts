// The edition is chosen when the binary is built, never at run time: the build script defines
// YUKIOSHI_EDITION ("yukioshi" or "kothora"). Only when nothing was defined (running from source, tests)
// does the YUKIOSHI_EDITION environment variable pick it, so a shipped binary cannot be switched by its user.
declare global {
  const YUKIOSHI_EDITION: string
}

export type ID = "yukioshi" | "kothora"

export interface Info {
  readonly id: ID
  /** Name of the command a user types. */
  readonly command: string
  readonly productName: string
  /** Terminal title shown by the TUI (YukiOshi keeps its original short title). */
  readonly terminalTitle: string
  /** Folder name under the XDG data, cache, config and state directories. */
  readonly appDir: string
  /** Service name in the OS keychain. */
  readonly keychainService: string
  /** Kothora is the only model provider; bring-your-own-key provider setup is refused. */
  readonly byok: boolean
  /**
   * A rule file read in addition to AGENTS.md and CLAUDE.md, listed first in the system prompt so it
   * takes precedence when rules conflict. Read from both the project and the global config folder.
   */
  readonly extraInstructionFile?: string
  /** Learn mode (the agent mode for students) and the /learn command. */
  readonly learnMode: boolean
  /** The agent explains in the account's answer mode (or the `explanationLanguage` setting). */
  readonly explanationLanguage: boolean
  /** Skills that ship only with this edition (the skills-kothora folder). */
  readonly editionSkills: boolean
}

const editions: Record<ID, Info> = {
  yukioshi: {
    id: "yukioshi",
    command: "yukioshi",
    productName: "YukiOshi Code",
    terminalTitle: "YukiOshi",
    appDir: "yukioshi",
    keychainService: "yukioshi-code",
    byok: true,
    learnMode: false,
    explanationLanguage: false,
    editionSkills: false,
  },
  kothora: {
    id: "kothora",
    command: "kothora",
    productName: "Kothora Code",
    terminalTitle: "Kothora Code",
    appDir: "kothora",
    keychainService: "kothora-code",
    byok: false,
    extraInstructionFile: "KOTHORA.md",
    learnMode: true,
    explanationLanguage: true,
    editionSkills: true,
  },
}

export function isID(value: unknown): value is ID {
  return typeof value === "string" && Object.hasOwn(editions, value)
}

/** Pick the edition. An unknown name is a build mistake and fails loudly instead of falling back. */
export function resolve(defined: unknown, env: string | undefined): Info {
  const value = defined ?? (env === undefined || env === "" ? undefined : env)
  if (value === undefined) return editions.yukioshi
  if (!isID(value)) throw new Error(`Unknown edition "${String(value)}". Use "yukioshi" or "kothora".`)
  return editions[value]
}

export const Edition: Info = resolve(
  typeof YUKIOSHI_EDITION === "string" ? YUKIOSHI_EDITION : undefined,
  process.env["YUKIOSHI_EDITION"],
)

export const isKothora = Edition.id === "kothora"
