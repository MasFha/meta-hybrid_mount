import { parse as parseToml, stringify as stringifyToml } from "smol-toml";

import { DEFAULT_CONFIG, PATHS } from "./constants";
import { APP_VERSION } from "./constants_gen";
import { MockAPI } from "./api.mock";
import type {
  AppConfig,
  KernelUnameValues,
  KasumiStatus,
  KasumiUnameConfig,
  Module,
  ModuleRules,
  MountMode,
  OverlayMode,
  StorageStatus,
  SystemInfo,
} from "./types";

interface KsuExecResult {
  errno: number;
  stdout: string;
  stderr: string;
}

interface KsuModule {
  exec: (cmd: string, options?: unknown) => Promise<KsuExecResult>;
}

interface RuntimeStatePayload {
  pid?: unknown;
  storage_mode?: unknown;
  mount_point?: unknown;
  overlay_modules?: unknown;
  magic_modules?: unknown;
  kasumi_modules?: unknown;
  mount_error_modules?: unknown;
  mount_error_reasons?: unknown;
  skip_mount_modules?: unknown;
  active_mounts?: unknown;
  tmpfs_xattr_supported?: unknown;
  mode_stats?: unknown;
  kasumi?: unknown;
}

interface RuntimeModeStatsPayload {
  overlayfs?: unknown;
  magicmount?: unknown;
  kasumi?: unknown;
}

interface RuntimeKasumiPayload {
  status?: unknown;
  available?: unknown;
  lkm_loaded?: unknown;
  lkm_autoload?: unknown;
  lkm_kmi_override?: unknown;
  lkm_current_kmi?: unknown;
  lkm_dir?: unknown;
  protocol_version?: unknown;
  feature_bits?: unknown;
  feature_names?: unknown;
  hooks?: unknown;
  rule_count?: unknown;
  user_hide_rule_count?: unknown;
  mirror_path?: unknown;
}

let ksuExec: KsuModule["exec"] | null = null;

function hasKsuBridge(): boolean {
  const bridge = (globalThis as { ksu?: unknown }).ksu;
  return typeof bridge === "object" && bridge !== null && "exec" in bridge;
}

if (hasKsuBridge()) {
  try {
    const ksu = await import("kernelsu").catch(() => null);
    ksuExec = ksu ? ksu.exec : null;
  } catch {}
}

const shouldUseMock = import.meta.env.DEV && !ksuExec;
const RESERVED_MODULE_DIRS = new Set([
  "hybrid-mount",
  "hybrid_mount",
  "lost+found",
  ".git",
  ".idea",
  ".vscode",
]);
const BLOCK_MARKERS = ["disable", "remove", "mount_error", "skip_mount"] as const;
const KASUMI_MODULE_NAME = "kasumi_lkm";

