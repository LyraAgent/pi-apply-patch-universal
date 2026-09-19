import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import {
	applyHunksToContent,
	cleanPatchPath,
	combineFileDiffs,
	detectLineEnding,
	generateNumberedDiff,
	normalizeText,
	parseApplyPatch,
	parseHunkHeaderLineNumber,
	prepareApplyPatchArguments,
	restoreLineEndings,
} from "../src/patch.ts";
import { DEFAULT_CONFIG, formatConfigSummary, listProvidersFromCatalog } from "../src/config.ts";

const fakeHomes: string[] = [];

afterEach(async () => {
	for (const home of fakeHomes.splice(0, fakeHomes.length)) {
		await rm(home, { recursive: true, force: true });
	}
});

/**
 * config.ts resolves CONFIG_PATH from os.homedir() at module load. Re-import it
 * with a fresh query string under an overridden HOME so file-backed behavior is
 * tested against a disposable directory instead of the real ~/.pi.
 */
async function importConfigWithFakeHome(): Promise<{
	mod: typeof import("../src/config.ts");
	home: string;
}> {
	const home = await mkdtemp(path.join(os.tmpdir(), "pi-apply-patch-home-"));
	fakeHomes.push(home);
	const prev = process.env.HOME;
	process.env.HOME = home;
	try {
		const mod = await import(`../src/config.ts?home=${encodeURIComponent(home)}`);
		return { mod, home };
	} finally {
		process.env.HOME = prev;
	}
}

describe("cleanPatchPath", () => {
	it("unwraps matching double and single quotes", () => {
		assert.equal(cleanPatchPath('"src/a.ts"'), "src/a.ts");
		assert.equal(cleanPatchPath("'src/a.ts'"), "src/a.ts");
	});

	it("unwraps and trims backticks", () => {
		assert.equal(cleanPatchPath("`src/a.ts`"), "src/a.ts");
	});

	it("strips a leading @ marker", () => {
		assert.equal(cleanPatchPath("@src/a.ts"), "src/a.ts");
	});

	it("converts backslashes to forward slashes", () => {
		assert.equal(cleanPatchPath("src\\nested\\a.ts"), "src/nested/a.ts");
	});

	it("leaves plain paths untouched and ignores mismatched quote pairs", () => {
		assert.equal(cleanPatchPath("src/a.ts"), "src/a.ts");
		assert.equal(cleanPatchPath('"a.ts'), '"a.ts');
	});
});

describe("parseHunkHeaderLineNumber", () => {
	it("parses unified-diff style headers", () => {
		assert.equal(parseHunkHeaderLineNumber("-12,3 +13,4 @@"), 12);
		assert.equal(parseHunkHeaderLineNumber("-7 +8 @@"), 7);
		assert.equal(parseHunkHeaderLineNumber("-42"), 42);
	});

	it("parses a bare leading number as an anchor", () => {
		assert.equal(parseHunkHeaderLineNumber("15"), 15);
	});

	it("ignores zero, junk, and semantic contexts", () => {
		assert.equal(parseHunkHeaderLineNumber("-0,2"), undefined);
		assert.equal(parseHunkHeaderLineNumber("some function name"), undefined);
		assert.equal(parseHunkHeaderLineNumber(undefined), undefined);
		assert.equal(parseHunkHeaderLineNumber(""), undefined);
	});
});

describe("line-ending utilities", () => {
	it("detects the dominant ending", () => {
		assert.equal(detectLineEnding("a\r\nb\r\n"), "\r\n");
		assert.equal(detectLineEnding("a\nb\n"), "\n");
		assert.equal(detectLineEnding("single line"), "\n");
	});

	it("restores CRLF endings on normalized text", () => {
		assert.equal(restoreLineEndings("a\nb\n", "\r\n"), "a\r\nb\r\n");
		assert.equal(restoreLineEndings("a\nb\n", "\n"), "a\nb\n");
	});

	it("normalizes CRLF and lone CR to LF", () => {
		assert.equal(normalizeText("a\r\nb\rc\nd"), "a\nb\nc\nd");
	});
});

