import { PATHS } from "../../constants";
import type { StorageStatus, SystemInfo } from "../../types";
import {
  defaultVersion,
  hasExecBridge,
  runCommandExpectOk,
} from "../core/bridge";
import { isBoolean, isString, isStringArray } from "../core/guards";
import { shellEscapeDoubleQuoted } from "../core/shell";
import { buildModeStats, buildMountedCount } from "../codec/runtimeCodec";
import { getModuleVersion } from "../repos/configRepo";
import {
  loadRuntimeState,
  readKernelRelease,
  readSelinuxStatus,
} from "../repos/runtimeRepo";

export async function getStorageUsage(): Promise<StorageStatus> {
  try {
    const state = await loadRuntimeState();
    const modeStats = buildModeStats(state);
    return {
      type: isString(state.storage_mode)
        ? (state.storage_mode as string as StorageStatus["type"])
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
}

export async function getSystemInfo(): Promise<SystemInfo> {
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
}

export async function getVersion(): Promise<string> {
  return getModuleVersion(PATHS.BINARY, defaultVersion);
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