function shellEscapeDoubleQuoted(value: string): string {
  return value.replace(/(["\\$`])/g, "\\$1");
}

class AppError extends Error {
  constructor(
    public message: string,
    public code?: number,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export interface AppAPI {
  loadConfig: () => Promise<AppConfig>;
  saveConfig: (config: AppConfig) => Promise<void>;
  resetConfig: () => Promise<void>;
  scanModules: (path?: string) => Promise<Module[]>;
  saveModules: (modules: Module[]) => Promise<void>;
  saveModuleRules: (moduleId: string, rules: ModuleRules) => Promise<void>;
  saveAllModuleRules: (rules: Record<string, ModuleRules>) => Promise<void>;
  getStorageUsage: () => Promise<StorageStatus>;
  getSystemInfo: () => Promise<SystemInfo>;
  getVersion: () => Promise<string>;
  getKasumiStatus: () => Promise<KasumiStatus>;
  setKasumiEnabled: (enabled: boolean) => Promise<void>;
  setKasumiStealth: (enabled: boolean) => Promise<void>;
  setKasumiHidexattr: (enabled: boolean) => Promise<void>;
  setKasumiDebug: (enabled: boolean) => Promise<void>;
  getOriginalKernelUname: () => Promise<KernelUnameValues>;
  setKasumiUnameMode: (mode: "scoped" | "global") => Promise<void>;
  setKasumiUname: (uname: Partial<KasumiUnameConfig>) => Promise<void>;
  clearKasumiUname: () => Promise<void>;
  setKasumiCmdline: (value: string) => Promise<void>;
  clearKasumiCmdline: () => Promise<void>;
  addKasumiMapsRule: (rule: {
    target_ino: number;
    target_dev: number;
    spoofed_ino: number;
    spoofed_dev: number;
    spoofed_pathname: string;
  }) => Promise<void>;
  clearKasumiMapsRules: () => Promise<void>;
  getUserHideRules: () => Promise<string[]>;
  addUserHideRule: (path: string) => Promise<void>;
  removeUserHideRule: (path: string) => Promise<void>;
  applyUserHideRules: () => Promise<void>;
  loadKasumiLkm: () => Promise<void>;
  unloadKasumiLkm: () => Promise<void>;
  setKasumiLkmAutoload: (enabled: boolean) => Promise<void>;
  setKasumiLkmKmi: (value: string) => Promise<void>;
  clearKasumiLkmKmi: () => Promise<void>;
  fixKasumiMounts: () => Promise<void>;
  clearKasumiRules: () => Promise<void>;
  releaseKasumiConnection: () => Promise<void>;
  invalidateKasumiCache: () => Promise<void>;
  openLink: (url: string) => Promise<void>;
  reboot: () => Promise<void>;
}

function requireExec(): KsuModule["exec"] {
  if (!ksuExec) throw new AppError("No KSU environment");
  return ksuExec;
}

async function runCommand(command: string): Promise<KsuExecResult> {
  const exec = requireExec();
  return exec(command);
}

async function runCommandExpectOk(command: string): Promise<string> {
  const { errno, stdout, stderr } = await runCommand(command);
  if (errno === 0) return stdout;
  throw new AppError(stderr || `command failed: ${command}`, errno);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function toNonNegativeInt(value: unknown, fallback = 0): number {
  if (isNumber(value)) {
    return Math.max(0, Math.trunc(value));
  }
  if (isString(value) && /^\d+$/.test(value)) {
    return Number.parseInt(value, 10);
  }
  return fallback;
}

function normalizeMountMode(
  value: unknown,
  fallback: MountMode = "overlay",
): MountMode {
  if (value === "magic" || value === "kasumi" || value === "ignore") {
    return value;
  }
  if (value === "overlay" || value === "auto") {
    return "overlay";
  }
  return fallback;
}

function normalizeOverlayMode(value: unknown): OverlayMode {
  return value === "tmpfs" ? "tmpfs" : "ext4";
}

function normalizeStringMap(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (isString(entry)) {
      result[key] = normalizeMountMode(entry);
    }
  }
  return result;
}

function normalizeKasumiUname(value: unknown): AppConfig["kasumi"]["uname"] {
  const next = isRecord(value) ? value : {};
  return {
    sysname: isString(next.sysname) ? next.sysname : "",
    nodename: isString(next.nodename) ? next.nodename : "",
    release: isString(next.release) ? next.release : "",
    version: isString(next.version) ? next.version : "",
    machine: isString(next.machine) ? next.machine : "",
    domainname: isString(next.domainname) ? next.domainname : "",
  };
}

function normalizeKasumiUnameMode(value: unknown): AppConfig["kasumi"]["uname_mode"] {
  return value === "global" ? "global" : "scoped";
}

function normalizeKasumiConfig(value: unknown): AppConfig["kasumi"] {
  const next = isRecord(value) ? value : {};
  const mountHide = isRecord(next.mount_hide) ? next.mount_hide : {};
  const statfsSpoof = isRecord(next.statfs_spoof) ? next.statfs_spoof : {};
  const uname = normalizeKasumiUname(next.uname);

  return {
    enabled: isBoolean(next.enabled) ? next.enabled : DEFAULT_CONFIG.kasumi.enabled,
    lkm_autoload: isBoolean(next.lkm_autoload)
      ? next.lkm_autoload
      : DEFAULT_CONFIG.kasumi.lkm_autoload,
    lkm_dir: isString(next.lkm_dir) ? next.lkm_dir : DEFAULT_CONFIG.kasumi.lkm_dir,
    lkm_kmi_override: isString(next.lkm_kmi_override)
      ? next.lkm_kmi_override
      : DEFAULT_CONFIG.kasumi.lkm_kmi_override,
    mirror_path: isString(next.mirror_path)
      ? next.mirror_path
      : DEFAULT_CONFIG.kasumi.mirror_path,
    enable_kernel_debug: isBoolean(next.enable_kernel_debug)
      ? next.enable_kernel_debug
      : DEFAULT_CONFIG.kasumi.enable_kernel_debug,
    enable_stealth: isBoolean(next.enable_stealth)
      ? next.enable_stealth
      : DEFAULT_CONFIG.kasumi.enable_stealth,
    enable_hidexattr: isBoolean(next.enable_hidexattr)
      ? next.enable_hidexattr
      : DEFAULT_CONFIG.kasumi.enable_hidexattr,
    enable_mount_hide: isBoolean(next.enable_mount_hide)
      ? next.enable_mount_hide
      : DEFAULT_CONFIG.kasumi.enable_mount_hide,
    enable_maps_spoof: isBoolean(next.enable_maps_spoof)
      ? next.enable_maps_spoof
      : DEFAULT_CONFIG.kasumi.enable_maps_spoof,
    enable_statfs_spoof: isBoolean(next.enable_statfs_spoof)
      ? next.enable_statfs_spoof
      : DEFAULT_CONFIG.kasumi.enable_statfs_spoof,
    mount_hide: {
      enabled: isBoolean(mountHide.enabled) ? mountHide.enabled : false,
      path_pattern: isString(mountHide.path_pattern) ? mountHide.path_pattern : "",
    },
    statfs_spoof: {
      enabled: isBoolean(statfsSpoof.enabled) ? statfsSpoof.enabled : false,
      path: isString(statfsSpoof.path) ? statfsSpoof.path : "",
      spoof_f_type: toNonNegativeInt(statfsSpoof.spoof_f_type),
    },
    hide_uids: Array.isArray(next.hide_uids)
      ? next.hide_uids.map((item) => toNonNegativeInt(item)).filter((item) => item >= 0)
      : [],
    uname_mode: normalizeKasumiUnameMode(next.uname_mode),
    uname,
    uname_release: isString(next.uname_release) ? next.uname_release : uname.release,
    uname_version: isString(next.uname_version) ? next.uname_version : uname.version,
    cmdline_value: isString(next.cmdline_value) ? next.cmdline_value : "",
    kstat_rules: Array.isArray(next.kstat_rules)
      ? next.kstat_rules.filter(isRecord).map((item) => ({
          target_ino: toNonNegativeInt(item.target_ino),
          target_pathname: isString(item.target_pathname)
            ? item.target_pathname
            : "",
          spoofed_ino: toNonNegativeInt(item.spoofed_ino),
          spoofed_dev: toNonNegativeInt(item.spoofed_dev),
          spoofed_nlink: toNonNegativeInt(item.spoofed_nlink),
          spoofed_size: Number(item.spoofed_size || 0),
          spoofed_atime_sec: Number(item.spoofed_atime_sec || 0),
          spoofed_atime_nsec: Number(item.spoofed_atime_nsec || 0),
          spoofed_mtime_sec: Number(item.spoofed_mtime_sec || 0),
          spoofed_mtime_nsec: Number(item.spoofed_mtime_nsec || 0),
          spoofed_ctime_sec: Number(item.spoofed_ctime_sec || 0),
          spoofed_ctime_nsec: Number(item.spoofed_ctime_nsec || 0),
          spoofed_blksize: toNonNegativeInt(item.spoofed_blksize),
          spoofed_blocks: toNonNegativeInt(item.spoofed_blocks),
          is_static: isBoolean(item.is_static) ? item.is_static : false,
        }))
      : [],
    maps_rules: Array.isArray(next.maps_rules)
      ? next.maps_rules.filter(isRecord).map((item) => ({
          target_ino: toNonNegativeInt(item.target_ino),
          target_dev: toNonNegativeInt(item.target_dev),
          spoofed_ino: toNonNegativeInt(item.spoofed_ino),
          spoofed_dev: toNonNegativeInt(item.spoofed_dev),
          spoofed_pathname: isString(item.spoofed_pathname)
            ? item.spoofed_pathname
            : "",
        }))
      : [],
  };
}

function normalizeConfig(value: unknown): AppConfig {
  const next = isRecord(value) ? value : {};
  const defaultMode = normalizeMountMode(next.default_mode, DEFAULT_CONFIG.default_mode);
  const rulesSource = isRecord(next.rules) ? next.rules : {};
  const rules: Record<string, ModuleRules> = {};

  for (const [moduleId, ruleValue] of Object.entries(rulesSource)) {
    if (!isRecord(ruleValue)) continue;
    rules[moduleId] = {
      default_mode: normalizeMountMode(ruleValue.default_mode, defaultMode),
      paths: normalizeStringMap(ruleValue.paths),
    };
  }

  return {
    moduledir: isString(next.moduledir) ? next.moduledir : DEFAULT_CONFIG.moduledir,
    mountsource: isString(next.mountsource)
      ? next.mountsource
      : DEFAULT_CONFIG.mountsource,
    partitions: Array.isArray(next.partitions)
      ? next.partitions.filter(isString)
      : [...DEFAULT_CONFIG.partitions],
    overlay_mode: normalizeOverlayMode(next.overlay_mode),
    disable_umount: isBoolean(next.disable_umount)
      ? next.disable_umount
      : DEFAULT_CONFIG.disable_umount,
    enable_overlay_fallback: isBoolean(next.enable_overlay_fallback)
      ? next.enable_overlay_fallback
      : DEFAULT_CONFIG.enable_overlay_fallback,
    default_mode: defaultMode,
    kasumi: normalizeKasumiConfig(next.kasumi),
    rules,
  };
}

function cloneConfig(config: AppConfig): AppConfig {
  return JSON.parse(JSON.stringify(config)) as AppConfig;
}

function compactRules(
  rules: Record<string, ModuleRules>,
  globalDefaultMode: MountMode,
): Record<string, { default_mode: MountMode; paths?: Record<string, string> }> {
  const nextRules: Record<string, { default_mode: MountMode; paths?: Record<string, string> }> = {};

  for (const [moduleId, rule] of Object.entries(rules)) {
    const defaultMode = normalizeMountMode(rule.default_mode, globalDefaultMode);
    const paths = normalizeStringMap(rule.paths);
    const pathKeys = Object.keys(paths);
    if (defaultMode === globalDefaultMode && pathKeys.length === 0) {
      continue;
    }
    nextRules[moduleId] = pathKeys.length > 0
      ? { default_mode: defaultMode, paths }
      : { default_mode: defaultMode };
  }

  return nextRules;
}

function serializeConfig(config: AppConfig): string {
  const normalized = normalizeConfig(config);
  normalized.kasumi.uname_release = normalized.kasumi.uname.release;
  normalized.kasumi.uname_version = normalized.kasumi.uname.version;

  const payload: Record<string, unknown> = {
    moduledir: normalized.moduledir,
    mountsource: normalized.mountsource,
    partitions: [...normalized.partitions],
    overlay_mode: normalized.overlay_mode,
    disable_umount: normalized.disable_umount,
    enable_overlay_fallback: normalized.enable_overlay_fallback,
    default_mode: normalized.default_mode,
    kasumi: {
      enabled: normalized.kasumi.enabled,
      lkm_autoload: normalized.kasumi.lkm_autoload,
      lkm_dir: normalized.kasumi.lkm_dir,
      lkm_kmi_override: normalized.kasumi.lkm_kmi_override,
      mirror_path: normalized.kasumi.mirror_path,
      enable_kernel_debug: normalized.kasumi.enable_kernel_debug,
      enable_stealth: normalized.kasumi.enable_stealth,
      enable_hidexattr: normalized.kasumi.enable_hidexattr,
      enable_mount_hide: normalized.kasumi.enable_mount_hide,
      enable_maps_spoof: normalized.kasumi.enable_maps_spoof,
      enable_statfs_spoof: normalized.kasumi.enable_statfs_spoof,
      hide_uids: [...normalized.kasumi.hide_uids],
      uname_mode: normalized.kasumi.uname_mode,
      cmdline_value: normalized.kasumi.cmdline_value,
      mount_hide: {
        enabled: normalized.kasumi.mount_hide.enabled,
        path_pattern: normalized.kasumi.mount_hide.path_pattern,
      },
      statfs_spoof: {
        enabled: normalized.kasumi.statfs_spoof.enabled,
        path: normalized.kasumi.statfs_spoof.path,
        spoof_f_type: normalized.kasumi.statfs_spoof.spoof_f_type,
      },
      uname: {
        sysname: normalized.kasumi.uname.sysname,
        nodename: normalized.kasumi.uname.nodename,
        release: normalized.kasumi.uname.release,
        version: normalized.kasumi.uname.version,
        machine: normalized.kasumi.uname.machine,
        domainname: normalized.kasumi.uname.domainname,
      },
      kstat_rules: normalized.kasumi.kstat_rules.map((rule) => ({ ...rule })),
      maps_rules: normalized.kasumi.maps_rules.map((rule) => ({ ...rule })),
    },
  };

  const compactedRules = compactRules(normalized.rules, normalized.default_mode);
  if (Object.keys(compactedRules).length > 0) {
    payload.rules = compactedRules;
  }

  return stringifyToml(payload);
}

function joinPath(...parts: string[]): string {
  return parts
    .filter((part) => part.length > 0)
    .join("/")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  return index >= 0 ? trimmed.slice(index + 1) : trimmed;
}

function dirname(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const index = trimmed.lastIndexOf("/");
  if (index <= 0) return "/";
  return trimmed.slice(0, index);
}

function pickHereDocTag(content: string): string {
  let tag = `__CLAUDE_EOF_${Date.now()}__`;
  while (content.includes(tag)) {
    tag = `${tag}_X`;
  }
  return tag;
}

async function readOptionalTextFile(path: string): Promise<string | null> {
  const { errno, stdout } = await runCommand(
    `cat "${shellEscapeDoubleQuoted(path)}" 2>/dev/null`,
  );
  return errno === 0 ? stdout : null;
}

async function fileExists(path: string): Promise<boolean> {
  const { errno } = await runCommand(`[ -e "${shellEscapeDoubleQuoted(path)}" ]`);
  return errno === 0;
}

async function listDirectories(path: string): Promise<string[]> {
  const output = await runCommandExpectOk(
    `[ -d "${shellEscapeDoubleQuoted(path)}" ] || exit 0; find "${shellEscapeDoubleQuoted(path)}" -mindepth 1 -maxdepth 1 -type d -print`,
  );
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function writeTextFileAtomic(path: string, content: string): Promise<void> {
  const parent = dirname(path);
  const tmpPath = `${path}.claude-tmp-${Date.now()}`;
  const tag = pickHereDocTag(content);
  await runCommandExpectOk(
    `mkdir -p "${shellEscapeDoubleQuoted(parent)}"
cat <<'${tag}' > "${shellEscapeDoubleQuoted(tmpPath)}"
${content}
${tag}
mv "${shellEscapeDoubleQuoted(tmpPath)}" "${shellEscapeDoubleQuoted(path)}"`,
  );
}

async function loadRuntimeState(): Promise<RuntimeStatePayload> {
  const raw = await readOptionalTextFile(PATHS.DAEMON_STATE);
  if (!raw || !raw.trim()) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? (parsed as RuntimeStatePayload) : {};
  } catch (error) {
    throw new AppError(
      error instanceof Error
        ? `Failed to parse runtime state: ${error.message}`
        : "Failed to parse runtime state",
    );
  }
}

async function readKernelRelease(): Promise<string> {
  const release = await readOptionalTextFile("/proc/sys/kernel/osrelease");
  if (release?.trim()) {
    return release.trim();
  }

  const procVersion = await readOptionalTextFile("/proc/version");
  if (procVersion?.trim()) {
    const match = procVersion.trim().match(/^Linux version\s+(\S+)/);
    if (match?.[1]) {
      return match[1];
    }
  }

  return "Unknown";
}

async function readSelinuxStatus(): Promise<string> {
  const enforce = await readOptionalTextFile("/sys/fs/selinux/enforce");
  if (enforce?.trim() === "1") return "Enforcing";
  if (enforce?.trim() === "0") return "Permissive";

  const result = await runCommand("getenforce 2>/dev/null");
  if (result.errno === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }

  return "Unknown";
}

async function detectDefaultMountSource(): Promise<string> {
  return ksuExec ? "KSU" : "APatch";
}

async function createDefaultConfig(): Promise<AppConfig> {
  const nextConfig = cloneConfig(DEFAULT_CONFIG);
  nextConfig.mountsource = await detectDefaultMountSource();
  return nextConfig;
}

async function loadConfigFromFile(): Promise<AppConfig> {
  const raw = await readOptionalTextFile(PATHS.CONFIG);
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

async function mutateConfig(mutator: (config: AppConfig) => void): Promise<void> {
  const config = await loadConfigFromFile();
  mutator(config);
  await writeTextFileAtomic(PATHS.CONFIG, serializeConfig(config));
}

function runtimeModuleMode(
  moduleId: string,
  state: RuntimeStatePayload,
): MountMode | null {
  const overlay = isStringArray(state.overlay_modules) ? state.overlay_modules : [];
  if (overlay.includes(moduleId)) return "overlay";
  const magic = isStringArray(state.magic_modules) ? state.magic_modules : [];
  if (magic.includes(moduleId)) return "magic";
  const kasumi = isStringArray(state.kasumi_modules) ? state.kasumi_modules : [];
  if (kasumi.includes(moduleId)) return "kasumi";
  return null;
}

async function hasBlockMarker(modulePath: string): Promise<boolean> {
  for (const marker of BLOCK_MARKERS) {
    if (await fileExists(joinPath(modulePath, marker))) {
      return true;
    }
  }
  return false;
}

function parseModuleProp(moduleId: string, raw: string | null) {
  const values: Record<string, string> = {};
  if (raw) {
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index <= 0) continue;
      values[trimmed.slice(0, index)] = trimmed.slice(index + 1);
    }
  }

  return {
    name: values.name?.trim() || moduleId,
    version: values.version?.trim() || "unknown",
    author: values.author?.trim() || "unknown",
    description: values.description?.trim() || "No description",
  };
}

function buildModeStats(state: RuntimeStatePayload): NonNullable<StorageStatus["modeStats"]> {
  const modeStats = isRecord(state.mode_stats)
    ? (state.mode_stats as RuntimeModeStatsPayload)
    : {};
  return {
    overlay: toNonNegativeInt(modeStats.overlayfs),
    magic: toNonNegativeInt(modeStats.magicmount),
    kasumi: toNonNegativeInt(modeStats.kasumi),
  };
}

function buildMountedCount(
  state: RuntimeStatePayload,
  modeStats: NonNullable<StorageStatus["modeStats"]>,
): number {
  const overlay = isStringArray(state.overlay_modules) ? state.overlay_modules.length : 0;
  const magic = isStringArray(state.magic_modules) ? state.magic_modules.length : 0;
  const kasumi = isStringArray(state.kasumi_modules) ? state.kasumi_modules.length : 0;
  const total = overlay + magic + kasumi;
  return total > 0 ? total : modeStats.overlay + modeStats.magic + modeStats.kasumi;
}

function parseJsonArrayOutput(output: string, endpoint: string): string[] {
  try {
    const parsed: unknown = JSON.parse(output);
    if (isStringArray(parsed)) return parsed;
  } catch {}
  throw new AppError(`Invalid ${endpoint} payload`);
}

function buildKasumiStatusFromPayload(
  payload: unknown,
  fallbackConfig: AppConfig["kasumi"],
  fallbackState: RuntimeStatePayload,
): KasumiStatus | null {
  if (!isRecord(payload)) return null;

  const lkmPayload = isRecord(payload.lkm) ? payload.lkm : {};
  const configPayload = isRecord(payload.config)
    ? payload.config
    : fallbackConfig;
  const runtimePayload = isRecord(payload.runtime) ? payload.runtime : {};

  return {
    status: isString(payload.status)
      ? payload.status
      : fallbackConfig.enabled
        ? "unavailable"
        : "disabled",
    available: isBoolean(payload.available) ? payload.available : false,
    protocol_version:
      payload.protocol_version === null || isNumber(payload.protocol_version)
        ? (payload.protocol_version as number | null | undefined) ?? null
        : null,
    feature_bits:
      payload.feature_bits === null || isNumber(payload.feature_bits)
        ? (payload.feature_bits as number | null | undefined) ?? null
        : null,
    feature_names: isStringArray(payload.feature_names)
      ? payload.feature_names
      : [],
    hooks: isStringArray(payload.hooks) ? payload.hooks : [],
    rule_count: toNonNegativeInt(payload.rule_count),
    user_hide_rule_count: toNonNegativeInt(payload.user_hide_rule_count),
    mirror_path: isString(payload.mirror_path)
      ? payload.mirror_path
      : fallbackConfig.mirror_path,
    lkm: {
      loaded: isBoolean(lkmPayload.loaded) ? lkmPayload.loaded : false,
      module_name: isString(lkmPayload.module_name)
        ? lkmPayload.module_name
        : undefined,
      autoload: isBoolean(lkmPayload.autoload)
        ? lkmPayload.autoload
        : fallbackConfig.lkm_autoload,
      kmi_override: isString(lkmPayload.kmi_override)
        ? lkmPayload.kmi_override
        : fallbackConfig.lkm_kmi_override,
      current_kmi: isString(lkmPayload.current_kmi)
        ? lkmPayload.current_kmi
        : "",
      search_dir: isString(lkmPayload.search_dir)
        ? lkmPayload.search_dir
        : fallbackConfig.lkm_dir,
      module_file: isString(lkmPayload.module_file)
        ? lkmPayload.module_file
        : undefined,
      last_error:
        lkmPayload.last_error === null || isString(lkmPayload.last_error)
          ? (lkmPayload.last_error as string | null | undefined) ?? null
          : null,
    },
    config: normalizeKasumiConfig(configPayload),
    runtime: {
      snapshot: isRecord(runtimePayload.snapshot)
        ? (runtimePayload.snapshot as Record<string, unknown>)
        : isRecord(fallbackState.kasumi)
          ? (fallbackState.kasumi as Record<string, unknown>)
          : {},
      kasumi_modules: isStringArray(runtimePayload.kasumi_modules)
        ? runtimePayload.kasumi_modules
        : isStringArray(fallbackState.kasumi_modules)
          ? fallbackState.kasumi_modules
          : [],
    },
  };
}

function buildKasumiStatusFromRuntimeState(
  config: AppConfig["kasumi"],
  state: RuntimeStatePayload,
): KasumiStatus {
  const runtime = isRecord(state.kasumi)
    ? (state.kasumi as RuntimeKasumiPayload)
    : {};

  return {
    status: isString(runtime.status)
      ? runtime.status
      : config.enabled
        ? "unavailable"
        : "disabled",
    available: isBoolean(runtime.available) ? runtime.available : false,
    protocol_version:
      runtime.protocol_version === null || isNumber(runtime.protocol_version)
        ? (runtime.protocol_version as number | null | undefined) ?? null
        : null,
    feature_bits:
      runtime.feature_bits === null || isNumber(runtime.feature_bits)
        ? (runtime.feature_bits as number | null | undefined) ?? null
        : null,
    feature_names: isStringArray(runtime.feature_names)
      ? runtime.feature_names
      : [],
    hooks: isStringArray(runtime.hooks) ? runtime.hooks : [],
    rule_count: toNonNegativeInt(runtime.rule_count),
    user_hide_rule_count: toNonNegativeInt(runtime.user_hide_rule_count),
    mirror_path: isString(runtime.mirror_path)
      ? runtime.mirror_path
      : config.mirror_path,
    lkm: {
      loaded: isBoolean(runtime.lkm_loaded) ? runtime.lkm_loaded : false,
      module_name:
        isBoolean(runtime.lkm_loaded) && runtime.lkm_loaded
          ? KASUMI_MODULE_NAME
          : undefined,
      autoload: config.lkm_autoload,
      kmi_override: config.lkm_kmi_override,
      current_kmi: isString(runtime.lkm_current_kmi)
        ? runtime.lkm_current_kmi
        : "",
      search_dir: config.lkm_dir,
      module_file: undefined,
      last_error: null,
    },
    config,
    runtime: {
      snapshot: isRecord(state.kasumi)
        ? (state.kasumi as Record<string, unknown>)
        : {},
      kasumi_modules: isStringArray(state.kasumi_modules)
        ? state.kasumi_modules
        : [],
    },
  };
}

const RealAPI: AppAPI = {
  loadConfig: async (): Promise<AppConfig> => {
    return loadConfigFromFile();
  },
  saveConfig: async (config: AppConfig): Promise<void> => {
    await writeTextFileAtomic(PATHS.CONFIG, serializeConfig(config));
  },
  resetConfig: async (): Promise<void> => {
    await writeTextFileAtomic(PATHS.CONFIG, serializeConfig(await createDefaultConfig()));
  },
  scanModules: async (path?: string): Promise<Module[]> => {
    const config = await loadConfigFromFile();
    const state = await loadRuntimeState();
    const moduleDir = path?.trim() || config.moduledir;
    const dirs = (await listDirectories(moduleDir)).filter((sourcePath) => {
      const moduleId = basename(sourcePath);
      return Boolean(moduleId) && !RESERVED_MODULE_DIRS.has(moduleId);
    });

    const modules = await Promise.all(
      dirs.map(async (sourcePath) => {
        const moduleId = basename(sourcePath);
        const prop = parseModuleProp(
          moduleId,
          await readOptionalTextFile(joinPath(sourcePath, "module.prop")),
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
  },
  saveModules: async (modules: Module[]): Promise<void> => {
    await mutateConfig((config) => {
      for (const module of modules) {
        config.rules[module.id] = {
          default_mode: normalizeMountMode(module.rules.default_mode, config.default_mode),
          paths: normalizeStringMap(module.rules.paths),
        };
      }
    });
  },
  saveModuleRules: async (
    moduleId: string,
    rules: ModuleRules,
  ): Promise<void> => {
    await mutateConfig((config) => {
      config.rules[moduleId] = {
        default_mode: normalizeMountMode(rules.default_mode, config.default_mode),
        paths: normalizeStringMap(rules.paths),
      };
    });
  },
  saveAllModuleRules: async (
    rules: Record<string, ModuleRules>,
  ): Promise<void> => {
    await mutateConfig((config) => {
      for (const [moduleId, moduleRules] of Object.entries(rules)) {
        config.rules[moduleId] = {
          default_mode: normalizeMountMode(
            moduleRules.default_mode,
            config.default_mode,
          ),
          paths: normalizeStringMap(moduleRules.paths),
        };
      }
    });
  },
  getStorageUsage: async (): Promise<StorageStatus> => {
    try {
      const state = await loadRuntimeState();
      const modeStats = buildModeStats(state);
      return {
        type: isString(state.storage_mode)
          ? ((state.storage_mode as string) as StorageStatus["type"])
          : "unknown",
        supported_modes: ["tmpfs", "ext4"],
        modeStats,
        mountedCount: buildMountedCount(state, modeStats),
      };
    } catch (error) {
      return {
        type: "unknown",
        error:
          error instanceof Error ? error.message : "Storage status unavailable",
        supported_modes: ["tmpfs", "ext4"],
      };
    }
  },
  getSystemInfo: async (): Promise<SystemInfo> => {
    const state = await loadRuntimeState();
    return {
      kernel: await readKernelRelease(),
      selinux: await readSelinuxStatus(),
      mountBase: isString(state.mount_point) ? state.mount_point : "-",
      activeMounts: isStringArray(state.active_mounts) ? state.active_mounts : [],
      tmpfs_xattr_supported: isBoolean(state.tmpfs_xattr_supported)
        ? state.tmpfs_xattr_supported
        : undefined,
      supported_overlay_modes: ["tmpfs", "ext4"],
    };
  },
  getVersion: async (): Promise<string> => {
    const moduleDir = dirname(PATHS.BINARY);
    const raw = await readOptionalTextFile(joinPath(moduleDir, "module.prop"));
    if (raw) {
      const match = raw.match(/^version=(.+)$/m);
      if (match?.[1]) {
        return match[1].trim();
      }
    }
    return APP_VERSION;
  },
  getKasumiStatus: async (): Promise<KasumiStatus> => {
    const [config, state] = await Promise.all([
      loadConfigFromFile(),
      loadRuntimeState(),
    ]);
    try {
      const payload = JSON.parse(
        await runCommandExpectOk(`${PATHS.BINARY} kasumi status`),
      ) as unknown;
      return (
        buildKasumiStatusFromPayload(payload, config.kasumi, state) ??
        buildKasumiStatusFromRuntimeState(config.kasumi, state)
      );
    } catch {
      return buildKasumiStatusFromRuntimeState(config.kasumi, state);
    }
  },
  setKasumiEnabled: async (enabled: boolean): Promise<void> => {
    await mutateConfig((config) => {
      config.kasumi.enabled = enabled;
    });
  },
  setKasumiStealth: async (enabled: boolean): Promise<void> => {
    await mutateConfig((config) => {
      config.kasumi.enable_stealth = enabled;
    });
  },
  setKasumiHidexattr: async (enabled: boolean): Promise<void> => {
    await mutateConfig((config) => {
      config.kasumi.enable_hidexattr = enabled;
    });
  },
  setKasumiDebug: async (enabled: boolean): Promise<void> => {
    await mutateConfig((config) => {
      config.kasumi.enable_kernel_debug = enabled;
    });
  },
  getOriginalKernelUname: async (): Promise<KernelUnameValues> => {
    const release = (await readOptionalTextFile("/proc/sys/kernel/osrelease"))?.trim() || "";
    const version = (await readOptionalTextFile("/proc/sys/kernel/version"))?.trim() || "";
    if (!release && !version) {
      throw new AppError("Failed to read original kernel uname values");
    }
    return { release, version };
  },
  setKasumiUnameMode: async (mode: "scoped" | "global"): Promise<void> => {
    await mutateConfig((config) => {
      config.kasumi.uname_mode = normalizeKasumiUnameMode(mode);
    });
  },
  setKasumiUname: async (uname: Partial<KasumiUnameConfig>): Promise<void> => {
    await mutateConfig((config) => {
      config.kasumi.uname = {
        ...config.kasumi.uname,
        ...uname,
      };
      config.kasumi.uname_release = config.kasumi.uname.release;
      config.kasumi.uname_version = config.kasumi.uname.version;
    });
  },
  clearKasumiUname: async (): Promise<void> => {
    await mutateConfig((config) => {
      config.kasumi.uname = {
        sysname: "",
        nodename: "",
        release: "",
        version: "",
        machine: "",
        domainname: "",
      };
      config.kasumi.uname_release = "";
      config.kasumi.uname_version = "";
    });
  },
  setKasumiCmdline: async (value: string): Promise<void> => {
    await mutateConfig((config) => {
      config.kasumi.cmdline_value = value;
    });
  },
  clearKasumiCmdline: async (): Promise<void> => {
    await mutateConfig((config) => {
      config.kasumi.cmdline_value = "";
    });
  },
  addKasumiMapsRule: async (rule): Promise<void> => {
    await mutateConfig((config) => {
      const nextRule = {
        target_ino: Math.max(0, Math.trunc(Number(rule.target_ino) || 0)),
        target_dev: Math.max(0, Math.trunc(Number(rule.target_dev) || 0)),
        spoofed_ino: Math.max(0, Math.trunc(Number(rule.spoofed_ino) || 0)),
        spoofed_dev: Math.max(0, Math.trunc(Number(rule.spoofed_dev) || 0)),
        spoofed_pathname: rule.spoofed_pathname || "",
      };
      const nextRules = config.kasumi.maps_rules.filter(
        (item) =>
          !(
            item.target_ino === nextRule.target_ino &&
            item.target_dev === nextRule.target_dev
          ),
      );
      nextRules.push(nextRule);
      config.kasumi.maps_rules = nextRules;
    });
  },
  clearKasumiMapsRules: async (): Promise<void> => {
    await mutateConfig((config) => {
      config.kasumi.maps_rules = [];
    });
  },
  getUserHideRules: async (): Promise<string[]> => {
    return parseJsonArrayOutput(
      await runCommandExpectOk(`${PATHS.BINARY} hide list`),
      "hide list",
    );
  },
  addUserHideRule: async (path: string): Promise<void> => {
    await runCommandExpectOk(
      `${PATHS.BINARY} hide add "${shellEscapeDoubleQuoted(path)}"`,
    );
  },
  removeUserHideRule: async (path: string): Promise<void> => {
    await runCommandExpectOk(
      `${PATHS.BINARY} hide remove "${shellEscapeDoubleQuoted(path)}"`,
    );
  },
  applyUserHideRules: async (): Promise<void> => {
    await runCommandExpectOk(`${PATHS.BINARY} hide apply`);
  },
  loadKasumiLkm: async (): Promise<void> => {
    await runCommandExpectOk(`${PATHS.BINARY} lkm load`);
  },
  unloadKasumiLkm: async (): Promise<void> => {
    await runCommandExpectOk(`${PATHS.BINARY} lkm unload`);
  },
  setKasumiLkmAutoload: async (enabled: boolean): Promise<void> => {
    await mutateConfig((config) => {
      config.kasumi.lkm_autoload = enabled;
    });
  },
  setKasumiLkmKmi: async (value: string): Promise<void> => {
    await mutateConfig((config) => {
      config.kasumi.lkm_kmi_override = value;
    });
  },
  clearKasumiLkmKmi: async (): Promise<void> => {
    await mutateConfig((config) => {
      config.kasumi.lkm_kmi_override = "";
    });
  },
  fixKasumiMounts: async (): Promise<void> => {
    await runCommandExpectOk(`${PATHS.BINARY} kasumi fix-mounts`);
  },
  clearKasumiRules: async (): Promise<void> => {
    await runCommandExpectOk(`${PATHS.BINARY} kasumi clear`);
  },
  releaseKasumiConnection: async (): Promise<void> => {
    await runCommandExpectOk(`${PATHS.BINARY} kasumi release-connection`);
  },
  invalidateKasumiCache: async (): Promise<void> => {
    await runCommandExpectOk(`${PATHS.BINARY} kasumi invalidate-cache`);
  },
  openLink: async (url: string): Promise<void> => {
    if (!ksuExec) {
      window.open(url, "_blank", "noopener,noreferrer");
      return;
    }
    const safeUrl = shellEscapeDoubleQuoted(url);
    await runCommandExpectOk(
      `am start -a android.intent.action.VIEW -d "${safeUrl}"`,
    );
  },
  reboot: async (): Promise<void> => {
    await runCommandExpectOk("reboot");
  },
};

export const API: AppAPI = shouldUseMock
  ? (MockAPI as unknown as AppAPI)
  : RealAPI;
