import { PATHS } from "../../constants";
import type { Module, ModuleRules } from "../../types";
import { runHybridMountJson } from "../core/bridge";
import { isBoolean, isRecord, isString } from "../core/guards";
import { shellEscapeDoubleQuoted } from "../core/shell";
import { loadConfigFromFile } from "../repos/configRepo";
import { normalizeMountMode, normalizeStringMap } from "../codec/configCodec";

function normalizeModulePayload(value: unknown): Module {
  const payload = isRecord(value) ? value : {};
  const rulesPayload = isRecord(payload.rules) ? payload.rules : {};
  return {
    id: isString(payload.id) ? payload.id : "",
    name: isString(payload.name)
      ? payload.name
      : isString(payload.id)
        ? payload.id
        : "",
    version: isString(payload.version) ? payload.version : "unknown",
    author: isString(payload.author) ? payload.author : "unknown",
    description: isString(payload.description)
      ? payload.description
      : "No description",
    mode: normalizeMountMode(payload.mode),
    is_mounted: isBoolean(payload.is_mounted) ? payload.is_mounted : false,
    enabled: isBoolean(payload.enabled) ? payload.enabled : true,
    source_path: isString(payload.source_path)
      ? payload.source_path
      : undefined,
    rules: {
      default_mode: normalizeMountMode(rulesPayload.default_mode),
      paths: normalizeStringMap(rulesPayload.paths),
    },
  };
}

async function applyModulesPayload(modules: Module[]): Promise<void> {
  const payload = modules.map((module) => ({
    id: module.id,
    enabled: module.enabled ?? true,
    source_path: module.source_path,
    rules: {
      default_mode: normalizeMountMode(module.rules.default_mode),
      paths: normalizeStringMap(module.rules.paths),
    },
  }));
  const encoded = shellEscapeDoubleQuoted(JSON.stringify(payload));
  await runHybridMountJson(`api modules-apply "${encoded}"`, PATHS.BINARY);
}

export async function scanModules(path?: string): Promise<Module[]> {
  const suffix = path?.trim()
    ? ` --path "${shellEscapeDoubleQuoted(path.trim())}"`
    : "";
  const payload = await runHybridMountJson(
    `api modules-list${suffix}`,
    PATHS.BINARY,
  );
  if (!Array.isArray(payload)) {
    throw new Error("modules payload is invalid");
  }
  return payload.map(normalizeModulePayload);
}

export async function saveModules(modules: Module[]): Promise<void> {
  await applyModulesPayload(modules);
}

export async function saveModuleRules(
  moduleId: string,
  rules: ModuleRules,
): Promise<void> {
  const config = await loadConfigFromFile();
  const module = {
    id: moduleId,
    enabled: true,
    rules: {
      default_mode: normalizeMountMode(rules.default_mode, config.default_mode),
      paths: normalizeStringMap(rules.paths),
    },
  } as Module;
  await applyModulesPayload([module]);
}

export async function saveAllModuleRules(
  rules: Record<string, ModuleRules>,
): Promise<void> {
  const config = await loadConfigFromFile();
  const payload = Object.entries(rules).map(([moduleId, moduleRules]) => ({
    id: moduleId,
    enabled: true,
    rules: {
      default_mode: normalizeMountMode(
        moduleRules.default_mode,
        config.default_mode,
      ),
      paths: normalizeStringMap(moduleRules.paths),
    },
  })) as Module[];
  await applyModulesPayload(payload);
}
