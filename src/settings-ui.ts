import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	type ApplyPatchConfig,
	formatConfigSummary,
	listProvidersFromCatalog,
	loadConfig,
	loadModelsCatalog,
	saveConfig,
} from "./config.js";

function mark(on: boolean): string {
	return on ? "[x]" : "[ ]";
}

function toggleInList(list: string[], value: string): string[] {
	const set = new Set(list);
	if (set.has(value)) set.delete(value);
	else set.add(value);
	return [...set].sort();
}

async function editProviders(ctx: ExtensionCommandContext, config: ApplyPatchConfig): Promise<ApplyPatchConfig> {
	const catalog = loadModelsCatalog();
	const providers = listProvidersFromCatalog(catalog);
	if (providers.length === 0) {
		ctx.ui.notify("No providers found in ~/.pi/agent/models.json", "warning");
		return config;
	}

	let next = { ...config, providers: [...config.providers] };
	while (true) {
		const choices = [
			...providers.map((provider) => `${mark(next.providers.includes(provider))} ${provider}`),
			"← Back",
		];
		const pick = await ctx.ui.select(
			`Providers (${next.providers.length} enabled) — select to toggle`,
			choices,
		);
		if (!pick || pick === "← Back") break;
		const provider = pick.replace(/^\[[ x]\]\s+/, "");
		next = { ...next, providers: toggleInList(next.providers, provider) };
		saveConfig(next);
	}
	return next;
}

async function editModels(ctx: ExtensionCommandContext, config: ApplyPatchConfig): Promise<ApplyPatchConfig> {
	const catalog = loadModelsCatalog();
	if (catalog.length === 0) {
		ctx.ui.notify("No models found in ~/.pi/agent/models.json", "warning");
		return config;
	}

	let next = { ...config, models: [...config.models] };
	while (true) {
		const choices = [
			...catalog.map((model) => {
				const on = next.models.includes(model.ref) || next.models.includes(model.id);
				const label = model.name ? `${model.ref}  (${model.name})` : model.ref;
				return `${mark(on)} ${label}`;
			}),
			"← Back",
		];
		const pick = await ctx.ui.select(
			`Models (${next.models.length} enabled) — select to toggle`,
			choices,
		);
		if (!pick || pick === "← Back") break;
		const body = pick.replace(/^\[[ x]\]\s+/, "");
		const ref = body.split(/\s{2,}/)[0] ?? body;
		// always store full provider/id
		const catalogHit = catalog.find((m) => m.ref === ref || m.id === ref);
		const value = catalogHit?.ref ?? ref;
		// clear bare-id duplicates of same model
		const filtered = next.models.filter((entry) => entry !== value && entry !== catalogHit?.id);
		const enabled = next.models.includes(value) || (catalogHit ? next.models.includes(catalogHit.id) : false);
		next = {
			...next,
			models: enabled ? filtered : [...filtered, value].sort(),
		};
		saveConfig(next);
	}
	return next;
}

export async function openApplyPatchSettings(
	ctx: ExtensionCommandContext,
	onSaved?: (config: ApplyPatchConfig) => void,
): Promise<void> {
	if (ctx.mode !== "tui") {
		ctx.ui.notify(formatConfigSummary(loadConfig()), "info");
		return;
	}

	let config = loadConfig();
	while (true) {
		const choices = [
			`Providers  (${config.providers.length ? config.providers.join(", ") : "none"})`,
			`Models     (${config.models.length ? config.models.length + " selected" : "none"})`,
			`disableNativeEdit   ${mark(config.disableNativeEdit)}  hide edit/write when active`,
			`allowAbsolutePaths  ${mark(config.allowAbsolutePaths)}  allow paths outside cwd`,
			`addFileOnExisting   ${config.addFileOnExisting}  Add File on an existing path`,
			"Show config path / summary",
			"Clear all targets",
			"Done",
		];
		const pick = await ctx.ui.select("apply_patch config", choices);
		if (!pick || pick === "Done") break;

		if (pick.startsWith("Providers")) {
			config = await editProviders(ctx, config);
			onSaved?.(config);
			continue;
		}
		if (pick.startsWith("Models")) {
			config = await editModels(ctx, config);
			onSaved?.(config);
			continue;
		}
		if (pick.startsWith("disableNativeEdit")) {
			config = { ...config, disableNativeEdit: !config.disableNativeEdit };
			saveConfig(config);
			onSaved?.(config);
			continue;
		}
		if (pick.startsWith("allowAbsolutePaths")) {
			config = { ...config, allowAbsolutePaths: !config.allowAbsolutePaths };
			saveConfig(config);
			onSaved?.(config);
			continue;
		}
		if (pick.startsWith("addFileOnExisting")) {
			config = {
				...config,
				addFileOnExisting: config.addFileOnExisting === "overwrite" ? "error" : "overwrite",
			};
			saveConfig(config);
			onSaved?.(config);
			continue;
		}
		if (pick.startsWith("Show config")) {
			ctx.ui.notify(formatConfigSummary(config), "info");
			continue;
		}
		if (pick.startsWith("Clear all")) {
			const ok = await ctx.ui.confirm("Clear targets?", "Remove all providers and models from apply_patch config?");
			if (ok) {
				config = { ...config, providers: [], models: [] };
				saveConfig(config);
				onSaved?.(config);
				ctx.ui.notify("Cleared. apply_patch inactive until you select targets.", "info");
			}
		}
	}

	ctx.ui.notify(
		`Saved. Active targets — providers: ${config.providers.length || 0}, models: ${config.models.length || 0}`,
		"info",
	);
}
