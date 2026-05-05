import { createSignal, createRoot } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { DEFAULT_CONFIG } from "../constants";
import { uiStore } from "./uiStore";
import type { AppConfig } from "../types";
import {
  loadConfigFromFile,
  saveConfigToFile,
  createDefaultConfig,
} from "../api/repos/configRepo";

interface SaveConfigOptions {
  showSuccess?: boolean;
  showError?: boolean;
}

function normalizeConfig(
  nextConfig: Partial<AppConfig> | null | undefined,
): AppConfig {
  return {
    moduledir: nextConfig?.moduledir ?? DEFAULT_CONFIG.moduledir,
    mountsource: nextConfig?.mountsource ?? DEFAULT_CONFIG.mountsource,
    partitions: Array.isArray(nextConfig?.partitions)
      ? [...nextConfig.partitions]
      : [...DEFAULT_CONFIG.partitions],
    overlay_mode: nextConfig?.overlay_mode ?? DEFAULT_CONFIG.overlay_mode,
    disable_umount: nextConfig?.disable_umount ?? DEFAULT_CONFIG.disable_umount,
    enable_overlay_fallback:
      nextConfig?.enable_overlay_fallback ??
      DEFAULT_CONFIG.enable_overlay_fallback,
    default_mode: nextConfig?.default_mode ?? DEFAULT_CONFIG.default_mode,
    kasumi: { ...DEFAULT_CONFIG.kasumi, ...(nextConfig?.kasumi ?? {}) },
    rules: { ...DEFAULT_CONFIG.rules, ...(nextConfig?.rules ?? {}) },
  };
}

const createConfigStore = () => {
  const [config, setConfigStore] = createStore<AppConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  let pendingLoad: Promise<boolean> | null = null;
  let hasLoaded = false;

  async function loadConfig(force = false) {
    if (pendingLoad) return pendingLoad;
    if (hasLoaded && !force) return true;

    setLoading(true);
    pendingLoad = (async () => {
      try {
        const data = await loadConfigFromFile();
        setConfigStore(reconcile(normalizeConfig(data)));
        hasLoaded = true;
        return true;
      } catch (e: any) {
        uiStore.showToast(
          e?.message || uiStore.L.config?.loadError || "Failed to load config",
          "error",
        );
        return false;
      } finally {
        setLoading(false);
        pendingLoad = null;
      }
    })();

    return pendingLoad;
  }

  function ensureConfigLoaded() {
    if (hasLoaded) return Promise.resolve(true);
    return loadConfig();
  }

  function invalidate() {
    hasLoaded = false;
  }

  async function saveConfig(
    nextConfig: AppConfig = config,
    options: SaveConfigOptions = {},
  ) {
    const { showSuccess = true, showError = true } = options;
    const normalizedConfig = normalizeConfig(nextConfig);

    setSaving(true);
    try {
      await saveConfigToFile(normalizedConfig);
      if (showSuccess) {
        uiStore.showToast(uiStore.L.common?.saved || "Saved", "success");
      }
      return true;
    } catch (e: any) {
      if (showError) {
        uiStore.showToast(
          e?.message || uiStore.L.config?.saveFailed || "Failed to save config",
          "error",
        );
      }
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function resetConfig() {
    setSaving(true);
    try {
      await saveConfigToFile(await createDefaultConfig());
      invalidate();
      const loaded = await loadConfig(true);
      if (!loaded) {
        return false;
      }
      uiStore.showToast(
        uiStore.L.config?.resetSuccess || "Config reset to defaults",
        "success",
      );
      return true;
    } catch (e: any) {
      uiStore.showToast(
        e?.message || uiStore.L.config?.saveFailed || "Failed to reset config",
        "error",
      );
      return false;
    } finally {
      setSaving(false);
    }
  }

  return {
    get config() {
      return config;
    },
    set config(v) {
      setConfigStore(reconcile(normalizeConfig(v)));
    },
    get loading() {
      return loading();
    },
    get saving() {
      return saving();
    },
    get hasLoaded() {
      return hasLoaded;
    },
    ensureConfigLoaded,
    invalidate,
    loadConfig,
    saveConfig,
    resetConfig,
  };
};

export const configStore = createRoot(createConfigStore);
