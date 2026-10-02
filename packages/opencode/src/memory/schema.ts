// Simplified from Kilo Code's packages/kilo-memory/src/schema.ts (MIT License): the three-file
// taxonomy (general project facts, environment facts, user corrections) is kept, but the
// auto-capture/consolidation state (stats, capture tuning, limits, a persisted enabled toggle) is
// dropped - this port is explicit-only (no automatic LLM-driven memory extraction from
// conversation turns), and whether memory is active at all is the memory.enabled config value,
// not separate per-project state.
export namespace MemorySchema {
  export const Sources = ["project.md", "environment.md", "corrections.md"] as const
  export type Source = (typeof Sources)[number]
}