describe("applyHunksToContent", () => {
	it("applies multiple hunks sequentially with cursor drift, without touching disk", () => {
		const original = ["alpha", "one", "beta", "two", "gamma"].join("\n");
		const parsed = parseApplyPatch(
			[
				"*** Begin Patch",
				"*** Update File: virtual.txt",
				"@@",
				" alpha",
				"-one",
				"+ONE",
				" beta",
				"@@",
				" beta",
				"+inserted",
				" two",
				" gamma",
				"*** End Patch",
			].join("\n"),
		);
		const result = applyHunksToContent(original, parsed.actions[0]!.hunks, "virtual.ts");
		assert.equal(result, ["alpha", "ONE", "beta", "inserted", "two", "gamma"].join("\n"));
	});
});

describe("combineFileDiffs", () => {
	it("renders per-file headers with counters and move targets", () => {
		const diff = generateNumberedDiff("old\n", "new\n");
		const combined = combineFileDiffs([
			{
				path: "src/a.ts",
				operation: "update",
				added: 1,
				removed: 1,
				diff: diff.diff,
			},
			{
				path: "src/b.ts",
				moveTo: "src/c.ts",
				operation: "update",
				added: 0,
				removed: 0,
				diff: "",
			},
		]);
		assert.ok(combined.includes("@@ +1 -1 U src/a.ts"));
		assert.ok(combined.includes("@@ +0 -0 U src/b.ts -> src/c.ts"));
	});
});

describe("prepareApplyPatchArguments coercion", () => {
	it("stringifies non-string input values", () => {
		assert.deepEqual(prepareApplyPatchArguments({ input: 123 }), { input: "123" });
	});

	it("falls through null-ish primary keys to aliases", () => {
		assert.deepEqual(prepareApplyPatchArguments({ input: null, patch: "p" }), { input: "p" });
		assert.deepEqual(prepareApplyPatchArguments({ patch: undefined, diff: "d" }), { input: "d" });
	});

	it("uses empty string when only null-ish values exist", () => {
		assert.deepEqual(prepareApplyPatchArguments({ input: null, patch: null }), { input: "" });
	});
});

describe("config pure helpers", () => {
	it("DEFAULT_CONFIG is conservative by default", () => {
		assert.deepEqual(DEFAULT_CONFIG.providers, []);
		assert.deepEqual(DEFAULT_CONFIG.models, []);
		assert.equal(DEFAULT_CONFIG.disableNativeEdit, true);
		assert.equal(DEFAULT_CONFIG.allowAbsolutePaths, false);
		assert.equal(DEFAULT_CONFIG.addFileOnExisting, "overwrite");
	});

	it("formatConfigSummary lists every field and the config path", () => {
		const summary = formatConfigSummary({
			providers: ["prov"],
			models: ["prov/model-a"],
			disableNativeEdit: false,
			allowAbsolutePaths: true,
			addFileOnExisting: "error",
		});
		assert.ok(summary.includes("providers: prov"));
		assert.ok(summary.includes("models: prov/model-a"));
		assert.ok(summary.includes("disableNativeEdit: false"));
		assert.ok(summary.includes("allowAbsolutePaths: true"));
		assert.ok(summary.includes("addFileOnExisting: error"));
		assert.ok(summary.includes("config: "));
	});

	it("formatConfigSummary marks empty selections as (none)", () => {
		const summary = formatConfigSummary(DEFAULT_CONFIG);
		assert.ok(summary.includes("providers: (none)"));
		assert.ok(summary.includes("models: (none)"));
	});

	it("listProvidersFromCatalog deduplicates and sorts", () => {
		const providers = listProvidersFromCatalog([
			{ provider: "zeta", id: "m1", ref: "zeta/m1" },
			{ provider: "alpha", id: "m2", ref: "alpha/m2" },
			{ provider: "zeta", id: "m3", ref: "zeta/m3" },
		]);
		assert.deepEqual(providers, ["alpha", "zeta"]);
	});
});

