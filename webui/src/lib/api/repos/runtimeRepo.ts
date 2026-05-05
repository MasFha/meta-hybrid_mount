export interface RuntimeStatePayload {
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
  daemon?: unknown;
}

export interface RuntimeModeStatsPayload {
  overlayfs?: unknown;
  magicmount?: unknown;
  kasumi?: unknown;
}

export interface RuntimeKasumiPayload {
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

import { PATHS } from "../../constants";
import { AppError } from "../core/error";
import { isRecord } from "../core/guards";
import { runCommand, runHybridMountJson } from "../core/bridge";
import { readOptionalTextFile } from "../core/fileRepo";

export async function loadRuntimeState(): Promise<RuntimeStatePayload> {
  const direct = await runHybridMountJson("daemon status", PATHS.BINARY);
  if (!isRecord(direct)) {
    throw new AppError("daemon status returned invalid payload");
  }
  return direct as RuntimeStatePayload;
}

export async function readKernelRelease(): Promise<string> {
  const release = await readOptionalTextFile(
    runCommand,
    "/proc/sys/kernel/osrelease",
  );
  if (release?.trim()) {
    return release.trim();
  }

  const procVersion = await readOptionalTextFile(runCommand, "/proc/version");
  if (procVersion?.trim()) {
    const match = procVersion.trim().match(/^Linux version\s+(\S+)/);
    if (match?.[1]) {
      return match[1];
    }
  }

  return "Unknown";
}

export async function readSelinuxStatus(): Promise<string> {
  const enforce = await readOptionalTextFile(
    runCommand,
    "/sys/fs/selinux/enforce",
  );
  if (enforce?.trim() === "1") return "Enforcing";
  if (enforce?.trim() === "0") return "Permissive";

  const result = await runCommand("getenforce 2>/dev/null");
  if (result.errno === 0 && result.stdout.trim()) {
    return result.stdout.trim();
  }

  return "Unknown";
}
