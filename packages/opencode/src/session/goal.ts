// Standing goals (/goal): an objective YukiOshi keeps working on across turns. After each turn a small
// model judges whether the goal is met; if not, YukiOshi continues on its own, up to a round limit.
// One goal per session, stored as a small JSON file in the state folder.

import fs from "fs/promises"
import path from "path"
import { Global } from "@yukioshi/core/global"

export const DEFAULT_MAX_ROUNDS = 20

export type Status = "active" | "paused" | "done"

/** Why a goal paused by itself; `yukioshi run` turns it into an exit code. */
export type PauseReason = "error" | "refused" | "rounds" | "blocked" | "interrupted"

export interface Goal {
  readonly objective: string
  readonly status: Status
  /** Automatic continuation rounds used so far. */
  readonly rounds: number
  readonly maxRounds: number
  /** Why the goal last paused or finished, or the judge's last note. */
  readonly note?: string
  /** What kind of pause it is, while the goal is paused. */
  readonly paused?: PauseReason
  readonly updated: number
}

function file(sessionID: string) {
  return path.join(Global.Path.state, "goals", `${sessionID.replace(/[^A-Za-z0-9_-]/g, "_")}.json`)
}

export async function get(sessionID: string): Promise<Goal | undefined> {
  const text = await fs.readFile(file(sessionID), "utf8").catch(() => undefined)
  if (!text) return undefined
  try {
    const value = JSON.parse(text) as Goal
    return typeof value.objective === "string" ? value : undefined
  } catch {
    return undefined
  }
}

export async function set(sessionID: string, goal: Omit<Goal, "updated">): Promise<Goal> {
  const next = { ...goal, updated: Date.now() }
  await fs.mkdir(path.dirname(file(sessionID)), { recursive: true })
  await fs.writeFile(file(sessionID), JSON.stringify(next, null, 2))
  return next
}

export async function update(sessionID: string, change: Partial<Omit<Goal, "updated">>) {
  const current = await get(sessionID)
  if (!current) return undefined
  return set(sessionID, { ...current, ...change })
}

export async function clear(sessionID: string) {
  await fs.rm(file(sessionID), { force: true })
}

export type Verdict = { readonly verdict: "done" | "continue" | "blocked"; readonly reason: string }

/**
 * Reads the judge's answer. The first word decides (DONE, CONTINUE, or BLOCKED); anything unreadable
 * counts as BLOCKED so an unclear answer pauses the goal instead of looping.
 */
export function parseVerdict(text: string): Verdict {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").trim()
  const match = cleaned.match(/^\W*(DONE|CONTINUE|BLOCKED)\b\W*(.*)$/is)
  if (!match) return { verdict: "blocked", reason: "The goal check gave no clear answer." }
  const reason = match[2]!.trim().split("\n")[0]!.slice(0, 300)
  return { verdict: match[1]!.toLowerCase() as Verdict["verdict"], reason }
}

/** The message YukiOshi adds to keep working toward the goal. */
export function continuation(goal: Goal, reason: string) {
  return [
    `Continue working toward the goal (round ${goal.rounds + 1} of ${goal.maxRounds}).`,
    `Goal: ${goal.objective}`,
    ...(reason ? [`Still missing: ${reason}`] : []),
    "Pick the next concrete step, do it, and verify it. If the goal is already met, say so and stop.",
  ].join("\n")
}

/** What the judge sees: the goal and the end of the latest turn. */
export function judgeInput(goal: Goal, lastReply: string, toolSummary: string) {
  return [
    `Goal: ${goal.objective}`,
    "",
    "Tools used in the latest turn:",
    toolSummary || "(none)",
    "",
    "The assistant's latest reply:",
    lastReply.length > 6000 ? lastReply.slice(-6000) : lastReply || "(empty)",
  ].join("\n")
}

export function status(goal: Goal | undefined) {
  if (!goal) return "No goal is set. Set one with /goal <what you want done>."
  const state = { active: "Active", paused: "Paused", done: "Done" }[goal.status]
  return [
    `${state} goal: ${goal.objective}`,
    `Rounds used: ${goal.rounds} of ${goal.maxRounds}`,
    ...(goal.note ? [`${{ active: "Last check", paused: "Why", done: "Result" }[goal.status]}: ${goal.note}`] : []),
    goal.status === "paused" ? "Resume with /goal resume, or clear it with /goal clear." : "",
  ]
    .filter(Boolean)
    .join("\n")
}

export * as SessionGoal from "./goal"
