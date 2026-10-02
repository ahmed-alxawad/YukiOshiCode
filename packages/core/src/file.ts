export * as File from "./file"

import { Revert } from "@yukioshi/schema/revert"

export const Diff = Revert.FileDiff
export type Diff = typeof Diff.Type
