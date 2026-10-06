import path from "path"
import { Effect, Schema } from "effect"
import { Global } from "@yukioshi/core/global"
import { Config } from "@/config/config"
import { Skill } from "../skill"
import { LearnedSkills } from "../skill/learned"
import * as Tool from "./tool"

const DESCRIPTION = `Save a procedure you worked out as a skill you can load in later sessions, or remove one you saved.

Save a skill after finishing a task that needed a non-obvious, multi-step procedure you are likely to need again: a release process, a fix for a recurring build problem, a project-specific workflow. Write the steps so they work without this conversation: what it is for, the exact commands, what to check, and the pitfalls you hit.

Do not save one-off facts, secrets, or anything the project's own docs already say. Saving with the name of an existing learned skill replaces it, so update a skill rather than adding a near-copy.`

export const Parameters = Schema.Struct({
  action: Schema.Literals(["save", "remove"]).annotate({ description: "save (create or replace) or remove" }),
  name: Schema.String.annotate({
    description: `Lowercase words joined by hyphens, at most ${LearnedSkills.NAME_MAX} characters, e.g. release-yukioshi`,
  }),
  description: Schema.optional(Schema.String).annotate({
    description: `One sentence saying when to use the skill (at most ${LearnedSkills.DESCRIPTION_MAX} characters). Required for save.`,
  }),
  content: Schema.optional(Schema.String).annotate({
    description: `The skill's instructions in Markdown (at most ${LearnedSkills.CONTENT_MAX} characters). Required for save.`,
  }),
})

export const SkillSaveTool = Tool.define(
  "skill_save",
  Effect.gen(function* () {
    const skills = yield* Skill.Service
    const config = yield* Config.Service
    const global = yield* Global.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: Schema.Schema.Type<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const learn = LearnedSkills.settings((yield* config.get()).skills?.learn)
          const dir = LearnedSkills.root(global.data)
          const name = params.name.trim()
          const fail = (output: string) => ({ title: `Skill not saved: ${name}`, output, metadata: { name } })

          if (!LearnedSkills.validName(name))
            return fail(`"${name}" is not a valid skill name. Use lowercase words joined by hyphens, e.g. fix-flaky-build.`)

          if (params.action === "remove") {
            yield* ctx.ask({ permission: "skill_save", patterns: [name], always: [], metadata: { action: "remove", name } })
            const removed = yield* Effect.promise(() => LearnedSkills.remove(dir, name))
            return {
              title: removed ? `Skill retired: ${name}` : `No learned skill named ${name}`,
              output: removed
                ? `Moved ${name} to the archive. It is no longer listed from the next session.`
                : `There is no learned skill named ${name}. Only skills you saved with skill_save can be removed.`,
              metadata: { name },
            }
          }

          const description = (params.description ?? "").replace(/\s+/g, " ").trim()
          const content = (params.content ?? "").trim()
          if (!description || !content) return fail("Both description and content are needed to save a skill.")
          if (description.length > LearnedSkills.DESCRIPTION_MAX)
            return fail(`The description is ${description.length} characters; keep it to ${LearnedSkills.DESCRIPTION_MAX}.`)
          if (content.length > LearnedSkills.CONTENT_MAX)
            return fail(`The content is ${content.length} characters; keep it to ${LearnedSkills.CONTENT_MAX}.`)

          // Never shadow a bundled, project, or user skill: a learned skill gets a name of its own.
          const taken = yield* skills.get(name)
          if (taken && !taken.location.startsWith(dir + path.sep))
            return fail(`A skill named ${name} already exists (${taken.location}). Choose a different name.`)

          yield* ctx.ask({
            permission: "skill_save",
            patterns: [name],
            always: [],
            metadata: { action: "save", name, description, content },
          })
          const result = yield* Effect.promise(() =>
            LearnedSkills.save(dir, { name, description, content, max: learn.max, staleDays: learn.staleDays }),
          )
          if (result.status === "similar")
            return fail(
              `A learned skill with a similar purpose exists: ${result.similar}. Load it, and save under the name ${result.similar} to update it instead of adding a near-copy.`,
            )
          return {
            title: `Skill ${result.status}: ${name}`,
            output: [
              `${result.status === "updated" ? "Updated" : "Saved"} the skill ${name}. It is listed from the next session.`,
              ...(result.retired.length > 0
                ? [`Retired to keep the set small: ${result.retired.join(", ")}.`]
                : []),
            ].join("\n"),
            metadata: { name },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
