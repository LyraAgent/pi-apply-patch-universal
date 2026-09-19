/**
 * Normalizes tool call arguments across different LLM providers/models.
 * Supports { input }, { patch }, { diff }, { content }, or raw string.
 */
export function prepareApplyPatchArguments(args: unknown): { input: string } {
	if (typeof args === "string") {
		return { input: args };
	}
	if (typeof args === "object" && args !== null) {
		const record = args as Record<string, unknown>;
		const input = record.input ?? record.patch ?? record.diff ?? record.content ?? "";
		return { input: typeof input === "string" ? input : String(input) };
	}
	return { input: "" };
}
