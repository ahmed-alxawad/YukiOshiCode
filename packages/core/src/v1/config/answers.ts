export * as ConfigAnswersV1 from "./answers"

import { Schema } from "effect"

export const Info = Schema.Struct({
  language: Schema.optional(Schema.Literals(["english", "bangla", "mixed", "auto"])).annotate({
    description:
      "Language of the agent's explanations to the user: english, bangla (polite আপনি form), mixed (English technical terms inline in Bangla), or auto (match the user's message language). Code, identifiers and commit messages stay English in every mode, and the interface stays English. Unset behaves like english with no directive added.",
  }),
})
export type Info = Schema.Schema.Type<typeof Info>
