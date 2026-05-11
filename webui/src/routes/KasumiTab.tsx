import { For, Show, createMemo, createSignal, onMount } from "solid-js";
import { createStore } from "solid-js/store";
import { API } from "../lib/api";
import { ICONS } from "../lib/constants";
import { uiStore } from "../lib/stores/uiStore";
import { kasumiStore } from "../lib/stores/kasumiStore";
import type { KasumiStatus } from "../lib/types";
import BottomActions from "../components/BottomActions";
import Skeleton from "../components/Skeleton";
import "./KasumiTab.css";
import "./StatusTab.css";

import "@material/web/button/filled-button.js";
import "@material/web/button/outlined-button.js";
import "@material/web/button/text-button.js";
import "@material/web/dialog/dialog.js";
import "@material/web/icon/icon.js";
import "@material/web/iconbutton/filled-tonal-icon-button.js";
import "@material/web/list/list.js";
import "@material/web/list/list-item.js";
import "@material/web/ripple/ripple.js";
import "@material/web/textfield/outlined-text-field.js";

const KNOWN_KMI_OPTIONS = [
  "android12-5.10",
  "android13-5.10",
  "android13-5.15",
  "android14-5.15",
  "android14-6.1",
  "android15-6.6",
  "android16-6.12",
] as const;
const EXPAND_MORE_ICON = "M7.41 8.59 12 13.17l4.59-4.58L18 10l-6 6-6-6z";

type RefreshMode = "status-only" | "full";

const USER_HIDE_RULES_CACHE_TTL_MS = 3000;

