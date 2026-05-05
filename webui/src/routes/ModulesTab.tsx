import {
  createSignal,
  createMemo,
  createEffect,
  onMount,
  onCleanup,
  Show,
  For,
  createDeferred,
} from "solid-js";
import { uiStore } from "../lib/stores/uiStore";
import { moduleStore } from "../lib/stores/moduleStore";
import { kasumiStore } from "../lib/stores/kasumiStore";
import { ICONS } from "../lib/constants";
import Skeleton from "../components/Skeleton";
import BottomActions from "../components/BottomActions";
import { normalizeModuleMode } from "../lib/moduleMode";
import type { Module, MountMode } from "../lib/types";
import "./ModulesTab.css";
import "@material/web/iconbutton/filled-tonal-icon-button.js";
import "@material/web/button/filled-tonal-button.js";
import "@material/web/icon/icon.js";

export default function ModulesTab() {
  const BATCH_SIZE = 20;
  const [searchQuery, setSearchQuery] = createSignal("");
  const deferredSearchQuery = createDeferred(searchQuery);
  const [filterType, setFilterType] = createSignal<"all" | MountMode>("all");
  const [showUmount, setShowUmount] = createSignal(false);
  const [expandedId, setExpandedId] = createSignal<string | null>(null);
  const [visibleCount, setVisibleCount] = createSignal(BATCH_SIZE);
  let observerTarget: HTMLDivElement | undefined;

  onMount(() => {
    load();
    const observerRoot = observerTarget?.closest(".page-scroller") ?? undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          setVisibleCount((count) => count + BATCH_SIZE);
        }
      },
      { root: observerRoot, rootMargin: "200px" },
    );
    if (observerTarget) observer.observe(observerTarget);
    onCleanup(() => observer.disconnect());
  });

  createEffect(() => {
    searchQuery();
    filterType();
    showUmount();
    setVisibleCount(BATCH_SIZE);
  });

  const kasumiMasterEnabled = createMemo(() => kasumiStore.enabled);
  const kasumiAvailable = createMemo(
    () => kasumiMasterEnabled() && Boolean(kasumiStore.status?.available),
  );
  const showKasumiStrategy = createMemo(() => kasumiMasterEnabled());

  createEffect(() => {
    if (!showKasumiStrategy() && filterType() === "kasumi") {
      setFilterType("all");
    }
  });

  function load(force = false) {
    void moduleStore.loadModules(force);
  }

  function updateModule(modId: string, transform: (m: Module) => Module) {
    const idx = moduleStore.modules.findIndex((m) => m.id === modId);
    if (idx === -1) return;

    const newModules = [...moduleStore.modules];
    newModules[idx] = transform({ ...newModules[idx] });
    moduleStore.modules = newModules;
  }

  async function updateDefaultMode(mod: Module, mode: MountMode) {
    const newRules = { ...mod.rules, default_mode: mode };
    updateModuleRules(mod.id, () => newRules);
    const saved = await moduleStore.saveModules();
    if (!saved) {
      await moduleStore.loadModules(true);
    }
  }

  const filteredModules = createMemo(() =>
    moduleStore.modules.filter((module) => {
      const q = deferredSearchQuery().toLowerCase();
      if (!module.is_mounted && !showUmount()) {
        return false;
      }
      const matchSearch =
        module.name.toLowerCase().includes(q) ||
        module.id.toLowerCase().includes(q);
      if (!matchSearch) return false;
      if (
        filterType() !== "all" &&
        normalizeModuleMode(module.mode) !== filterType()
      ) {
        return false;
      }

      return true;
    }),
  );
  const canLoadMore = createMemo(
    () => visibleCount() < filteredModules().length,
  );

  function loadMore() {
    setVisibleCount((count) => count + BATCH_SIZE);
  }

  function toggleExpand(id: string) {
    if (expandedId() === id) {
      setExpandedId(null);
    } else {
      setExpandedId(id);
    }
  }

  function getModeLabel(mod: Module) {
    const modes = uiStore.L.modules?.modes;
    if (!mod.is_mounted) return modes?.umount ?? "Umount";
    if (normalizeModuleMode(mod.mode) === "magic")
      return modes?.magic ?? "Magic";
    if (normalizeModuleMode(mod.mode) === "kasumi") {
      return modes?.kasumi ?? "Kasumi";
    }
    return modes?.overlay ?? "OverlayFS";
  }

  function getModeClass(mod: Module) {
    if (!mod.is_mounted) return "mode-ignore";
    if (normalizeModuleMode(mod.mode) === "magic") return "mode-magic";
    if (normalizeModuleMode(mod.mode) === "kasumi") return "mode-kasumi";
    return "mode-overlay";
  }

  function getEffectiveDefaultMode(mod: Module): MountMode {
    const mode = normalizeModuleMode(mod.rules.default_mode);
    if (mode === "kasumi" && !kasumiAvailable()) {
      return "ignore";
    }
    return mode;
  }

  function updateModuleRules(
    modId: string,
    updateFn: (rules: Module["rules"]) => Module["rules"],
  ) {
    updateModule(modId, (module) => ({
      ...module,
      rules: updateFn(module.rules),
    }));
  }

  return (
    <>
      <div class="modules-page">
        <div class="header-section">
          <div class="search-bar">
            <svg class="search-icon" viewBox="0 0 24 24">
              <path d={ICONS.search} />
            </svg>
            <input
              type="text"
              class="search-input"
              placeholder={uiStore.L.modules?.searchPlaceholder}
              aria-label={
                uiStore.L.modules?.searchPlaceholder || "Search modules"
              }
              value={searchQuery()}
              onInput={(e) => setSearchQuery(e.currentTarget.value)}
            />

            <div class="filter-group">
              <button
                class={`btn-icon ${showUmount() ? "active" : ""}`}
                onClick={() => setShowUmount(!showUmount())}
                title={showUmount() ? "Hide Umount" : "Show Umount"}
                type="button"
                aria-pressed={showUmount()}
              >
                <svg viewBox="0 0 24 24" width="20" height="20">
                  <path
                    d={showUmount() ? ICONS.visibility : ICONS.visibility_off}
                    fill="currentColor"
                  />
                </svg>
              </button>

              <select
                class="filter-select"
                value={filterType()}
                onChange={(e) =>
                  setFilterType(e.currentTarget.value as "all" | MountMode)
                }
                aria-label={uiStore.L.modules?.filterLabel || "Filter modules"}
                title={uiStore.L.modules?.filterLabel || "Filter modules"}
              >
                <option value="all">{uiStore.L.modules?.filterAll}</option>
                <option value="overlay">
                  {uiStore.L.modules?.modes?.short?.overlay ?? "Overlay"}
                </option>
                <option value="magic">
                  {uiStore.L.modules?.modes?.short?.magic ?? "Magic"}
                </option>
                <Show when={showKasumiStrategy()}>
                  <option value="kasumi">
                    {uiStore.L.modules?.modes?.short?.kasumi ?? "Kasumi"}
                  </option>
                </Show>
              </select>
            </div>
          </div>
        </div>

        <div class="modules-list">
          <Show
            when={!moduleStore.loading}
            fallback={
              <For each={Array(6)}>
                {() => <Skeleton variant="module-card" />}
              </For>
            }
          >
            <Show
              when={filteredModules().length > 0}
              fallback={
                <div class="empty-state">
                  <div class="empty-icon">
                    <md-icon>
                      <svg viewBox="0 0 24 24">
                        <path d={ICONS.modules} />
                      </svg>
                    </md-icon>
                  </div>
                  <div>
                    {uiStore.L.modules?.emptyState ?? "No modules found."}
                  </div>
                  <Show when={!showUmount()}>
                    <div class="empty-state-hint">
                      {uiStore.L.modules?.umountHiddenHint ??
                        "Umount modules are hidden."}
                    </div>
                  </Show>
                </div>
              }
            >
              <For each={filteredModules().slice(0, visibleCount())}>
                {(mod) => {
                  const effectiveDefaultMode = () =>
                    getEffectiveDefaultMode(mod);
                  return (
                    <div
                      class={`module-card ${expandedId() === mod.id ? "expanded" : ""} ${mod.is_mounted ? "" : "unmounted"}`}
                    >
                      <button
                        class="module-header"
                        onClick={() => toggleExpand(mod.id)}
                        type="button"
                        aria-expanded={expandedId() === mod.id}
                      >
                        <div class="module-info">
                          <div class="module-name">{mod.name}</div>
                          <div class="module-meta">
                            <span class="module-id">{mod.id}</span>
                            <span class="version-badge">{mod.version}</span>
                          </div>
                        </div>
                        <div class={`mode-indicator ${getModeClass(mod)}`}>
                          {getModeLabel(mod)}
                        </div>
                      </button>

                      <div class="module-body-wrapper">
                        <div class="module-body-inner">
                          <div class="module-body-content">
                            <p class="module-desc">{mod.description}</p>

                            <div class="body-section">
                              <div class="section-label">
                                {uiStore.L.modules?.defaultMode ?? "Strategy"}
                              </div>
                              <div class="strategy-selector">
                                <button
                                  class={`strategy-option ${effectiveDefaultMode() === "overlay" ? "selected" : ""}`}
                                  onClick={() =>
                                    updateDefaultMode(mod, "overlay")
                                  }
                                  type="button"
                                >
                                  <span class="opt-title">
                                    {uiStore.L.modules?.modes?.short?.overlay ??
                                      "Overlay"}
                                  </span>
                                  <span class="opt-sub">
                                    {uiStore.L.modules?.defaultTag ?? "Default"}
                                  </span>
                                </button>
                                <button
                                  class={`strategy-option ${effectiveDefaultMode() === "magic" ? "selected" : ""}`}
                                  onClick={() =>
                                    updateDefaultMode(mod, "magic")
                                  }
                                  type="button"
                                >
                                  <span class="opt-title">
                                    {uiStore.L.modules?.modes?.short?.magic ??
                                      "Magic"}
                                  </span>
                                  <span class="opt-sub">
                                    {uiStore.L.modules?.compatTag ?? "Compat"}
                                  </span>
                                </button>
                                <Show when={showKasumiStrategy()}>
                                  <button
                                    class={`strategy-option ${effectiveDefaultMode() === "kasumi" ? "selected" : ""}`}
                                    onClick={() =>
                                      updateDefaultMode(mod, "kasumi")
                                    }
                                    disabled={!kasumiAvailable()}
                                    title={
                                      !kasumiAvailable()
                                        ? (uiStore.L.modules
                                            ?.kasumiUnavailableHint ??
                                          "Kasumi is not currently available")
                                        : undefined
                                    }
                                    type="button"
                                  >
                                    <span class="opt-title">
                                      {uiStore.L.modules?.modes?.short
                                        ?.kasumi ?? "Kasumi"}
                                    </span>
                                    <span class="opt-sub">
                                      {!kasumiAvailable()
                                        ? (uiStore.L.modules?.unavailableTag ??
                                          "Unavailable")
                                        : (uiStore.L.modules?.nativeTag ??
                                          "Stealth")}
                                    </span>
                                  </button>
                                </Show>
                                <button
                                  class={`strategy-option ${effectiveDefaultMode() === "ignore" ? "selected" : ""}`}
                                  onClick={() =>
                                    updateDefaultMode(mod, "ignore")
                                  }
                                  type="button"
                                >
                                  <span class="opt-title">
                                    {uiStore.L.modules?.modes?.short?.ignore ??
                                      "Ignore"}
                                  </span>
                                  <span class="opt-sub">
                                    {uiStore.L.modules?.disableTag ?? "Disable"}
                                  </span>
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                }}
              </For>
              <div ref={observerTarget} class="observer-sentinel"></div>
            </Show>
          </Show>
        </div>
      </div>

      <BottomActions>
        <Show when={canLoadMore()}>
          <md-filled-tonal-button onClick={loadMore}>
            {uiStore.L.modules?.loadMore ?? "Load More"}
          </md-filled-tonal-button>
        </Show>

        <md-filled-tonal-icon-button
          onClick={() => load(true)}
          disabled={moduleStore.loading}
          title={uiStore.L.modules?.reload}
        >
          <md-icon>
            <svg viewBox="0 0 24 24">
              <path d={ICONS.refresh} />
            </svg>
          </md-icon>
        </md-filled-tonal-icon-button>
      </BottomActions>
    </>
  );
}
