import { createSignal, createMemo, createRoot } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { normalizeModuleMode } from "../moduleMode";
import { uiStore } from "./uiStore";
import type { Module, ModeStats } from "../types";
import { scanModules, saveModules } from "../api/services/moduleService";

const createModuleStore = () => {
  const [modules, setModulesStore] = createStore<Module[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  let pendingLoad: Promise<boolean> | null = null;
  let hasLoaded = false;

  function normalizeModule(module: Module): Module {
    return {
      ...module,
      mode: normalizeModuleMode(module.mode),
      rules: {
        ...module.rules,
        default_mode: normalizeModuleMode(module.rules.default_mode),
      },
    };
  }

  const modeStats = createMemo((): ModeStats => {
    const stats = { overlay: 0, magic: 0, kasumi: 0 };
    modules.forEach((module) => {
      if (!module.is_mounted) return;
      const mode = normalizeModuleMode(module.mode);
      if (mode === "overlay") stats.overlay++;
      else if (mode === "magic") stats.magic++;
      else if (mode === "kasumi") stats.kasumi++;
    });
    return stats;
  });

  async function loadModules(force = false) {
    if (pendingLoad) return pendingLoad;
    if (hasLoaded && !force) return true;

    setLoading(true);
    pendingLoad = (async () => {
      try {
        const data = (await scanModules()).map((module) =>
          normalizeModule(module as Module),
        );
        setModulesStore(reconcile(data));
        hasLoaded = true;
        return true;
      } catch (e: any) {
        uiStore.showToast(
          e?.message ||
            uiStore.L.modules?.scanError ||
            "Failed to load modules",
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

  function ensureModulesLoaded() {
    if (hasLoaded) return Promise.resolve(true);
    return loadModules();
  }

  function invalidate() {
    hasLoaded = false;
  }

  async function saveCurrentModules() {
    setSaving(true);
    try {
      await saveModules(modules);
      uiStore.showToast(uiStore.L.common?.saved || "Saved", "success");
      return true;
    } catch (e: any) {
      uiStore.showToast(
        e?.message ||
          uiStore.L.modules?.saveFailed ||
          "Failed to save module modes",
        "error",
      );
      return false;
    } finally {
      setSaving(false);
    }
  }

  return {
    get modules() {
      return modules;
    },
    set modules(v) {
      setModulesStore(reconcile(v.map(normalizeModule)));
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
    get modeStats() {
      return modeStats();
    },
    ensureModulesLoaded,
    invalidate,
    loadModules,
    saveModules: saveCurrentModules,
  };
};

export const moduleStore = createRoot(createModuleStore);
