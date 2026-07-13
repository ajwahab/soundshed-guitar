import { uiState } from "./state.js";
import { postMessage } from "./bridge.js";
import { initSettingsPanel, updateSettingsSessionStatus, activateEquipmentTab, activateLibraryTab, activateAdvancedSubTab, setSettingsViewStateSuppressed } from "./settings.js";
import { ensureTone3000Session } from "./tone3000.js";
import { handleJamPanelActivated, initializeJamPanel } from "./jam.js";
import { initializeToneSharingPanel } from "./toneSharingPanel.js";
import type { UiViewState } from "./types.js";
import { isJamEnabled } from "./buildFlags.js";
import { Features, isFeatureEnabled, isJamExperienceEnabled } from "./featureFlags.js";

function getTabButtons() { return Array.from(document.querySelectorAll(".tab-button")); }
function getTabPanels() { return Array.from(document.querySelectorAll(".tab-panel")); }
function getPanelSwitchButtons() { return Array.from(document.querySelectorAll(".icon-bar .icon-btn, .panel-switch")); }
function getMainTabPanels() { return Array.from(document.querySelectorAll(".main-content .tab-panel")); }

let pendingSend = false;
const sendDelayMs = 200;
let applyingViewState = false;

function mergeViewState(base: UiViewState, update: UiViewState): UiViewState {
  const settings = {
    ...base.settings,
    ...update.settings,
  };
  return {
    ...base,
    ...update,
    settings,
  };
}

function updateUiViewState(update: UiViewState): void {
  const current = uiState.uiViewState ?? {};
  const next = mergeViewState(current, update);

  if (JSON.stringify(current) === JSON.stringify(next)) {
    return;
  }

  uiState.uiViewState = next;
  if (applyingViewState) {
    return;
  }
  if (pendingSend) {
    return;
  }

  pendingSend = true;
  window.setTimeout(() => {
    pendingSend = false;
    postMessage({ type: "uiViewStateChanged", viewState: uiState.uiViewState });
  }, sendDelayMs);
}

export function activateTab(tabId: string): void {
  const tabButtons = getTabButtons();
  const tabPanels = getTabPanels();
  if (!tabButtons.length || !tabPanels.length) {
    return;
  }

  tabButtons.forEach((button) => {
    const isActive = (button as HTMLElement).dataset.tab === tabId;
    button.classList.toggle("active", isActive);
  });

  tabPanels.forEach((panel) => {
    const isDetailsPanel = (panel as HTMLElement).id === "preset-details" && tabId === "details";
    const isLogPanel = (panel as HTMLElement).id === "log-panel" && tabId === "logs";
    panel.classList.toggle("active", isDetailsPanel || isLogPanel);
  });

  updateUiViewState({ presetTab: tabId });
}

export function switchMainPanel(panelId: string): void {
  // Sync to Alpine store so x-show / :class in ui-components react
  try {
    const Alpine = (window as any).Alpine;
    const uiStore = Alpine && Alpine.store && Alpine.store('ui');
    if (uiStore) {
      uiStore.mainPanel = panelId === 'library' ? 'settings' : (panelId === 'scalex' ? 'sharing' : panelId);
    }
  } catch {}
  const requestedSettingsTab = panelId === "library" ? "library" : null;
  const normalizedPanelId = panelId === "scalex"
    ? "sharing"
    : requestedSettingsTab
      ? "settings"
      : panelId;
  const effectivePanelId = (() => {
    if (normalizedPanelId === "jam" && (!isJamEnabled() || !isJamExperienceEnabled())) {
      return "visualizer";
    }
    if (normalizedPanelId === "sharing" && !isFeatureEnabled(Features.ToneSharing)) {
      return "visualizer";
    }
    return normalizedPanelId;
  })();

  const panelSwitchButtons = getPanelSwitchButtons();
  const mainTabPanels = getMainTabPanels();
  panelSwitchButtons.forEach((btn) => {
    const btnPanel = (btn as HTMLElement).dataset.panel;
    btn.classList.toggle("active", btnPanel === effectivePanelId);
  });

  mainTabPanels.forEach((panel) => {
    const isPanelMatch = (panel as HTMLElement).id === `panel-${effectivePanelId}`;
    panel.classList.toggle("active", isPanelMatch);
  });

  // Hide signal path bar for full-height panels (everything except visualizer)
  const signalPathBar = document.getElementById("signal-path-bar");
  const mainContent = document.querySelector(".main-content") as HTMLElement | null;
  const fullHeightPanels = ["jam", "settings", "sharing", "advanced", "mixer"];
  const isFullHeight = fullHeightPanels.includes(effectivePanelId);

  if (signalPathBar) {
    signalPathBar.style.display = isFullHeight ? "none" : "";
  }
  if (mainContent) {
    mainContent.classList.toggle("full-height", isFullHeight);
  }

  if (effectivePanelId === "settings") {
    initSettingsPanel();
    if (requestedSettingsTab) {
      activateEquipmentTab(requestedSettingsTab);
    }
    if (isFeatureEnabled(Features.Tone3000)) {
      void ensureTone3000Session().then(() => updateSettingsSessionStatus());
    }
  }

  if (effectivePanelId === "jam") {
    initializeJamPanel();
    handleJamPanelActivated();
  }

  if (effectivePanelId === "sharing") {
    initializeToneSharingPanel();
  }

  updateUiViewState({ mainPanel: effectivePanelId });
}

