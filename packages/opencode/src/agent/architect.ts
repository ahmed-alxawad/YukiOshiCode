// Architect/editor mode (opt-in, config `architect` or `yukioshi run --architect`): the "architect" primary
// agent can only read, then hands its plan to the "architect-editor" subagent through the task tool. The
// editor goes through the normal subagent path, so the parent session's deny rules still apply to it.
import { Permission } from "@/permission"
import type { PermissionV1 } from "@yukioshi/core/v1/permission"
import { Provider } from "@/provider/provider"
import type { Info } from "./agent"

export const PLANNER = "architect"
export const EDITOR = "architect-editor"

const PLANNER_PROMPT = [
  "You are the architect in a two-model workflow. You can only read the project: you cannot edit files or run commands.",
  "Investigate what is needed, then write a concrete edit plan: for every file, the exact change (what to add, replace or remove, with the key lines).",
  `Then call the task tool ONCE with subagent_type "${EDITOR}" and the complete plan as its prompt. The editor sees only that prompt, so include everything it needs.`,
  "After the editor reports back, answer the user with a short summary of what the editor did, and mention anything that failed.",
].join("\n")

const EDITOR_PROMPT = [
  "You are the editor in a two-model workflow. The prompt is an edit plan written by the architect. Apply it exactly with your edit tools.",
  "Do not redesign the plan. If a step cannot be applied, say which one and why. Finish with a short list of the files you changed.",
].join("\n")

/** Checks "provider/model"; throws a readable error naming the setting. */
export function checkModel(name: string, value: string | undefined) {
  if (value === undefined) return
  if (!/^[^/\s]+\/\S+$/.test(value))
    throw new Error(`${name} "${value}" must look like "provider/model", for example "anthropic/claude-sonnet-4-5"`)
}

export function architectAgents(input: {
  settings: { planner_model?: string; editor_model?: string }
  defaults: PermissionV1.Ruleset
  user: PermissionV1.Ruleset
}): Record<string, Info> {
  const { planner_model, editor_model } = input.settings
  checkModel("architect.planner_model", planner_model)
  checkModel("architect.editor_model", editor_model)
  const model = (value: string | undefined) => (value ? Provider.parseModel(value) : undefined)
  return {
    [PLANNER]: {
      name: PLANNER,
      description: "Architect mode: a read-only planner that hands a plan to an editor subagent.",
      mode: "primary",
      native: true,
      options: {},
      prompt: PLANNER_PROMPT,
      model: model(planner_model),
      permission: Permission.merge(
        input.defaults,
        Permission.fromConfig({
          "*": "deny",
          read: { "*": "allow", "*.env": "ask", "*.env.*": "ask", "*.env.example": "allow" },
          grep: "allow",
          glob: "allow",
          list: "allow",
          task: { "*": "deny", [EDITOR]: "allow" },
        }),
        input.user,
      ),
    },
    [EDITOR]: {
      name: EDITOR,
      description: "Applies an edit plan written by the architect.",
      mode: "subagent",
      hidden: true,
      native: true,
      options: {},
      prompt: EDITOR_PROMPT,
      model: model(editor_model),
      permission: Permission.merge(input.defaults, input.user),
    },
  }
}