describe("config persistence (hermetic via HOME override)", () => {
	it("loadConfig returns defaults when no config file exists", async () => {
		const { mod, home } = await importConfigWithFakeHome();
		const cfg = mod.loadConfig();
		assert.deepEqual(cfg, DEFAULT_CONFIG);
	});

	it("saveConfig → loadConfig round-trips through the real file", async () => {
		const { mod, home } = await importConfigWithFakeHome();
		mod.saveConfig({
			providers: ["prov"],
			models: ["prov/model-a"],
			disableNativeEdit: false,
			allowAbsolutePaths: true,
			addFileOnExisting: "error",
		});
		const loaded = mod.loadConfig();
		assert.deepEqual(loaded.providers, ["prov"]);
		assert.deepEqual(loaded.models, ["prov/model-a"]);
		assert.equal(loaded.disableNativeEdit, false);
		assert.equal(loaded.allowAbsolutePaths, true);
		assert.equal(loaded.addFileOnExisting, "error");
	});

	it("saveConfig normalizes junk values before persisting", async () => {
		const { mod, home } = await importConfigWithFakeHome();
		mod.saveConfig({
			providers: ["prov", "", 42] as unknown as string[],
			models: [],
			disableNativeEdit: "yes" as unknown as boolean,
			allowAbsolutePaths: 0 as unknown as boolean,
			addFileOnExisting: "nonsense" as never,
		});
		const loaded = mod.loadConfig();
		assert.deepEqual(loaded.providers, ["prov"]);
		assert.equal(loaded.disableNativeEdit, true);
		assert.equal(loaded.allowAbsolutePaths, false);
		assert.equal(loaded.addFileOnExisting, "overwrite");
	});

	it("loadConfig falls back to the legacy config path", async () => {
		const { mod, home } = await importConfigWithFakeHome();
		const legacyDir = path.join(home, ".pi", "agent");
		await mkdir(legacyDir, { recursive: true });
		await writeFile(
			path.join(legacyDir, "configurable-apply-patch.json"),
			JSON.stringify({ providers: ["legacy-prov"] }),
			"utf8",
		);
		assert.deepEqual(mod.loadConfig().providers, ["legacy-prov"]);
	});

	it("loadConfig tolerates a corrupt JSON file", async () => {
		const { mod, home } = await importConfigWithFakeHome();
		await mkdir(path.dirname(mod.CONFIG_PATH), { recursive: true });
		await writeFile(mod.CONFIG_PATH, "{ not json", "utf8");
		assert.deepEqual(mod.loadConfig(), DEFAULT_CONFIG);
	});

	it("loadModelsCatalog reads models.json and sorts by ref", async () => {
		const { mod, home } = await importConfigWithFakeHome();
		await mkdir(path.dirname(mod.MODELS_JSON_PATH), { recursive: true });
		await writeFile(
			mod.MODELS_JSON_PATH,
			JSON.stringify({
				providers: {
					"zeta-relay": { models: [{ id: "model-z" }] },
					"alpha-relay": { models: [{ id: "model-a", name: "Model A" }, {}] },
				},
			}),
			"utf8",
		);
		const catalog = mod.loadModelsCatalog();
		assert.deepEqual(
			catalog.map((m) => m.ref),
			["alpha-relay/model-a", "zeta-relay/model-z"],
		);
		assert.equal(catalog[0]?.name, "Model A");
	});

	it("loadModelsCatalog returns [] for a missing or corrupt file", async () => {
		const { mod: missing } = await importConfigWithFakeHome();
		assert.deepEqual(missing.loadModelsCatalog(), []);

		const { mod: corrupt } = await importConfigWithFakeHome();
		await mkdir(path.dirname(corrupt.MODELS_JSON_PATH), { recursive: true });
		await writeFile(corrupt.MODELS_JSON_PATH, "]]] junk", "utf8");
		assert.deepEqual(corrupt.loadModelsCatalog(), []);
	});
});