export function initializeIconBarTabs(options?: { onEq?: () => void; onMetronome?: () => void }): void {
  const panelSwitchButtons = getPanelSwitchButtons();
  panelSwitchButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const panelId = (btn as HTMLElement).dataset.panel;
      if (!panelId) {
        return;
      }
      if (panelId === "metronome") {
        if (options?.onMetronome) {
          options.onMetronome();
        }
        return;
      }
      if (panelId === "eq") {
        if (options?.onEq) {
          options.onEq();
        }
        return;
      }
      switchMainPanel(panelId);
    });
  });
}

export function initializeTabButtons(): void {
  const tabButtons = getTabButtons();
  tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const tabId = (button as HTMLElement).dataset.tab ?? "";
      if (tabId) {
        activateTab(tabId);
      }
    });
  });
}

export function applyUiViewState(state?: UiViewState): void {
  if (!state) {
    return;
  }
  const current = uiState.uiViewState ?? {};
  const next = mergeViewState(current, state);
  uiState.uiViewState = next;

  applyingViewState = true;
  if (next.mainPanel) {
    switchMainPanel(next.mainPanel);
  }
  if (next.presetTab) {
    activateTab(next.presetTab);
  }
  if (next.settings) {
    setSettingsViewStateSuppressed(true);
    if (next.settings.equipmentTab) {
      activateEquipmentTab(next.settings.equipmentTab);
    }
    if (next.settings.libraryTab) {
      activateLibraryTab(next.settings.libraryTab);
    }
    if (next.settings.advancedTab) {
      activateAdvancedSubTab(next.settings.advancedTab);
    }
    setSettingsViewStateSuppressed(false);
  }
  applyingViewState = false;
}

// Expose for Alpine direct calls from x-on:click handlers in header etc.
(window as any).__switchMainPanel = switchMainPanel;

const CONTROL_BAR_COLLAPSED_KEY = "guitarfx.controlBarCollapsed";

export function initControlBarCollapse(): void {
  const bar = document.querySelector<HTMLElement>(".control-bar");
  const btn = document.getElementById("control-bar-collapse-btn");
  if (!bar || !btn) return;

  const apply = (collapsed: boolean) => {
    bar.classList.toggle("is-collapsed", collapsed);
    btn.setAttribute("aria-expanded", collapsed ? "false" : "true");
    btn.setAttribute("aria-label", collapsed ? "Expand controls" : "Collapse controls");
    btn.title = collapsed ? "Expand controls" : "Collapse controls";
  };

  // Restore saved state
  apply(localStorage.getItem(CONTROL_BAR_COLLAPSED_KEY) === "true");

  btn.addEventListener("click", () => {
    const collapsed = !bar.classList.contains("is-collapsed");
    apply(collapsed);
    localStorage.setItem(CONTROL_BAR_COLLAPSED_KEY, String(collapsed));
  });
}
