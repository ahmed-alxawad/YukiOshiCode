// Background and parallel subagents are off until the config turns them on with
// "subagents": { "background": true, "parallel": true }. The older YUKIOSHI_EXPERIMENTAL_BACKGROUND_SUBAGENTS
// and YUKIOSHI_EXPERIMENTAL_PARALLEL_TASKS switches still turn them on as well.

type Settings = { readonly subagents?: { readonly background?: boolean; readonly parallel?: boolean } }

export function backgroundSubagents(flags: { readonly experimentalBackgroundSubagents: boolean }, cfg: Settings) {
  return flags.experimentalBackgroundSubagents || cfg.subagents?.background === true
}

export function parallelSubagents(flags: { readonly experimentalParallelTasks: boolean }, cfg: Settings) {
  return flags.experimentalParallelTasks || cfg.subagents?.parallel === true
}
