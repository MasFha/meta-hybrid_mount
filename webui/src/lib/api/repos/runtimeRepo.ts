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
import { runHybridMountJson } from "../core/bridge";

export async function loadRuntimeState(): Promise<RuntimeStatePayload> {
  const direct = await runHybridMountJson("daemon status", PATHS.BINARY);
  if (!isRecord(direct)) {
    throw new AppError("daemon status returned invalid payload");
  }
  return direct as RuntimeStatePayload;
}
