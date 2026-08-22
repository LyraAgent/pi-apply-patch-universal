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
});