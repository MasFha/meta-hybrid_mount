import { createSignal, createRoot } from "solid-js";
import type { KasumiStatus } from "../types";
import { uiStore } from "./uiStore";
import { getKasumiStatus } from "../api/services/kasumiService";

const STATUS_CACHE_TTL_MS = 3000;

const createKasumiStore = () => {
  const [status, setStatus] = createSignal<KasumiStatus | null>(null);
  const [loading, setLoading] = createSignal(false);
  let pendingLoad: Promise<void> | null = null;
  let hasLoaded = false;
  let lastLoadedAt = 0;

  function hasFreshStatus() {
    return hasLoaded && Date.now() - lastLoadedAt < STATUS_CACHE_TTL_MS;
  }

  async function loadStatus(showError = true, force = false) {
    if (pendingLoad) return pendingLoad;
    if (!force && hasFreshStatus()) return Promise.resolve();

    setLoading(true);
    pendingLoad = (async () => {
      try {
        const nextStatus = await getKasumiStatus();
        setStatus(nextStatus);
        hasLoaded = true;
        lastLoadedAt = Date.now();
      } catch (_e) {
        setStatus(null);
        if (showError) {
          uiStore.showToast(
            uiStore.L.kasumi?.loadError || "Failed to load Kasumi status",
            "error",
          );
        }
      } finally {
        setLoading(false);
        pendingLoad = null;
      }
    })();

    return pendingLoad;
  }

  function ensureStatusLoaded() {
    return loadStatus(false, false);
  }

  function setEnabledOptimistic(enabled: boolean) {
    const current = status();
    if (!current) return;
    setStatus({
      ...current,
      config: {
        ...current.config,
        enabled,
      },
    });
    hasLoaded = true;
    lastLoadedAt = Date.now();
  }

  return {
    get status() {
      return status();
    },
    get enabled() {
      return Boolean(status()?.config?.enabled);
    },
    get loading() {
      return loading();
    },
    ensureStatusLoaded,
    refreshStatus: (showError = true, force = true) =>
      loadStatus(showError, force),
    setEnabledOptimistic,
  };
};

export const kasumiStore = createRoot(createKasumiStore);
