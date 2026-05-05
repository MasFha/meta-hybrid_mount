import { createSignal, createRoot } from "solid-js";
import { APP_VERSION } from "../constants_gen";
import { uiStore } from "./uiStore";
import type { StorageStatus, SystemInfo } from "../types";
import {
  getStorageUsage,
  getSystemInfo,
  getVersion,
} from "../api/services/systemService";

const createSysStore = () => {
  const [version, setVersion] = createSignal(APP_VERSION);
  const [storage, setStorage] = createSignal<StorageStatus>({ type: null });
  const [systemInfo, setSystemInfo] = createSignal<SystemInfo>({
    kernel: "-",
    selinux: "-",
    mountBase: "-",
    activeMounts: [],
  });
  const [activePartitions, setActivePartitions] = createSignal<string[]>([]);
  const [loading, setLoading] = createSignal(false);
  let pendingLoad: Promise<void> | null = null;
  let pendingVersionLoad: Promise<void> | null = null;
  let hasLoaded = false;
  let hasLoadedVersion = false;

  async function loadStatus() {
    if (pendingLoad) return pendingLoad;

    setLoading(true);
    pendingLoad = (async () => {
      try {
        const [storageResult, systemInfoResult] = await Promise.allSettled([
          getStorageUsage(),
          getSystemInfo(),
        ]);
        let loadedAny = false;
        let failedAny = false;

        if (storageResult.status === "fulfilled") {
          setStorage(storageResult.value);
          loadedAny = true;
        } else {
          failedAny = true;
          console.error("Failed to load storage status", storageResult.reason);
        }

        if (systemInfoResult.status === "fulfilled") {
          setSystemInfo(systemInfoResult.value);
          setActivePartitions(systemInfoResult.value.activeMounts || []);
          loadedAny = true;
        } else {
          failedAny = true;
          console.error("Failed to load system info", systemInfoResult.reason);
        }

        hasLoaded = hasLoaded || loadedAny;

        if (failedAny) {
          uiStore.showToast(
            uiStore.L.status?.loadError || "Failed to load system status",
            "error",
          );
        }
      } catch (e) {
        console.error("Failed to load system status", e);
        uiStore.showToast(
          uiStore.L.status?.loadError || "Failed to load system status",
          "error",
        );
      } finally {
        setLoading(false);
        pendingLoad = null;
      }
    })();

    return pendingLoad;
  }

  async function loadVersion() {
    if (pendingVersionLoad) return pendingVersionLoad;

    pendingVersionLoad = (async () => {
      try {
        setVersion(await getVersion());
        hasLoadedVersion = true;
      } catch (e) {
        console.error("Failed to load version", e);
      } finally {
        pendingVersionLoad = null;
      }
    })();

    return pendingVersionLoad;
  }

  function ensureStatusLoaded() {
    if (hasLoaded) return Promise.resolve();
    return loadStatus();
  }

  function ensureVersionLoaded() {
    if (hasLoadedVersion) return Promise.resolve();
    return loadVersion();
  }

  return {
    get version() {
      return version();
    },
    get storage() {
      return storage();
    },
    get systemInfo() {
      return systemInfo();
    },
    get activePartitions() {
      return activePartitions();
    },
    get loading() {
      return loading();
    },
    ensureStatusLoaded,
    ensureVersionLoaded,
    loadStatus,
    loadVersion,
  };
};

export const sysStore = createRoot(createSysStore);
