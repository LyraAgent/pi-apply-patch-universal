import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AddFileOnExisting } from "./patch.js";

export type ApplyPatchConfig = {
	/** Enable for these provider ids (e.g. "aio"). */
	providers: string[];
	/** Enable for these model refs: "provider/id" or bare "id". */
	models: string[];
	/** When active, hide native edit/write and block them. */
	disableNativeEdit: boolean;
	/** Allow patch paths outside cwd. Default false. */
	allowAbsolutePaths: boolean;
	/** '*** Add File:' on an existing path: overwrite it or fail. Default "overwrite". */
	addFileOnExisting: AddFileOnExisting;
};

export const DEFAULT_CONFIG: ApplyPatchConfig = {
	providers: [],
	models: [],
	disableNativeEdit: true,
	allowAbsolutePaths: false,
	addFileOnExisting: "overwrite",
};

const LEGACY_CONFIG_PATH = join(homedir(), ".pi", "agent", "configurable-apply-patch.json");
export const CONFIG_PATH = join(homedir(), ".pi", "agent", "pi-apply-patch.json");
export const MODELS_JSON_PATH = join(homedir(), ".pi", "agent", "models.json");

function asStringList(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

export function normalizeConfig(raw: Partial<ApplyPatchConfig> | null | undefined): ApplyPatchConfig {
	return {
		providers: asStringList(raw?.providers),
		models: asStringList(raw?.models),
		disableNativeEdit: raw?.disableNativeEdit !== false,
		allowAbsolutePaths: raw?.allowAbsolutePaths === true,
		addFileOnExisting: raw?.addFileOnExisting === "error" ? "error" : "overwrite",
	};
}

export function loadConfig(): ApplyPatchConfig {
	const path = existsSync(CONFIG_PATH)
		? CONFIG_PATH
		: existsSync(LEGACY_CONFIG_PATH)
			? LEGACY_CONFIG_PATH
			: null;
	if (!path) return { ...DEFAULT_CONFIG, providers: [...DEFAULT_CONFIG.providers], models: [...DEFAULT_CONFIG.models] };

	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<ApplyPatchConfig>;
		return normalizeConfig(raw);
	} catch {
		return { ...DEFAULT_CONFIG, providers: [], models: [] };
	}
}

export function saveConfig(config: ApplyPatchConfig): void {
	const next = normalizeConfig(config);
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

export type CatalogModel = {
	provider: string;
	id: string;
	name?: string;
	ref: string;
};

/** Models declared in ~/.pi/agent/models.json */
export function loadModelsCatalog(): CatalogModel[] {
	if (!existsSync(MODELS_JSON_PATH)) return [];
	try {
		const data = JSON.parse(readFileSync(MODELS_JSON_PATH, "utf8")) as {
			providers?: Record<
				string,
				{
					models?: Array<{ id?: string; name?: string }>;
				}
			>;
		};
		const out: CatalogModel[] = [];
		for (const [provider, def] of Object.entries(data.providers ?? {})) {
			for (const model of def.models ?? []) {
				if (!model?.id) continue;
				out.push({
					provider,
					id: model.id,
					name: model.name,
					ref: `${provider}/${model.id}`,
				});
			}
		}
		out.sort((a, b) => a.ref.localeCompare(b.ref));
		return out;
	} catch {
		return [];
	}
}

export function listProvidersFromCatalog(catalog: CatalogModel[]): string[] {
	return [...new Set(catalog.map((m) => m.provider))].sort();
}

export function isTargetModel(
	model: { provider?: string; id?: string } | undefined,
	config: ApplyPatchConfig,
): boolean {
	if (!model?.provider || !model.id) return false;
	if (config.providers.includes("*") || config.models.includes("*")) return true;
	if (config.models.length === 0 && config.providers.length === 0) return false;

	const full = `${model.provider}/${model.id}`;
	for (const entry of config.models) {
		if (entry === full || entry === model.id || entry === `${model.provider}:${model.id}`) {
			return true;
		}
	}
	return config.providers.includes(model.provider);
}

export function formatConfigSummary(config: ApplyPatchConfig): string {
	const providers = config.providers.length > 0 ? config.providers.join(", ") : "(none)";
	const models = config.models.length > 0 ? config.models.join(", ") : "(none)";
	return [
		`providers: ${providers}`,
		`models: ${models}`,
		`disableNativeEdit: ${config.disableNativeEdit}`,
		`allowAbsolutePaths: ${config.allowAbsolutePaths}`,
		`addFileOnExisting: ${config.addFileOnExisting}`,
		`config: ${CONFIG_PATH}`,
	].join("\n");
}
