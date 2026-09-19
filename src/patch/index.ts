/**
 * Public API of the Codex-style patch engine.
 *
 * Module layout:
 * - types.ts         shared type definitions
 * - args.ts          LLM tool-argument normalization
 * - parse.ts         patch envelope parsing (markers, headers, hunks)
 * - paths.ts         target path resolution and workspace-escape safety
 * - line-endings.ts  line-ending detection/normalization/restoration
 * - candidates.ts    line normalization + hunk candidate generation
 * - diagnostics.ts   self-healing hunk failure diagnostics
 * - match.ts         hunk matching engine
 * - diff.ts          numbered diff generation
 * - apply.ts         atomic applyPatch orchestration with rollback
 */
export type {
	AddFileOnExisting,
	ApplyPatchFileDiff,
	ApplyPatchOptions,
	ApplyPatchProgress,
	ApplyPatchProgressFile,
	ApplyPatchResult,
	PatchAction,
	PatchActionKind,
	PatchHunk,
} from "./types.ts";
export { prepareApplyPatchArguments } from "./args.ts";
export { cleanPatchPath, parseApplyPatch, parseHunkHeaderLineNumber } from "./parse.ts";
export { resolvePatchPath } from "./paths.ts";
export { detectLineEnding, normalizeText, restoreLineEndings } from "./line-endings.ts";
export { applyHunksToContent, applyHunksToLines } from "./match.ts";
export { combineFileDiffs, generateNumberedDiff, operationCode } from "./diff.ts";
export { applyPatch } from "./apply.ts";
