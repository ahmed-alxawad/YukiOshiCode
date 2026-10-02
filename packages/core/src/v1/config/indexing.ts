export * as ConfigIndexingV1 from "./indexing"

import { Schema } from "effect"

// Deliberately not a full mirror of @yukioshi/indexing's own (much larger) config schema:
// that package already has a correct, tested zod schema (provider options, vector store
// settings, search/scan tuning) and this one would only drift from it. This just carries the
// raw object through YukiOshi's own config; the indexing service validates it for real with
// @yukioshi/indexing's own schema at the point it's actually used.
export const Info = Schema.Record(Schema.String, Schema.Unknown).annotate({
  identifier: "IndexingConfig",
  description:
    "Semantic code search/indexing configuration (embedding provider, vector store, model). Validated by @yukioshi/indexing's own schema - see its docs for the full field list.",
})
export type Info = Schema.Schema.Type<typeof Info>
