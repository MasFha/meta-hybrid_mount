import {
  createEffect,
  createRenderEffect,
  createSignal,
  createMemo,
  onMount,
  onCleanup,
  Show,
  lazy,
  For,
} from "solid-js";
import { uiStore } from "./lib/stores/uiStore";
import { configStore } from "./lib/stores/configStore";
import { sysStore } from "./lib/stores/sysStore";
import { kasumiStore } from "./lib/stores/kasumiStore";
import { API } from "./lib/api";
import { onSseStateUpdate, stopSse } from "./lib/api/core/bridge";
import TopBar from "./components/TopBar";
import NavBar from "./components/NavBar";
import Toast from "./components/Toast";

const loadStatusTab = () => import("./routes/StatusTab");
const loadConfigTab = () => import("./routes/ConfigTab");
const loadKasumiTab = () => import("./routes/KasumiTab");
const loadModulesTab = () => import("./routes/ModulesTab");
const loadInfoTab = () => import("./routes/InfoTab");

const routes = [
  { id: "status", load: loadStatusTab, component: lazy(loadStatusTab) },
  { id: "config", load: loadConfigTab, component: lazy(loadConfigTab) },
  { id: "kasumi", load: loadKasumiTab, component: lazy(loadKasumiTab) },
  { id: "modules", load: loadModulesTab, component: lazy(loadModulesTab) },
  { id: "info", load: loadInfoTab, component: lazy(loadInfoTab) },
];

