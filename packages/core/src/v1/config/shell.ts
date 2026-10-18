import { Schema } from "effect"

export class Info extends Schema.Class<Info>("ConfigShellV1.Info")({
  kill_on_exit: Schema.optional(Schema.Boolean).annotate({
    description: "Terminate shell commands when YukiOshi exits (off by default)",
  }),
  backend: Schema.optional(Schema.Literals(["local", "docker", "ssh"])).annotate({
    description: "Where shell commands run: local (default), docker or ssh. Global config only; a project cannot set it.",
  }),
  docker: Schema.optional(
    Schema.Struct({
      image: Schema.String.annotate({ description: "Image every command runs in" }),
      network: Schema.optional(Schema.String).annotate({ description: 'Docker network, default "none"' }),
      mount: Schema.optional(Schema.Literal("project")).annotate({ description: "What is mounted at /work" }),
    }),
  ),
  ssh: Schema.optional(
    Schema.Struct({
      host: Schema.String,
      user: Schema.optional(Schema.String),
      port: Schema.optional(Schema.Number),
      identity_file: Schema.optional(Schema.String),
    }),
  ),
}) {}
