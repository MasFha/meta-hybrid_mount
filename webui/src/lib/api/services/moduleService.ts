import { PATHS } from "../../constants";
import type { Module, ModuleRules } from "../../types";
import { readModuleProp, runHybridMountJson } from "../core/bridge";
import { isBoolean, isRecord, isString } from "../core/guards";
import { shellEscapeDoubleQuoted } from "../core/shell";
import { normalizeMountMode, normalizeStringMap } from "../codec/configCodec";

interface ModuleRuntimeEntry {
  id: string;
  mode: Module["mode"];
  is_mounted: boolean;
  enabled: boolean;
  source_path?: string;
  rules: ModuleRules;
  metadata?: ModuleMetadata;
}

interface ModuleMetadata {
  name: string;
  version: string;
  author: string;
  description: string;
}

function defaultModuleMetadata(moduleId: string): ModuleMetadata {
  return {
    name: moduleId,
    version: "unknown",
    author: "unknown",
    description: "No description",
  };
}

function normalizeModuleRuntimeEntry(value: unknown): ModuleRuntimeEntry {
  const payload = isRecord(value) ? value : {};
  const id = isString(payload.id) ? payload.id : "";
  const rulesPayload = isRecord(payload.rules) ? payload.rules : {};
  const fallbackMetadata = defaultModuleMetadata(id);
  const hasInlineMetadata =
    isString(payload.name) ||
    isString(payload.version) ||
    isString(payload.author) ||
    isString(payload.description);
  return {
    id,
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
    metadata: hasInlineMetadata
      ? {
          name:
            isString(payload.name) && payload.name.trim()
              ? payload.name
              : fallbackMetadata.name,
          version:
            isString(payload.version) && payload.version.trim()
              ? payload.version
              : fallbackMetadata.version,
          author:
            isString(payload.author) && payload.author.trim()
              ? payload.author
              : fallbackMetadata.author,
          description:
            isString(payload.description) && payload.description.trim()
              ? payload.description
              : fallbackMetadata.description,
        }
      : undefined,
  };
}

function parseModuleMetadata(raw: string, moduleId: string): ModuleMetadata {
  const metadata = defaultModuleMetadata(moduleId);
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separator = trimmed.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim();
    if (!value) {
      continue;
    }
    if (key === "name") metadata.name = value;
    else if (key === "version") metadata.version = value;
    else if (key === "author") metadata.author = value;
    else if (key === "description") metadata.description = value;
  }
  return metadata;
}

async function loadModuleMetadata(
  entry: ModuleRuntimeEntry,
): Promise<ModuleMetadata> {
  if (entry.metadata) {
    return entry.metadata;
  }
  if (!entry.source_path?.trim()) {
    return defaultModuleMetadata(entry.id);
  }

  try {
    const raw = await readModuleProp(entry.source_path.trim());
    return parseModuleMetadata(raw, entry.id);
  } catch {
    return defaultModuleMetadata(entry.id);
  }
}

function toModule(entry: ModuleRuntimeEntry, metadata: ModuleMetadata): Module {
  return {
    id: entry.id,
    name: metadata.name,
    version: metadata.version,
    author: metadata.author,
    description: metadata.description,
    mode: entry.mode,
    is_mounted: entry.is_mounted,
    enabled: entry.enabled,
    source_path: entry.source_path,
    rules: entry.rules,
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

  const entries = payload.map(normalizeModuleRuntimeEntry);
  const metadataList = await Promise.all(entries.map(loadModuleMetadata));
  return entries.map((entry, index) => toModule(entry, metadataList[index]));
}

export async function saveModules(modules: Module[]): Promise<void> {
  await applyModulesPayload(modules);
}

export async function saveModuleRules(
  moduleId: string,
  rules: ModuleRules,
): Promise<void> {
  const module = {
    id: moduleId,
    enabled: true,
    rules: {
      default_mode: normalizeMountMode(rules.default_mode),
      paths: normalizeStringMap(rules.paths),
    },
  } as Module;
  await applyModulesPayload([module]);
}

export async function saveAllModuleRules(
  rules: Record<string, ModuleRules>,
): Promise<void> {
  const payload = Object.entries(rules).map(([moduleId, moduleRules]) => ({
    id: moduleId,
    enabled: true,
    rules: {
      default_mode: normalizeMountMode(moduleRules.default_mode),
      paths: normalizeStringMap(moduleRules.paths),
    },
  })) as Module[];
  await applyModulesPayload(payload);
}
