import assert from "node:assert/strict";
import test, { describe, it } from "node:test";
import { parseApplyPatchInputProgress } from "../src/progress.ts";

describe("parseApplyPatchInputProgress", () => {
	it("tracks counts from partial streamed input", () => {
		const progress = parseApplyPatchInputProgress(`*** Begin Patch
*** Update File: src/app.ts
@@
-old line
+new line`);

		assert.equal(progress.totalOperations, 1);
		assert.equal(progress.ended, false);
		assert.deepEqual(progress.files, [
			{
				path: "src/app.ts",
				operation: "update",
				added: 1,
				removed: 1,
			},
		]);
	});

	it("tracks add/delete/update and move targets", () => {
		const progress = parseApplyPatchInputProgress(`*** Begin Patch
*** Add File: a.txt
+hello
+world
*** Delete File: b.txt
*** Update File: old.ts
*** Move to: new.ts
@@
-old
+new
*** End Patch
`);

		assert.equal(progress.totalOperations, 3);
		assert.equal(progress.ended, true);
		assert.deepEqual(progress.files, [
			{ path: "a.txt", operation: "add", added: 2, removed: 0 },
			{ path: "b.txt", operation: "delete", added: 0, removed: 0 },
			{ path: "old.ts", moveTo: "new.ts", operation: "update", added: 1, removed: 1 },
		]);
	});

	it("ignores content before begin patch", () => {
		const progress = parseApplyPatchInputProgress(`random preface
*** Begin Patch
*** Add File: only.txt
+ok`);
		assert.equal(progress.totalOperations, 1);
		assert.equal(progress.files[0]?.path, "only.txt");
	});

	it("handles tolerant headers and prefixed end markers", () => {
		const progress = parseApplyPatchInputProgress(`*** Begin Patch
  *** Create File: "spaced/file.txt"
+1
+2
+3
*** Update File: \`backticked.ts\`
*** Rename to: dest.ts
@@
-a
+b
+*** End Patch`);

		assert.equal(progress.totalOperations, 2);
		assert.equal(progress.ended, true);
		assert.deepEqual(progress.files, [
			{ path: "spaced/file.txt", operation: "add", added: 3, removed: 0 },
			{ path: "backticked.ts", moveTo: "dest.ts", operation: "update", added: 1, removed: 1 },
		]);
	});

	it("handles empty or partial inputs safely", () => {
		assert.deepEqual(parseApplyPatchInputProgress(""), { totalOperations: 0, files: [], ended: false });
		assert.deepEqual(parseApplyPatchInputProgress("*** Begin Patch"), { totalOperations: 0, files: [], ended: false });
	});

	it("does not mistake body content lines for file headers", () => {
		// An Add File body documenting patch syntax: '+*** Delete File:' is content.
		const progress = parseApplyPatchInputProgress(`*** Begin Patch
*** Add File: docs/patch-guide.md
+# Patch syntax
+*** Delete File: old.txt
+more docs
*** End Patch`);

		assert.equal(progress.totalOperations, 1);
		assert.equal(progress.files[0]?.path, "docs/patch-guide.md");
		assert.equal(progress.files[0]?.added, 3);
	});

	it("treats lone carriage returns as line terminators", () => {
		const progress = parseApplyPatchInputProgress(
			"*** Begin Patch\r*** Update File: a.ts\r@@\r-old\r+new\r*** End Patch",
		);

		assert.equal(progress.totalOperations, 1);
		assert.equal(progress.ended, true);
		assert.deepEqual(progress.files, [
			{ path: "a.ts", operation: "update", added: 1, removed: 1 },
		]);
	});

	it("ignores Move to when no update action precedes it", () => {
		const progress = parseApplyPatchInputProgress(`*** Begin Patch
*** Delete File: b.txt
*** Move to: stray.ts
*** End Patch`);

		assert.equal(progress.totalOperations, 1);
		assert.equal(progress.files[0]?.moveTo, undefined);
	});

	it("counts +@@ content lines in add bodies but skips bare @@ hunk markers", () => {
		const progress = parseApplyPatchInputProgress(`*** Begin Patch
*** Add File: template.txt
+line one
+@@ literal marker in content
+line three
*** End Patch`);

		assert.equal(progress.totalOperations, 1);
		// '+@@ ...' is real file content and must be counted
		assert.equal(progress.files[0]?.added, 3);

		// A bare '@@' line inside an add body is skipped by the hunk-marker rule
		// (display-only undercount inherited from the original parser).
		const bare = parseApplyPatchInputProgress(`*** Begin Patch
*** Add File: template.txt
+line one
@@
+line two
*** End Patch`);
		assert.equal(bare.files[0]?.added, 2);
	});
});