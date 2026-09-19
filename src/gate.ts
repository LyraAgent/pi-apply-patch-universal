/**
 * Pure tool_call gating rules for the apply_patch extension.
 *
 * Kept free of Pi runtime types so the decision logic is unit-testable.
 */
import type { ApplyPatchConfig } from "./config.ts";

export interface ToolCallLike {
	toolName: string;
	input?: unknown;
}

export interface GateDecision {
	block: boolean;
	reason?: string;
}

/** Matches shell invocations of apply_patch, including heredoc forms. */
const SHELL_APPLY_PATCH_PATTERN = /\bapply[-_]?patch\b/i;

export function isShellApplyPatchInvocation(command: string): boolean {
	return SHELL_APPLY_PATCH_PATTERN.test(command);
}

export function assessToolCall(
	event: ToolCallLike,
	active: boolean,
	config: Pick<ApplyPatchConfig, "disableNativeEdit">,
): GateDecision | undefined {
	if (event.toolName === "apply_patch" && !active) {
		return {
			block: true,
			reason: "apply_patch only enabled for configured providers/models. Run /apply-patch.",
		};
	}

	if (active && config.disableNativeEdit && (event.toolName === "edit" || event.toolName === "write")) {
		return {
			block: true,
			reason: "Native edit/write disabled on this model. Use apply_patch.",
		};
	}

	// Steer models away from routing patches through the shell (heredocs,
	// misspelled tool names like `applypatch`/`apply-patch`). Mirrors Codex's
	// legacy exec-command guidance.
	if (active && (event.toolName === "bash" || event.toolName === "powershell")) {
		const input = event.input as { command?: unknown } | undefined;
		const command = typeof input?.command === "string" ? input.command : "";
		if (command && isShellApplyPatchInvocation(command)) {
			return {
				block: true,
				reason:
					"apply_patch must be invoked as a native tool call, never through the shell. " +
					"Call the apply_patch tool directly with the complete patch text as its input argument.",
			};
		}
	}

	return undefined;
}
