import type { Module, ModuleRules } from "../../types";
import {
  listDirectories,
  fileExists,
  readOptionalTextFile,
} from "../core/fileRepo";
import { runCommand, runCommandExpectOk } from "../core/bridge";
import { basename, joinPath } from "../core/path";
import { loadConfigFromFile, saveConfigToFile } from "../repos/configRepo";
import { loadRuntimeState } from "../repos/runtimeRepo";
import { normalizeMountMode, normalizeStringMap } from "../codec/configCodec";
import { parseModuleProp, runtimeModuleMode } from "../codec/runtimeCodec";

export const RESERVED_MODULE_DIRS = new Set([
  "hybrid-mount",
  "hybrid_mount",
  "lost+found",
  ".git",
  ".idea",
  ".vscode",
]);

const BLOCK_MARKERS = [
  "disable",
  "remove",
  "mount_error",
  "skip_mount",
] as const;

async function hasBlockMarker(modulePath: string): Promise<boolean> {
  for (const marker of BLOCK_MARKERS) {
    if (await fileExists(runCommand, joinPath(modulePath, marker))) {
      return true;
    }
  }
  return false;
}

export async function scanModules(path?: string): Promise<Module[]> {
  const config = await loadConfigFromFile();
  const state = await loadRuntimeState();
  const moduleDir = path?.trim() || config.moduledir;
  const dirs = (await listDirectories(runCommandExpectOk, moduleDir)).filter(
    (sourcePath) => {
      const moduleId = basename(sourcePath);
      return Boolean(moduleId) && !RESERVED_MODULE_DIRS.has(moduleId);
    },
  );

  const modules = await Promise.all(
    dirs.map(async (sourcePath) => {
      const moduleId = basename(sourcePath);
      const prop = parseModuleProp(
        moduleId,
        await readOptionalTextFile(
          runCommand,
          joinPath(sourcePath, "module.prop"),
        ),
      );
      const configuredRules = config.rules[moduleId];
      const rules: ModuleRules = {
        default_mode: normalizeMountMode(
          configuredRules?.default_mode,
          config.default_mode,
        ),
        paths: normalizeStringMap(configuredRules?.paths),
      };
      const blocked = await hasBlockMarker(sourcePath);
      const runtimeMode = blocked ? null : runtimeModuleMode(moduleId, state);

      return {
        id: moduleId,
        name: prop.name,
        version: prop.version,
        author: prop.author,
        description: prop.description,
        mode: runtimeMode ?? rules.default_mode,
        is_mounted: runtimeMode !== null,
        enabled: !blocked,
        source_path: sourcePath,
        rules,
      } satisfies Module;
    }),
  );

  return modules as Module[];
}

export async function saveModules(modules: Module[]): Promise<void> {
  const config = await loadConfigFromFile();

  for (const module of modules) {
    if (module.source_path) {
      const disablePath = joinPath(module.source_path, "disable");
      if (module.enabled === false) {
        await runCommandExpectOk(`touch "${disablePath}"`);
      } else {
        await runCommand(`rm -f "${disablePath}" 2>/dev/null`);
      }
    }

    config.rules[module.id] = {
      default_mode: normalizeMountMode(
        module.rules.default_mode,
        config.default_mode,
      ),
      paths: normalizeStringMap(module.rules.paths),
    };
  }

  await saveConfigToFile(config);
}

export async function saveModuleRules(
  moduleId: string,
  rules: ModuleRules,
): Promise<void> {
  const config = await loadConfigFromFile();
  config.rules[moduleId] = {
    default_mode: normalizeMountMode(rules.default_mode, config.default_mode),
    paths: normalizeStringMap(rules.paths),
  };
  await saveConfigToFile(config);
}

export async function saveAllModuleRules(
  rules: Record<string, ModuleRules>,
): Promise<void> {
  const config = await loadConfigFromFile();
  for (const [moduleId, moduleRules] of Object.entries(rules)) {
    config.rules[moduleId] = {
      default_mode: normalizeMountMode(
        moduleRules.default_mode,
        config.default_mode,
      ),
      paths: normalizeStringMap(moduleRules.paths),
    };
  }
  await saveConfigToFile(config);
}