function parseUnsignedInput(value: string, label: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${label} cannot be empty`);
  }
  const parsed = /^0x/i.test(trimmed)
    ? Number.parseInt(trimmed, 16)
    : Number.parseInt(trimmed, 10);

  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < 0) {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  return parsed;
}

export default function KasumiTab() {
  const [userHideRules, setUserHideRules] = createSignal<string[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [pending, setPending] = createSignal(false);
  const [showKmiDialog, setShowKmiDialog] = createSignal(false);
  const [showUnloadLkmWarning, setShowUnloadLkmWarning] = createSignal(false);
  const [expandedSection, setExpandedSection] = createSignal<string | null>(
    null,
  );
  const [forms, setForms] = createStore({
    kmi: "",
    unameMode: "scoped" as "scoped" | "global",
    release: "",
    version: "",
    cmdline: "",
    mapsTargetIno: "",
    mapsTargetDev: "0",
    mapsSpoofedIno: "",
    mapsSpoofedDev: "0",
    mapsPath: "",
    userHidePath: "",
  });
  let pendingUserHideRulesLoad: Promise<void> | null = null;
  let hasLoadedUserHideRules = false;
  let userHideRulesLoadedAt = 0;

  function hasFreshUserHideRules() {
    return (
      hasLoadedUserHideRules &&
      Date.now() - userHideRulesLoadedAt < USER_HIDE_RULES_CACHE_TTL_MS
    );
  }

  function syncForms(nextStatus: KasumiStatus) {
    const config = nextStatus.config;
    const uname = config.uname || {
      sysname: "",
      nodename: "",
      release: "",
      version: "",
      machine: "",
      domainname: "",
    };

    setForms({
      kmi: nextStatus.lkm?.kmi_override || config.lkm_kmi_override || "",
      unameMode: config.uname_mode === "global" ? "global" : "scoped",
      release: uname.release || "",
      version: uname.version || "",
      cmdline: config.cmdline_value || "",
      mapsTargetIno: "",
      mapsTargetDev: "0",
      mapsSpoofedIno: "",
      mapsSpoofedDev: "0",
      mapsPath: "",
      userHidePath: "",
    });
  }

  async function refreshStatusOnly(force = false) {
    if (force) {
      await kasumiStore.refreshStatus(true, true);
    } else {
      await kasumiStore.ensureStatusLoaded();
    }
    const nextStatus = kasumiStore.status;
    if (nextStatus) {
      syncForms(nextStatus);
    }
  }

  async function loadUserHideRules(force = false) {
    if (pendingUserHideRulesLoad) return pendingUserHideRulesLoad;
    if (!force && hasFreshUserHideRules()) return Promise.resolve();

    pendingUserHideRulesLoad = (async () => {
      const nextUserHideRules = await API.getUserHideRules();
      setUserHideRules(nextUserHideRules);
      hasLoadedUserHideRules = true;
      userHideRulesLoadedAt = Date.now();
    })();

    try {
      await pendingUserHideRulesLoad;
    } finally {
      pendingUserHideRulesLoad = null;
    }
  }

  async function load(mode: RefreshMode = "full") {
    setLoading(true);
    try {
      if (mode === "full") {
        await Promise.all([refreshStatusOnly(true), loadUserHideRules(true)]);
      } else {
        await refreshStatusOnly(true);
      }
    } catch (e: any) {
      uiStore.showToast(
        e?.message || uiStore.L.kasumi?.loadError || "Failed to load Kasumi",
        "error",
      );
    } finally {
      setLoading(false);
    }
  }

  async function initialize() {
    setLoading(true);
    try {
      await refreshStatusOnly(false);
    } catch (e: any) {
      uiStore.showToast(
        e?.message || uiStore.L.kasumi?.loadError || "Failed to load Kasumi",
        "error",
      );
    } finally {
      setLoading(false);
    }
  }

  async function runAction(
    action: () => Promise<void>,
    success: string,
    refreshMode: RefreshMode = "status-only",
  ) {
    setPending(true);
    try {
      await action();
      await load(refreshMode);
      uiStore.showToast(success, "success");
    } catch (e: any) {
      uiStore.showToast(e?.message || "Action failed", "error");
    } finally {
      setPending(false);
    }
  }

  async function fillOriginalKernelUname() {
    setPending(true);
    try {
      const original = await API.getOriginalKernelUname();
      setForms("release", original.release || "");
      setForms("version", original.version || "");
      uiStore.showToast(
        uiStore.L.kasumi?.originalKernelLoaded ??
          "Loaded original kernel values",
        "success",
      );
    } catch (e: any) {
      uiStore.showToast(
        e?.message ||
          uiStore.L.kasumi?.originalKernelLoadFailed ||
          "Failed to read original kernel values",
        "error",
      );
    } finally {
      setPending(false);
    }
  }

  async function saveAndApplyUname() {
    const release = forms.release.trim();
    const version = forms.version.trim();

    await API.setKasumiUnameMode(forms.unameMode);
    await API.setKasumiUname({ release, version });
    if (release && version) {
      await API.applyKasumiUname(forms.unameMode, {
        release,
        version,
      });
    }
  }

  async function clearUname() {
    await API.setKasumiUnameMode(forms.unameMode);
    await API.clearKasumiUname(forms.unameMode);
  }

  onMount(() => {
    void initialize();
  });

  const status = createMemo(() => kasumiStore.status);
  const config = createMemo(() => status()?.config);
  const lkm = createMemo(() => status()?.lkm);
  const activeModules = createMemo(
    () => status()?.runtime?.kasumi_modules || [],
  );
  const mapsSpoofSupported = createMemo(() =>
    (status()?.feature_names || []).includes("maps_spoof"),
  );
  const kmiOptions = createMemo(() => {
    const options = ["", ...KNOWN_KMI_OPTIONS];
    if (forms.kmi && !options.includes(forms.kmi)) {
      options.push(forms.kmi);
    }
    return options;
  });
  const heroStatusText = createMemo(() => {
    if (loading()) {
      return uiStore.L.kasumi?.statusLoading ?? "Loading";
    }
    if (status()?.status === "disabled_runtime_present") {
      return (
        uiStore.L.kasumi?.statusConfigOffRuntimeOn ??
        "Config Off / Runtime Still Loaded"
      );
    }
    if (status()?.status === "disabled") {
      return uiStore.L.kasumi?.statusDisabled ?? "Disabled";
    }
    return status()?.available
      ? (uiStore.L.kasumi?.statusWorking ?? "Working")
      : (uiStore.L.kasumi?.statusUnavailable ?? "Unavailable");
  });
  const autoloadText = createMemo(() =>
    lkm()?.autoload
      ? (uiStore.L.kasumi?.autoloadOn ?? "Autoload On")
      : (uiStore.L.kasumi?.autoloadOff ?? "Autoload Off"),
  );
  const heroSubtitleText = createMemo(
    () =>
      `API ${status()?.protocol_version ?? "-"} · ${uiStore.L.kasumi?.rulesBadge ?? "Rules"} ${status()?.rule_count ?? 0}`,
  );
  const statusChipText = createMemo(
    () => status()?.mirror_path || config()?.mirror_path || "-",
  );
  const unameModeDescription = createMemo(() =>
    forms.unameMode === "global"
      ? (uiStore.L.kasumi?.unameModeGlobalDesc ??
        "System-wide: rewrites init_uts_ns, every task sees fake values.")
      : (uiStore.L.kasumi?.unameModeScopedDesc ??
        "Per-process: only Kasumi-hidden UIDs see fake values."),
  );

  function isSectionExpanded(id: string) {
    return expandedSection() === id;
  }

  async function handleSectionToggle(id: string) {
    const willExpand = expandedSection() !== id;
    setExpandedSection(willExpand ? id : null);

    if (!willExpand || id !== "user-hide") return;

    try {
      await loadUserHideRules();
    } catch (e: any) {
      uiStore.showToast(
        e?.message || uiStore.L.kasumi?.loadError || "Failed to load Kasumi",
        "error",
      );
    }
  }

  return (
    <>
      <div class="dialog-container">
        <md-dialog
          open={showKmiDialog()}
          onclose={() => setShowKmiDialog(false)}
          class="transparent-scrim"
        >
          <div slot="headline">
            {uiStore.L.kasumi?.kmiOverride ?? "KMI Override"}
          </div>
          <div slot="content" class="kasumi-kmi-dialog">
            <md-list>
              <For each={kmiOptions()}>
                {(option) => {
                  const label = option
                    ? option
                    : (uiStore.L.kasumi?.autoKmi ?? "Auto Detect");

                  return (
                    <md-list-item
                      class="lang-option"
                      type="button"
                      onClick={() => {
                        setForms("kmi", option);
                        setShowKmiDialog(false);
                      }}
                    >
                      <div slot="headline">{label}</div>
                      <Show when={forms.kmi === option}>
                        <md-icon slot="end">
                          <svg viewBox="0 0 24 24">
                            <path d={ICONS.check} />
                          </svg>
                        </md-icon>
                      </Show>
                    </md-list-item>
                  );
                }}
              </For>
            </md-list>
          </div>
          <div slot="actions">
            <md-text-button onClick={() => setShowKmiDialog(false)}>
              {uiStore.L.common?.cancel ?? "Cancel"}
            </md-text-button>
          </div>
        </md-dialog>
      </div>

      <div class="dialog-container">
        <md-dialog
          open={showUnloadLkmWarning()}
          onclose={() => setShowUnloadLkmWarning(false)}
          class="transparent-scrim"
        >
          <div slot="headline">
            {uiStore.L.kasumi?.unloadLkmWarningTitle ?? "注意！"}
          </div>
          <div slot="content">
            {uiStore.L.kasumi?.unloadLkmWarningBody ??
              "Kasumi 使用 TSR 模式时可能无法卸载，如 5 秒内未成功卸载，Kasumi 将会在 3 秒后自动安全重启，你确定要卸载吗？"}
          </div>
          <div slot="actions">
            <md-text-button onClick={() => setShowUnloadLkmWarning(false)}>
              {uiStore.L.kasumi?.unloadLkmWarningCancel ?? "取消"}
            </md-text-button>
            <md-text-button
              onClick={() => {
                setShowUnloadLkmWarning(false);
                void runAction(
                  () => API.unloadKasumiLkm(),
                  uiStore.L.kasumi?.unloadLkm ?? "LKM unloaded",
                );
              }}
            >
              {uiStore.L.kasumi?.unloadLkmWarningConfirm ?? "确定"}
            </md-text-button>
          </div>
        </md-dialog>
      </div>

      <div class="kasumi-page">
        <div class="dashboard-grid kasumi-dashboard-grid">
          <section class="hero-card kasumi-status-card">
            <Show
              when={!loading()}
              fallback={
                <div class="skeleton-col">
                  <Skeleton variant="hero-label" />
                  <Skeleton variant="hero-title" />
                  <Skeleton variant="hero-caption" />
                </div>
              }
            >
              <div class="hero-content">
                <span class="hero-label">
                  {uiStore.L.kasumi?.title ?? "Kasumi Runtime"}
                </span>
                <span class="hero-value">{heroStatusText()}</span>
                <span class="kasumi-hero-caption">{heroSubtitleText()}</span>
              </div>

              <div class="mount-base-chip">
                <md-icon class="mount-base-icon">
                  <svg viewBox="0 0 24 24">
                    <path d={ICONS.mount_path} />
                  </svg>
                </md-icon>
                <span class="mount-base-text">{statusChipText()}</span>
              </div>
            </Show>
          </section>
        </div>

        <div class="kasumi-grid">
          <section
            class={`kasumi-card kasumi-section ${isSectionExpanded("lkm") ? "expanded" : ""}`}
          >
            <button
              class="kasumi-section-toggle"
              type="button"
              aria-expanded={isSectionExpanded("lkm") ? "true" : "false"}
              aria-controls="kasumi-section-lkm"
              onClick={() => void handleSectionToggle("lkm")}
            >
              <div class="kasumi-card-head kasumi-section-toggle-inner">
                <div>
                  <div class="kasumi-card-title">
                    {uiStore.L.kasumi?.lkmTitle ?? "Kernel Module"}
                  </div>
                </div>
                <div class="kasumi-section-toggle-end">
                  <div class={`state-pill ${lkm()?.autoload ? "active" : ""}`}>
                    {autoloadText()}
                  </div>
                  <md-icon class="kasumi-section-chevron" aria-hidden="true">
                    <svg viewBox="0 0 24 24">
                      <path d={EXPAND_MORE_ICON} />
                    </svg>
                  </md-icon>
                </div>
              </div>
            </button>
            <div class="kasumi-section-body-wrapper" id="kasumi-section-lkm">
              <div class="kasumi-section-body-inner">
                <div class="kasumi-section-body">
                  <div class="meta-list">
                    <div class="meta-row">
                      <span>
                        {uiStore.L.kasumi?.currentKmi ?? "Current KMI"}
                      </span>
                      <strong>{lkm()?.current_kmi || "-"}</strong>
                    </div>
                  </div>
                  <div class="field-row">
                    <button
                      class="kasumi-select-button"
                      type="button"
                      disabled={pending()}
                      onClick={() => setShowKmiDialog(true)}
                    >
                      <div class="kasumi-select-button-label">
                        {uiStore.L.kasumi?.kmiOverride ?? "KMI Override"}
                      </div>
                      <div class="kasumi-select-button-value">
                        {forms.kmi ||
                          (uiStore.L.kasumi?.autoKmi ?? "Auto Detect")}
                      </div>
                    </button>
                  </div>
                  <div class="button-row">
                    <md-filled-button
                      disabled={pending()}
                      onClick={() =>
                        runAction(
                          () => API.setKasumiLkmKmi(forms.kmi),
                          uiStore.L.kasumi?.saveKmi ?? "KMI saved",
                        )
                      }
                    >
                      {uiStore.L.kasumi?.saveKmi ?? "Save KMI"}
                    </md-filled-button>
                  </div>
                  <div class="button-row">
                    <md-outlined-button
                      disabled={pending()}
                      onClick={() =>
                        runAction(
                          () =>
                            API.setKasumiLkmAutoload(!Boolean(lkm()?.autoload)),
                          uiStore.L.kasumi?.autoloadUpdated ??
                            "Autoload updated",
                        )
                      }
                    >
                      {lkm()?.autoload
                        ? (uiStore.L.kasumi?.disableAutoload ??
                          "Disable autoload")
                        : (uiStore.L.kasumi?.enableAutoload ??
                          "Enable autoload")}
                    </md-outlined-button>
                    <md-filled-button
                      disabled={pending()}
                      onClick={() =>
                        lkm()?.loaded
                          ? setShowUnloadLkmWarning(true)
                          : runAction(
                              () => API.loadKasumiLkm(),
                              uiStore.L.kasumi?.loadLkm ?? "LKM loaded",
                            )
                      }
                    >
                      {lkm()?.loaded
                        ? (uiStore.L.kasumi?.unloadLkm ?? "Unload LKM")
                        : (uiStore.L.kasumi?.loadLkm ?? "Load LKM")}
                    </md-filled-button>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section
            class={`kasumi-card kasumi-section ${isSectionExpanded("runtime") ? "expanded" : ""}`}
          >
            <button
              class="kasumi-section-toggle"
              type="button"
              aria-expanded={isSectionExpanded("runtime") ? "true" : "false"}
              aria-controls="kasumi-section-runtime"
              onClick={() => void handleSectionToggle("runtime")}
            >
              <div class="kasumi-card-head kasumi-section-toggle-inner">
                <div>
                  <div class="kasumi-card-title">
                    {uiStore.L.kasumi?.runtimeTitle ?? "Runtime"}
                  </div>
                </div>
                <md-icon class="kasumi-section-chevron" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d={EXPAND_MORE_ICON} />
                  </svg>
                </md-icon>
              </div>
            </button>
            <div
              class="kasumi-section-body-wrapper"
              id="kasumi-section-runtime"
            >
              <div class="kasumi-section-body-inner">
                <div class="kasumi-section-body">
                  <div class="kasumi-config-grid">
                    <button
                      type="button"
                      class={`kasumi-config-tile ${config()?.enable_stealth ? "active" : ""}`}
                      disabled={pending()}
                      onClick={() =>
                        runAction(
                          () =>
                            API.setKasumiStealth(
                              !Boolean(config()?.enable_stealth),
                            ),
                          uiStore.L.kasumi?.stealthUpdated ?? "Stealth updated",
                        )
                      }
                    >
                      <md-ripple></md-ripple>
                      <div class="kasumi-config-icon">
                        <md-icon>
                          <svg viewBox="0 0 24 24">
                            <path d={ICONS.ghost} />
                          </svg>
                        </md-icon>
                      </div>
                      <span class="kasumi-config-label">
                        {uiStore.L.kasumi?.stealthTitle ?? "Stealth"}
                      </span>
                    </button>
                    <button
                      type="button"
                      class={`kasumi-config-tile ${config()?.enable_hidexattr ? "active" : ""}`}
                      disabled={pending()}
                      onClick={() =>
                        runAction(
                          () =>
                            API.setKasumiHidexattr(
                              !Boolean(config()?.enable_hidexattr),
                            ),
                          uiStore.L.kasumi?.hidexattrUpdated ??
                            "HideXattr updated",
                        )
                      }
                    >
                      <md-ripple></md-ripple>
                      <div class="kasumi-config-icon">
                        <md-icon>
                          <svg viewBox="0 0 24 24">
                            <path d={ICONS.visibility_off} />
                          </svg>
                        </md-icon>
                      </div>
                      <span class="kasumi-config-label">
                        {uiStore.L.kasumi?.hidexattrTitle ?? "HideXattr"}
                      </span>
                    </button>
                    <button
                      type="button"
                      class={`kasumi-config-tile ${config()?.enable_kernel_debug ? "active" : ""}`}
                      disabled={pending()}
                      onClick={() =>
                        runAction(
                          () =>
                            API.setKasumiDebug(
                              !Boolean(config()?.enable_kernel_debug),
                            ),
                          uiStore.L.kasumi?.kernelDebugUpdated ??
                            "Kernel debug updated",
                        )
                      }
                    >
                      <md-ripple></md-ripple>
                      <div class="kasumi-config-icon">
                        <md-icon>
                          <svg viewBox="0 0 24 24">
                            <path d={ICONS.bug} />
                          </svg>
                        </md-icon>
                      </div>
                      <span class="kasumi-config-label">
                        {uiStore.L.kasumi?.kernelDebugTitle ?? "Kernel Debug"}
                      </span>
                    </button>
                    <button
                      type="button"
                      class={`kasumi-config-tile ${config()?.enable_selinux_fix ? "active" : ""}`}
                      disabled={pending()}
                      onClick={() =>
                        runAction(
                          () =>
                            API.setKasumiSelinuxFix(
                              !Boolean(config()?.enable_selinux_fix),
                            ),
                          uiStore.L.kasumi?.selinuxFixUpdated ??
                            "SELinux guard updated",
                        )
                      }
                    >
                      <md-ripple></md-ripple>
                      <div class="kasumi-config-icon">
                        <md-icon>
                          <svg viewBox="0 0 24 24">
                            <path d={ICONS.shield} />
                          </svg>
                        </md-icon>
                      </div>
                      <span class="kasumi-config-label">
                        {uiStore.L.kasumi?.selinuxFixTitle ?? "SELinux Guard"}
                      </span>
                    </button>
                  </div>
                  <Show
                    when={
                      !status()?.available &&
                      status()?.status !== "disabled" &&
                      !lkm()?.loaded
                    }
                  >
                    <div class="runtime-note warning">
                      {uiStore.L.kasumi?.lkmUnavailableHint ??
                        "Kasumi is enabled, but the kernel module is not loaded yet."}
                    </div>
                  </Show>
                </div>
              </div>
            </div>
          </section>

          <section
            class={`kasumi-card kasumi-section ${isSectionExpanded("identity") ? "expanded" : ""}`}
          >
            <button
              class="kasumi-section-toggle"
              type="button"
              aria-expanded={isSectionExpanded("identity") ? "true" : "false"}
              aria-controls="kasumi-section-identity"
              onClick={() => void handleSectionToggle("identity")}
            >
              <div class="kasumi-card-head kasumi-section-toggle-inner">
                <div>
                  <div class="kasumi-card-title">
                    {uiStore.L.kasumi?.identityTitle ?? "Identity Spoof"}
                  </div>
                </div>
                <md-icon class="kasumi-section-chevron" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d={EXPAND_MORE_ICON} />
                  </svg>
                </md-icon>
              </div>
            </button>
            <div
              class="kasumi-section-body-wrapper"
              id="kasumi-section-identity"
            >
              <div class="kasumi-section-body-inner">
                <div class="kasumi-section-body field-stack">
                  <div class="uname-panel">
                    <div class="uname-panel-head">
                      <div>
                        <div class="uname-panel-title">
                          {uiStore.L.kasumi?.unameSpoofTitle ??
                            "Kernel version spoofing"}
                        </div>
                        <div class="uname-panel-subtitle">
                          {forms.release || forms.version
                            ? `${forms.release || "-"} · ${forms.version || "-"}`
                            : (uiStore.L.kasumi?.unameEmptyHint ??
                              "No spoofed uname configured.")}
                        </div>
                      </div>
                      <div
                        class={`state-pill ${forms.unameMode === "global" ? "active" : ""}`}
                      >
                        {forms.unameMode === "global"
                          ? (uiStore.L.kasumi?.unameModeGlobal ?? "Global")
                          : (uiStore.L.kasumi?.unameModeScoped ?? "Scoped")}
                      </div>
                    </div>

                    <div class="uname-field-grid">
                      <md-outlined-text-field
                        class="full-field kasumi-input-field"
                        label={uiStore.L.kasumi?.unameRelease ?? "Version name"}
                        value={forms.release}
                        supporting-text={
                          uiStore.L.kasumi?.unameReleaseDesc ??
                          "Kernel release, for example 5.15.0-generic."
                        }
                        onInput={(e: Event) =>
                          setForms(
                            "release",
                            (e.currentTarget as HTMLInputElement).value,
                          )
                        }
                        disabled={pending()}
                      />
                      <md-outlined-text-field
                        class="full-field kasumi-input-field"
                        label={uiStore.L.kasumi?.unameVersion ?? "Build time"}
                        value={forms.version}
                        supporting-text={
                          uiStore.L.kasumi?.unameVersionDesc ??
                          "Kernel version/build timestamp."
                        }
                        onInput={(e: Event) =>
                          setForms(
                            "version",
                            (e.currentTarget as HTMLInputElement).value,
                          )
                        }
                        disabled={pending()}
                      />
                    </div>

                    <div class="uname-mode-row">
                      <div class="uname-segmented" role="radiogroup">
                        <button
                          type="button"
                          class={forms.unameMode === "scoped" ? "selected" : ""}
                          disabled={pending()}
                          onClick={() => setForms("unameMode", "scoped")}
                        >
                          {uiStore.L.kasumi?.unameModeScoped ?? "Scoped"}
                        </button>
                        <button
                          type="button"
                          class={forms.unameMode === "global" ? "selected" : ""}
                          disabled={pending()}
                          onClick={() => setForms("unameMode", "global")}
                        >
                          {uiStore.L.kasumi?.unameModeGlobal ?? "Global"}
                        </button>
                      </div>
                      <div class="uname-mode-desc">
                        {unameModeDescription()}
                      </div>
                    </div>

                    <div class="button-row">
                      <md-outlined-button
                        disabled={pending()}
                        onClick={() => void fillOriginalKernelUname()}
                      >
                        {uiStore.L.kasumi?.fillOriginalKernel ??
                          "Use current kernel info"}
                      </md-outlined-button>
                      <md-filled-button
                        disabled={
                          pending() ||
                          !forms.release.trim() ||
                          !forms.version.trim()
                        }
                        onClick={() =>
                          runAction(
                            saveAndApplyUname,
                            uiStore.L.kasumi?.applyUname ?? "Uname applied",
                          )
                        }
                      >
                        {uiStore.L.kasumi?.applyUname ?? "Apply Uname"}
                      </md-filled-button>
                      <md-outlined-button
                        disabled={pending()}
                        onClick={() =>
                          runAction(
                            clearUname,
                            uiStore.L.kasumi?.clearUname ?? "Uname cleared",
                          )
                        }
                      >
                        {uiStore.L.kasumi?.clearUname ?? "Clear Uname"}
                      </md-outlined-button>
                      <Show when={forms.unameMode === "global"}>
                        <md-outlined-button
                          disabled={pending()}
                          onClick={() =>
                            runAction(
                              () => API.restoreKasumiUnameGlobal(),
                              uiStore.L.kasumi?.restoreUnameGlobal ??
                                "Original uname restored",
                            )
                          }
                        >
                          {uiStore.L.kasumi?.restoreUnameGlobal ??
                            "Restore original"}
                        </md-outlined-button>
                      </Show>
                    </div>
                  </div>

                  <md-outlined-text-field
                    class="full-field kasumi-input-field"
                    label={uiStore.L.kasumi?.cmdlineValue ?? "Cmdline Value"}
                    value={forms.cmdline}
                    onInput={(e: Event) =>
                      setForms(
                        "cmdline",
                        (e.currentTarget as HTMLInputElement).value,
                      )
                    }
                    disabled={pending()}
                  />
                  <div class="button-row">
                    <md-filled-button
                      disabled={pending()}
                      onClick={() =>
                        runAction(
                          () => API.setKasumiCmdline(forms.cmdline),
                          uiStore.L.common?.saved ?? "Saved",
                        )
                      }
                    >
                      {uiStore.L.kasumi?.saveCmdline ?? "Save Cmdline"}
                    </md-filled-button>
                    <md-outlined-button
                      disabled={pending()}
                      onClick={() =>
                        runAction(
                          () => API.clearKasumiCmdline(),
                          uiStore.L.kasumi?.clearCmdline ?? "Cmdline cleared",
                        )
                      }
                    >
                      {uiStore.L.kasumi?.clearCmdline ?? "Clear Cmdline"}
                    </md-outlined-button>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <section
            class={`kasumi-card kasumi-section ${isSectionExpanded("user-hide") ? "expanded" : ""}`}
          >
            <button
              class="kasumi-section-toggle"
              type="button"
              aria-expanded={isSectionExpanded("user-hide") ? "true" : "false"}
              aria-controls="kasumi-section-user-hide"
              onClick={() => void handleSectionToggle("user-hide")}
            >
              <div class="kasumi-card-head kasumi-section-toggle-inner">
                <div>
                  <div class="kasumi-card-title">
                    {uiStore.L.kasumi?.userHideTitle ?? "User Hide Rules"}
                  </div>
                </div>
                <md-icon class="kasumi-section-chevron" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d={EXPAND_MORE_ICON} />
                  </svg>
                </md-icon>
              </div>
            </button>
            <div
              class="kasumi-section-body-wrapper"
              id="kasumi-section-user-hide"
            >
              <div class="kasumi-section-body-inner">
                <div class="kasumi-section-body field-stack">
                  <md-outlined-text-field
                    class="full-field kasumi-input-field"
                    label={
                      uiStore.L.kasumi?.userHidePathLabel ??
                      "Persistent Hide Path"
                    }
                    value={forms.userHidePath}
                    onInput={(e: Event) =>
                      setForms(
                        "userHidePath",
                        (e.currentTarget as HTMLInputElement).value,
                      )
                    }
                    disabled={pending()}
                  />
                  <div class="button-row">
                    <md-filled-button
                      disabled={pending()}
                      onClick={() =>
                        runAction(
                          () => {
                            const path = forms.userHidePath.trim();
                            if (!path) {
                              throw new Error(
                                uiStore.L.kasumi?.userHidePathRequired ??
                                  "Hide path cannot be empty",
                              );
                            }
                            return API.addUserHideRule(path);
                          },
                          uiStore.L.kasumi?.hideRuleAdded ?? "Hide rule added",
                          "full",
                        )
                      }
                    >
                      {uiStore.L.kasumi?.addHideRule ?? "Add Hide Rule"}
                    </md-filled-button>
                    <md-outlined-button
                      disabled={pending()}
                      onClick={() =>
                        runAction(
                          () => API.applyUserHideRules(),
                          uiStore.L.kasumi?.hideRulesApplied ??
                            "User hide rules applied",
                          "full",
                        )
                      }
                    >
                      {uiStore.L.kasumi?.applyHideRules ?? "Apply Stored Hides"}
                    </md-outlined-button>
                  </div>
                  <div class="hide-rule-list">
                    <For each={userHideRules()}>
                      {(path) => (
                        <div class="hide-rule-item">
                          <span class="hide-rule-path mono">{path}</span>
                          <button
                            class="hide-rule-remove"
                            type="button"
                            disabled={pending()}
                            onClick={() =>
                              runAction(
                                () => API.removeUserHideRule(path),
                                uiStore.L.kasumi?.hideRuleRemoved ??
                                  "Hide rule removed",
                                "full",
                              )
                            }
                          >
                            {uiStore.L.kasumi?.removeHideRule ?? "Remove"}
                          </button>
                        </div>
                      )}
                    </For>
                    <Show when={userHideRules().length === 0}>
                      <div class="empty-inline-note">
                        {uiStore.L.kasumi?.noUserHideRules ??
                          "No persistent user hide rules yet."}
                      </div>
                    </Show>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <Show when={status()?.available && mapsSpoofSupported()}>
            <section
              class={`kasumi-card kasumi-section ${isSectionExpanded("maps") ? "expanded" : ""}`}
            >
              <button
                class="kasumi-section-toggle"
                type="button"
                aria-expanded={isSectionExpanded("maps") ? "true" : "false"}
                aria-controls="kasumi-section-maps"
                onClick={() => void handleSectionToggle("maps")}
              >
                <div class="kasumi-card-head kasumi-section-toggle-inner">
                  <div>
                    <div class="kasumi-card-title">
                      {uiStore.L.kasumi?.mapsTitle ?? "Maps Spoof Rules"}
                    </div>
                  </div>
                  <div class="kasumi-section-toggle-end">
                    <div class="state-pill">
                      {config()?.maps_rules?.length ?? 0}
                    </div>
                    <md-icon class="kasumi-section-chevron" aria-hidden="true">
                      <svg viewBox="0 0 24 24">
                        <path d={EXPAND_MORE_ICON} />
                      </svg>
                    </md-icon>
                  </div>
                </div>
              </button>
              <div class="kasumi-section-body-wrapper" id="kasumi-section-maps">
                <div class="kasumi-section-body-inner">
                  <div class="kasumi-section-body field-stack">
                    <div class="meta-list">
                      <div class="meta-row">
                        <span>
                          {uiStore.L.kasumi?.mapsRuleCount ?? "Maps rules"}
                        </span>
                        <strong>{config()?.maps_rules?.length ?? 0}</strong>
                      </div>
                    </div>
                    <div class="sub-grid">
                      <md-outlined-text-field
                        class="full-field kasumi-input-field"
                        label={
                          uiStore.L.kasumi?.mapsTargetIno ?? "Target Inode"
                        }
                        value={forms.mapsTargetIno}
                        onInput={(e: Event) =>
                          setForms(
                            "mapsTargetIno",
                            (e.currentTarget as HTMLInputElement).value,
                          )
                        }
                        disabled={pending()}
                      />
                      <md-outlined-text-field
                        class="full-field kasumi-input-field"
                        label={
                          uiStore.L.kasumi?.mapsTargetDev ?? "Target Device"
                        }
                        value={forms.mapsTargetDev}
                        onInput={(e: Event) =>
                          setForms(
                            "mapsTargetDev",
                            (e.currentTarget as HTMLInputElement).value,
                          )
                        }
                        disabled={pending()}
                      />
                      <md-outlined-text-field
                        class="full-field kasumi-input-field"
                        label={
                          uiStore.L.kasumi?.mapsSpoofedIno ?? "Spoofed Inode"
                        }
                        value={forms.mapsSpoofedIno}
                        onInput={(e: Event) =>
                          setForms(
                            "mapsSpoofedIno",
                            (e.currentTarget as HTMLInputElement).value,
                          )
                        }
                        disabled={pending()}
                      />
                      <md-outlined-text-field
                        class="full-field kasumi-input-field"
                        label={
                          uiStore.L.kasumi?.mapsSpoofedDev ?? "Spoofed Device"
                        }
                        value={forms.mapsSpoofedDev}
                        onInput={(e: Event) =>
                          setForms(
                            "mapsSpoofedDev",
                            (e.currentTarget as HTMLInputElement).value,
                          )
                        }
                        disabled={pending()}
                      />
                    </div>
                    <md-outlined-text-field
                      class="full-field kasumi-input-field"
                      label={
                        uiStore.L.kasumi?.mapsSpoofedPath ?? "Spoofed Path"
                      }
                      value={forms.mapsPath}
                      onInput={(e: Event) =>
                        setForms(
                          "mapsPath",
                          (e.currentTarget as HTMLInputElement).value,
                        )
                      }
                      disabled={pending()}
                    />
                    <div class="button-row">
                      <md-filled-button
                        disabled={pending()}
                        onClick={() =>
                          runAction(() => {
                            const spoofedPath = forms.mapsPath.trim();
                            if (!spoofedPath) {
                              throw new Error(
                                uiStore.L.kasumi?.mapsPathRequired ??
                                  "Spoofed path cannot be empty",
                              );
                            }
                            return API.addKasumiMapsRule({
                              target_ino: parseUnsignedInput(
                                forms.mapsTargetIno,
                                "target inode",
                              ),
                              target_dev: parseUnsignedInput(
                                forms.mapsTargetDev,
                                "target device",
                              ),
                              spoofed_ino: parseUnsignedInput(
                                forms.mapsSpoofedIno,
                                "spoofed inode",
                              ),
                              spoofed_dev: parseUnsignedInput(
                                forms.mapsSpoofedDev,
                                "spoofed device",
                              ),
                              spoofed_pathname: spoofedPath,
                            });
                          }, uiStore.L.kasumi?.mapsRuleAdded ?? "Maps spoof rule added")
                        }
                      >
                        {uiStore.L.kasumi?.mapsAddRule ?? "Add Maps Rule"}
                      </md-filled-button>
                      <md-outlined-button
                        disabled={pending()}
                        onClick={() =>
                          runAction(
                            () => API.clearKasumiMapsRules(),
                            uiStore.L.kasumi?.mapsCleared ??
                              "Maps rules cleared",
                          )
                        }
                      >
                        {uiStore.L.kasumi?.mapsClear ?? "Clear Maps Rules"}
                      </md-outlined-button>
                    </div>
                    <div class="hide-rule-list">
                      <For each={config()?.maps_rules || []}>
                        {(rule) => (
                          <div class="hide-rule-item">
                            <div class="hide-rule-path">
                              <div class="mono">{rule.spoofed_pathname}</div>
                              <div class="secondary-inline mono">
                                {(
                                  uiStore.L.kasumi?.mapsRuleSummary ??
                                  "target {target} -> spoof {spoofed}"
                                )
                                  .replace(
                                    "{target}",
                                    `${rule.target_ino}:${rule.target_dev}`,
                                  )
                                  .replace(
                                    "{spoofed}",
                                    `${rule.spoofed_ino}:${rule.spoofed_dev}`,
                                  )}
                              </div>
                            </div>
                          </div>
                        )}
                      </For>
                      <Show when={(config()?.maps_rules?.length || 0) === 0}>
                        <div class="empty-inline-note">
                          {uiStore.L.kasumi?.mapsEmpty ??
                            "No maps spoof rules configured."}
                        </div>
                      </Show>
                    </div>
                  </div>
                </div>
              </div>
            </section>
          </Show>

          <section
            class={`kasumi-card kasumi-section ${isSectionExpanded("features") ? "expanded" : ""}`}
          >
            <button
              class="kasumi-section-toggle"
              type="button"
              aria-expanded={isSectionExpanded("features") ? "true" : "false"}
              aria-controls="kasumi-section-features"
              onClick={() => void handleSectionToggle("features")}
            >
              <div class="kasumi-card-head kasumi-section-toggle-inner">
                <div>
                  <div class="kasumi-card-title">
                    {uiStore.L.kasumi?.featuresTitle ?? "Capabilities"}
                  </div>
                </div>
                <md-icon class="kasumi-section-chevron" aria-hidden="true">
                  <svg viewBox="0 0 24 24">
                    <path d={EXPAND_MORE_ICON} />
                  </svg>
                </md-icon>
              </div>
            </button>
            <div
              class="kasumi-section-body-wrapper"
              id="kasumi-section-features"
            >
              <div class="kasumi-section-body-inner">
                <div class="kasumi-section-body">
                  <Show
                    when={!loading()}
                    fallback={<Skeleton variant="feature-card" />}
                  >
                    <div class="meta-list">
                      <div class="meta-row">
                        <span>
                          {uiStore.L.kasumi?.featureBits ?? "Feature bits"}
                        </span>
                        <strong>{status()?.feature_bits ?? 0}</strong>
                      </div>
                      <div class="meta-row">
                        <span>
                          {uiStore.L.kasumi?.hideUidCount ?? "Hide UIDs"}
                        </span>
                        <strong>{config()?.hide_uids?.length ?? 0}</strong>
                      </div>
                      <div class="meta-row">
                        <span>
                          {uiStore.L.kasumi?.userHideCount ?? "User hide rules"}
                        </span>
                        <strong>{status()?.user_hide_rule_count ?? 0}</strong>
                      </div>
                      <div class="meta-row">
                        <span>
                          {uiStore.L.kasumi?.mapsRuleCount ?? "Maps rules"}
                        </span>
                        <strong>{config()?.maps_rules?.length ?? 0}</strong>
                      </div>
                      <div class="meta-row">
                        <span>
                          {uiStore.L.kasumi?.kstatRuleCount ?? "Kstat rules"}
                        </span>
                        <strong>{config()?.kstat_rules?.length ?? 0}</strong>
                      </div>
                    </div>
                    <div class="chip-section">
                      <For each={status()?.feature_names || []}>
                        {(name) => <span class="feature-chip">{name}</span>}
                      </For>
                    </div>
                    <div class="chip-section subdued">
                      <For each={status()?.hooks || []}>
                        {(name) => (
                          <span class="feature-chip hook">{name}</span>
                        )}
                      </For>
                    </div>
                    <div class="chip-section">
                      <For each={activeModules()}>
                        {(name) => (
                          <span class="feature-chip active-module">{name}</span>
                        )}
                      </For>
                    </div>
                  </Show>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>

      <BottomActions>
        <md-filled-tonal-icon-button
          disabled={pending()}
          onClick={() => load("full")}
          title={uiStore.L.kasumi?.refresh ?? "Refresh"}
        >
          <md-icon>
            <svg viewBox="0 0 24 24">
              <path d={ICONS.refresh} />
            </svg>
          </md-icon>
        </md-filled-tonal-icon-button>
        <div class="spacer"></div>

        <md-filled-button
          disabled={pending()}
          onClick={() =>
            runAction(
              () => API.clearKasumiRules(),
              uiStore.L.kasumi?.clearRules ?? "Rules cleared",
            )
          }
        >
          <md-icon slot="icon">
            <svg viewBox="0 0 24 24">
              <path d={ICONS.delete} />
            </svg>
          </md-icon>
          {uiStore.L.kasumi?.clearRules ?? "Clear Rules"}
        </md-filled-button>
      </BottomActions>
    </>
  );
}