export default function App() {
  const [activeTab, setActiveTab] = createSignal("status");
  const [dragOffset, setDragOffset] = createSignal(0);
  const [isDragging, setIsDragging] = createSignal(false);
  const [initialDataReady, setInitialDataReady] = createSignal(false);
  const [visitedTabs, setVisitedTabs] = createSignal(
    new Set<string>([activeTab()]),
  );

  let containerRef: HTMLDivElement | undefined;
  let containerWidth = 0;
  let touchStartX = 0;
  let touchStartY = 0;
  let ticking = false;
  let rafId: number | null = null;
  let preloadTimer: number | undefined;
  let disposed = false;

  const visibleRoutes = createMemo(() =>
    routes.filter((route) => route.id !== "kasumi" || kasumiStore.enabled),
  );
  const visibleTabs = createMemo(() => visibleRoutes().map((r) => r.id));
  const tabCount = createMemo(() => Math.max(visibleTabs().length, 1));

  const baseTranslateX = createMemo(() => {
    const index = visibleTabs().indexOf(activeTab());
    return index >= 0 ? index * -(100 / tabCount()) : 0;
  });

  createRenderEffect(() => {
    const count = tabCount();
    const translate = baseTranslateX();
    const offset = dragOffset();
    const container = containerRef;
    if (!container) return;

    container.style.setProperty("--swipe-tab-count", String(count));
    container.style.setProperty("--swipe-base-translate", `${translate}%`);
    container.style.setProperty("--swipe-drag-offset", `${offset}px`);
  });

  createEffect(() => {
    const currentTab = activeTab();
    setVisitedTabs((prev) => {
      if (prev.has(currentTab)) return prev;
      const next = new Set(prev);
      next.add(currentTab);
      return next;
    });
  });

  createEffect(() => {
    const tabs = visibleTabs();
    if (!tabs.includes(activeTab())) {
      setActiveTab(tabs.includes("config") ? "config" : tabs[0] || "status");
    }
  });

  function handleTouchStart(e: TouchEvent) {
    touchStartX = e.changedTouches[0].screenX;
    touchStartY = e.changedTouches[0].screenY;
    setIsDragging(true);
    setDragOffset(0);
    ticking = false;
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  function handleTouchMove(e: TouchEvent) {
    if (!isDragging()) return;
    const currentX = e.changedTouches[0].screenX;
    const currentY = e.changedTouches[0].screenY;
    let diffX = currentX - touchStartX;
    const diffY = currentY - touchStartY;

    if (Math.abs(diffY) > Math.abs(diffX)) return;
    if (e.cancelable) e.preventDefault();

    if (!ticking) {
      ticking = true;
      rafId = requestAnimationFrame(() => {
        ticking = false;
        rafId = null;
        if (!isDragging()) return;
        const tabs = visibleTabs();
        const currentIndex = tabs.indexOf(activeTab());
        if (
          (currentIndex === 0 && diffX > 0) ||
          (currentIndex === tabs.length - 1 && diffX < 0)
        ) {
          diffX = diffX / 3;
        }
        setDragOffset(diffX);
      });
    }
  }

  function handleTouchEnd() {
    if (!isDragging()) return;
    setIsDragging(false);
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
      ticking = false;
    }
    if (containerRef) containerWidth = containerRef.clientWidth;
    const threshold = containerWidth * 0.33 || 80;
    const tabs = visibleTabs();
    const currentIndex = tabs.indexOf(activeTab());
    let nextIndex = currentIndex;
    const currentOffset = dragOffset();

    if (currentOffset < -threshold && currentIndex < tabs.length - 1) {
      nextIndex = currentIndex + 1;
    } else if (currentOffset > threshold && currentIndex > 0) {
      nextIndex = currentIndex - 1;
    }
    if (nextIndex !== currentIndex) setActiveTab(tabs[nextIndex]);
    setDragOffset(0);
  }

  onCleanup(() => {
    disposed = true;
    stopSse();
    if (preloadTimer !== undefined) {
      window.clearTimeout(preloadTimer);
    }
  });

  function startRoutePreload() {
    const pendingRoutes = visibleRoutes().filter(
      (route) => route.id !== activeTab(),
    );
    let nextIndex = 0;

    const preloadNextRoute = () => {
      if (disposed) return;

      const nextRoute = pendingRoutes[nextIndex++];
      if (!nextRoute) return;

      void nextRoute.load();

      if (nextIndex < pendingRoutes.length) {
        preloadTimer = window.setTimeout(preloadNextRoute, 120);
      }
    };

    preloadTimer = window.setTimeout(preloadNextRoute, 250);
  }

  onMount(() => {
    void initializeApp();
  });

  async function initializeApp() {
    try {
      await uiStore.init();
      await API.wakeDaemon();
      await API.init().then((payload) => {
        sysStore.loadFromInit(payload);
        kasumiStore.loadFromInit(payload);
        configStore.loadFromInit(payload);
      });
      setInitialDataReady(true);
      startRoutePreload();
      onSseStateUpdate((state) => sysStore.handleSseUpdate(state));
      onSseStateUpdate((state) => kasumiStore.handleSseUpdate(state));
    } catch (e) {
      console.error("App initialization failed", e);
      uiStore.showToast(
        e instanceof Error ? e.message : "App initialization failed",
        "error",
      );
      setInitialDataReady(true);
      return;
    }
  }

  return (
    <div class="app-root">
      <Show
        when={uiStore.isReady && initialDataReady()}
        fallback={
          <div class="loading-container">
            <div class="spinner"></div>
            <span class="loading-text">Loading...</span>
          </div>
        }
      >
        <TopBar />
        <main
          class="main-content"
          ref={containerRef}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onTouchCancel={handleTouchEnd}
        >
          <div class="swipe-track" classList={{ "is-dragging": isDragging() }}>
            <For each={visibleRoutes()}>
              {(route) => (
                <div class="swipe-page">
                  <Show
                    when={visitedTabs().has(route.id)}
                    fallback={<div class="page-scroller" aria-hidden="true" />}
                  >
                    <div class="page-scroller">
                      <route.component />
                    </div>
                  </Show>
                </div>
              )}
            </For>
          </div>
        </main>
        <NavBar
          activeTab={activeTab()}
          onTabChange={setActiveTab}
          tabs={visibleRoutes()}
        />
      </Show>
      <Toast />
    </div>
  );
}
