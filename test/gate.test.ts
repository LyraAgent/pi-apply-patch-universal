import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { assessToolCall, isShellApplyPatchInvocation } from "../src/gate.ts";

describe("isShellApplyPatchInvocation", () => {
	it("matches heredoc and plain invocations", () => {
		assert.ok(isShellApplyPatchInvocation("apply_patch <<'EOF'\n*** Begin Patch\n*** End Patch\nEOF"));
		assert.ok(isShellApplyPatchInvocation("cd /app && apply_patch <<'EOF'..."));
		assert.ok(isShellApplyPatchInvocation("apply-patch something"));
		assert.ok(isShellApplyPatchInvocation("APPLY_PATCH <<EOF"));
	});

	it("does not match unrelated commands", () => {
		assert.ok(!isShellApplyPatchInvocation("ls -la"));
		assert.ok(!isShellApplyPatchInvocation("echo 'applying patches now'"));
		assert.ok(!isShellApplyPatchInvocation("git apply some.patch"));
	});
});

describe("assessToolCall", () => {
	const baseConfig = { disableNativeEdit: true };

	it("blocks apply_patch when inactive and allows it when active", () => {
		const blocked = assessToolCall({ toolName: "apply_patch" }, false, baseConfig);
		assert.ok(blocked?.block);
		assert.match(blocked!.reason ?? "", /Run \/apply-patch/);

		assert.equal(assessToolCall({ toolName: "apply_patch" }, true, baseConfig), undefined);
	});

	it("blocks edit/write when active with disableNativeEdit", () => {
		const blocked = assessToolCall({ toolName: "edit" }, true, baseConfig);
		assert.ok(blocked?.block);
		assert.equal(assessToolCall({ toolName: "edit" }, true, { disableNativeEdit: false }), undefined);
		assert.equal(assessToolCall({ toolName: "edit" }, false, baseConfig), undefined);
	});

	it("blocks shell apply_patch detours only while the tool is active", () => {
		const heredoc = { toolName: "bash", input: { command: "apply_patch <<'EOF'\nx\nEOF" } };
		const blocked = assessToolCall(heredoc, true, baseConfig);
		assert.ok(blocked?.block);
		assert.match(blocked!.reason ?? "", /native tool call/);

		assert.equal(assessToolCall(heredoc, false, baseConfig), undefined);
	});

	it("allows ordinary bash commands", () => {
		assert.equal(
			assessToolCall({ toolName: "bash", input: { command: "rg apply ./src" } }, true, baseConfig),
			undefined,
		);
		assert.equal(
			assessToolCall({ toolName: "bash", input: { command: "git apply foo.patch" } }, true, baseConfig),
			undefined,
		);
	});

	it("tolerates missing or malformed bash input", () => {
		assert.equal(assessToolCall({ toolName: "bash" }, true, baseConfig), undefined);
		assert.equal(assessToolCall({ toolName: "bash", input: {} }, true, baseConfig), undefined);
		assert.equal(
			assessToolCall({ toolName: "bash", input: { command: 42 } }, true, baseConfig),
			undefined,
		);
	});
});
