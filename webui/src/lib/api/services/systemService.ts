import { PATHS } from "../../constants";
import type { StorageStatus, SystemInfo } from "../../types";
import {
  defaultVersion,
  hasExecBridge,
  runHybridMountJson,
  runCommandExpectOk,
} from "../core/bridge";
import { isBoolean, isRecord, isString, isStringArray } from "../core/guards";
import { shellEscapeDoubleQuoted } from "../core/shell";
import { buildModeStats, buildMountedCount } from "../codec/runtimeCodec";
import { loadRuntimeState } from "../repos/runtimeRepo";

export async function getStorageUsage(): Promise<StorageStatus> {
  try {
    const payload = await runHybridMountJson("api storage", PATHS.BINARY);
    if (!isRecord(payload)) {
      throw new Error("storage payload is invalid");
    }
    const state = await loadRuntimeState();
    const modeStats = buildModeStats(state);
    return {
      type: isString(payload.mode)
        ? (payload.mode as StorageStatus["type"])
        : "unknown",
      error: isString(payload.error) ? payload.error : undefined,
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
}

export async function getSystemInfo(): Promise<SystemInfo> {
  const payload = await runHybridMountJson("api system-info", PATHS.BINARY);
  if (!isRecord(payload)) {
    throw new Error("system info payload is invalid");
  }
  return {
    kernel: isString(payload.kernel) ? payload.kernel : "Unknown",
    selinux: isString(payload.selinux) ? payload.selinux : "Unknown",
    mountBase: isString(payload.mount_base) ? payload.mount_base : "-",
    activeMounts: isStringArray(payload.active_mounts)
      ? payload.active_mounts
      : [],
    tmpfs_xattr_supported: isBoolean(payload.tmpfs_xattr_supported)
      ? payload.tmpfs_xattr_supported
      : undefined,
    supported_overlay_modes:
      Array.isArray(payload.supported_overlay_modes) &&
      payload.supported_overlay_modes.every(isString)
        ? (payload.supported_overlay_modes as SystemInfo["supported_overlay_modes"])
        : ["tmpfs", "ext4"],
  };
}

export async function getVersion(): Promise<string> {
  const payload = await runHybridMountJson("api version", PATHS.BINARY);
  if (
    isRecord(payload) &&
    isString(payload.version) &&
    payload.version.trim()
  ) {
    return payload.version;
  }
  return defaultVersion;
}

export async function reboot(): Promise<void> {
  await runCommandExpectOk("reboot");
}

export async function openLink(url: string): Promise<void> {
  if (!hasExecBridge) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  const safeUrl = shellEscapeDoubleQuoted(url);
  await runCommandExpectOk(
    `am start -a android.intent.action.VIEW -d "${safeUrl}"`,
  );
}
