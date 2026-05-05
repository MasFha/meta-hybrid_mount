import { DEFAULT_CONFIG, PATHS } from "../../constants";
import type { AppConfig } from "../../types";
import { runHybridMountJson } from "../core/bridge";
import { shellEscapeDoubleQuoted } from "../core/shell";
import { normalizeConfig, cloneConfig } from "../codec/configCodec";

export async function detectDefaultMountSource(): Promise<string> {
  return "KSU";
}

export async function createDefaultConfig(): Promise<AppConfig> {
  const nextConfig = cloneConfig(DEFAULT_CONFIG);
  nextConfig.mountsource = await detectDefaultMountSource();
  return nextConfig;
}

export async function loadConfigFromFile(): Promise<AppConfig> {
  const payload = await runHybridMountJson("api config-get", PATHS.BINARY);
  return normalizeConfig(payload);
}

export async function saveConfigToFile(config: AppConfig): Promise<void> {
  const normalized = normalizeConfig(config);
  const encoded = shellEscapeDoubleQuoted(JSON.stringify(normalized));
  await runHybridMountJson(`api config-set "${encoded}"`, PATHS.BINARY);
}

export async function mutateConfig(
  mutator: (config: AppConfig) => void,
): Promise<void> {
  const config = await loadConfigFromFile();
  mutator(config);
  await saveConfigToFile(config);
}
