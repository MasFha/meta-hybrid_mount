import { DEFAULT_CONFIG, PATHS } from "../../constants";
import type { AppConfig } from "../../types";
import { runCommand, runCommandExpectOk } from "../core/bridge";
import { dirname } from "../core/path";
import { readOptionalTextFile, writeTextFileAtomic } from "../core/fileRepo";
import {
  normalizeConfig,
  cloneConfig,
  serializeConfig,
} from "../codec/configCodec";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { AppError } from "../core/error";

export async function detectDefaultMountSource(): Promise<string> {
  return "KSU";
}

export async function createDefaultConfig(): Promise<AppConfig> {
  const nextConfig = cloneConfig(DEFAULT_CONFIG);
  nextConfig.mountsource = await detectDefaultMountSource();
  return nextConfig;
}

export async function loadConfigFromFile(): Promise<AppConfig> {
  const raw = await readOptionalTextFile(runCommand, PATHS.CONFIG);
  if (!raw || !raw.trim()) {
    return createDefaultConfig();
  }

  try {
    return normalizeConfig(parseToml(raw) as unknown);
  } catch (error) {
    throw new AppError(
      error instanceof Error
        ? `Failed to parse config.toml: ${error.message}`
        : "Failed to parse config.toml",
    );
  }
}

export async function saveConfigToFile(config: AppConfig): Promise<void> {
  await writeTextFileAtomic(
    runCommandExpectOk,
    dirname,
    PATHS.CONFIG,
    serializeConfig(config, stringifyToml),
  );
}

export async function mutateConfig(
  mutator: (config: AppConfig) => void,
): Promise<void> {
  const config = await loadConfigFromFile();
  mutator(config);
  await saveConfigToFile(config);
}

export async function getModuleVersion(
  binaryPath: string,
  fallbackVersion: string,
): Promise<string> {
  const moduleDir = dirname(binaryPath);
  const raw = await readOptionalTextFile(
    runCommand,
    `${moduleDir}/module.prop`,
  );
  if (raw) {
    const match = raw.match(/^version=(.+)$/m);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return fallbackVersion;
}
