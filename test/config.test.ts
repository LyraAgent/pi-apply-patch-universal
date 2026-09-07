import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isTargetModel, normalizeConfig } from "../src/config.ts";

describe("config & model matching", () => {
	it("normalizes empty or partial config to defaults", () => {
		const cfg = normalizeConfig({});
		assert.deepEqual(cfg.providers, []);
		assert.deepEqual(cfg.models, []);
		assert.equal(cfg.disableNativeEdit, true);
		assert.equal(cfg.allowAbsolutePaths, false);
		assert.equal(cfg.addFileOnExisting, "overwrite");
	});

	it("accepts only known addFileOnExisting values", () => {
		assert.equal(normalizeConfig({ addFileOnExisting: "error" }).addFileOnExisting, "error");
		assert.equal(
			normalizeConfig({ addFileOnExisting: "nonsense" as never }).addFileOnExisting,
			"overwrite",
		);
	});

	it("returns false for all models when config is empty", () => {
		const cfg = normalizeConfig({ providers: [], models: [] });
		assert.equal(isTargetModel({ provider: "anthropic", id: "claude-3-7-sonnet" }, cfg), false);
		assert.equal(isTargetModel({ provider: "openai", id: "gpt-4o" }, cfg), false);
	});

	it("matches models by provider ID", () => {
		const cfg = normalizeConfig({ providers: ["cliproxy", "custom-relay"], models: [] });
		assert.equal(isTargetModel({ provider: "cliproxy", id: "claude-3-7-sonnet" }, cfg), true);
		assert.equal(isTargetModel({ provider: "custom-relay", id: "deepseek-r1" }, cfg), true);
		assert.equal(isTargetModel({ provider: "openai", id: "gpt-4o" }, cfg), false);
	});

		it("matches models by full ref, bare id, or colon format", () => {
			const cfg = normalizeConfig({
				providers: [],
				models: [
					"anthropic/claude-3-7-sonnet",
					"gpt-4o",
					"deepseek:deepseek-chat",
				],
			});

			// Match by provider/id
			assert.equal(isTargetModel({ provider: "anthropic", id: "claude-3-7-sonnet" }, cfg), true);
			// Match by bare id
			assert.equal(isTargetModel({ provider: "openai", id: "gpt-4o" }, cfg), true);
			assert.equal(isTargetModel({ provider: "other-relay", id: "gpt-4o" }, cfg), true);
			// Match by provider:id
			assert.equal(isTargetModel({ provider: "deepseek", id: "deepseek-chat" }, cfg), true);
			// Non-matching model
			assert.equal(isTargetModel({ provider: "anthropic", id: "claude-3-5-haiku" }, cfg), false);
		});

		it("matches all models when wildcard '*' is configured in providers or models", () => {
			const cfgProviders = normalizeConfig({ providers: ["*"], models: [] });
			assert.equal(isTargetModel({ provider: "anthropic", id: "claude-3-7-sonnet" }, cfgProviders), true);
			assert.equal(isTargetModel({ provider: "openai", id: "gpt-4o" }, cfgProviders), true);

			const cfgModels = normalizeConfig({ providers: [], models: ["*"] });
			assert.equal(isTargetModel({ provider: "anthropic", id: "claude-3-7-sonnet" }, cfgModels), true);
			assert.equal(isTargetModel({ provider: "openai", id: "gpt-4o" }, cfgModels), true);
		});
	});