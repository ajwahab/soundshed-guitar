import { setAppSetting, postMessage } from "./bridge.js";
import { showNotification } from "./notifications.js";
import { applyPresetFromLibrary, assignPresetToActiveSetlistSlot, openPresetChooserForSelection } from "./presets.js";
import { clonePreset, getActivePresetForRender, uiState } from "./state.js";
import { EffectTypeRegistry } from "./presetV2.js";
import type { AppSettingValue, GraphNode, Preset, Setlist } from "./types.js";
import { escapeHtml } from "./utils.js";
import {
  applySignalPathNodeBypassState,
  isNodeBypassed,
  isToggleableSignalPathNode,
  renderSignalPathBar,
} from "./signalPath.js";

type PerformancePadMode = "setlist" | "effects";
type PerformancePadCount = 6 | 8 | 10;

interface PerformancePadAssignment {
  padIndex: number;
  nodeId: string;
  effectType: string;
  label: string;
}

type PerformancePadAssignments = Record<string, PerformancePadAssignment[]>;

const SETTINGS = {
  mode: "performancePads.mode",
  padCount: "performancePads.padCount",
  assignments: "performancePads.assignments",
} as const;

const VALID_PAD_COUNTS: PerformancePadCount[] = [6, 8, 10];

let rootElement: HTMLElement | null = null;
let mode: PerformancePadMode = "setlist";
let padCount: PerformancePadCount = 8;
let assignments: PerformancePadAssignments = {};
let draftPadIndex = 0;
let draftEffectType = "";
let draftNodeId = "";
let assigningSetlistSlotIndex: number | null = null;

function isPerformancePadMode(value: unknown): value is PerformancePadMode {
  return value === "setlist" || value === "effects";
}

function normalizePadCount(value: unknown): PerformancePadCount {
  return VALID_PAD_COUNTS.includes(value as PerformancePadCount) ? value as PerformancePadCount : 8;
}

function normalizeAssignments(value: unknown): PerformancePadAssignments {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const next: PerformancePadAssignments = {};
  Object.entries(value as Record<string, unknown>).forEach(([presetId, entries]) => {
    if (!Array.isArray(entries)) {
      return;
    }
    const normalized = entries
      .map((entry): PerformancePadAssignment | null => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const raw = entry as Record<string, unknown>;
        const rawPadIndex = raw.padIndex;
        const nodeId = typeof raw.nodeId === "string" ? raw.nodeId.trim() : "";
        const effectType = typeof raw.effectType === "string" ? raw.effectType.trim() : "";
        const label = typeof raw.label === "string" ? raw.label.trim() : "";
        if (typeof rawPadIndex !== "number" || !Number.isInteger(rawPadIndex) || rawPadIndex < 0 || !nodeId) {
          return null;
        }
        return {
          padIndex: rawPadIndex,
          nodeId,
          effectType,
          label,
        };
      })
      .filter((entry): entry is PerformancePadAssignment => Boolean(entry));
    if (normalized.length) {
      next[presetId] = normalized;
    }
  });
  return next;
}

function writeSetting(key: string, value: AppSettingValue): void {
  uiState.appSettings = {
    ...uiState.appSettings,
    [key]: value,
  };
  setAppSetting(key, value);
}

function persistMode(): void {
  writeSetting(SETTINGS.mode, mode);
}

function persistPadCount(): void {
  writeSetting(SETTINGS.padCount, padCount);
}

function persistAssignments(): void {
  writeSetting(SETTINGS.assignments, assignments as unknown as AppSettingValue);
}

function getActiveSetlist(): Setlist | null {
  const activeId = uiState.activeSetlistId;
  const setlists = uiState.setlists ?? [];
  return setlists.find((setlist) => setlist.id === activeId) ?? setlists[0] ?? null;
}

function findPresetName(presetId: string): string {
  return uiState.presetCache.get(presetId)?.name
    ?? uiState.presets.find((preset) => preset.id === presetId)?.name
    ?? presetId;
}

function getSetlistBankLabel(setlist: Setlist | null): string {
  if (!setlist) {
    return "No bank";
  }
  return typeof setlist.bank === "number" ? `Bank ${setlist.bank}` : "Unassigned bank";
}

function setMode(nextMode: PerformancePadMode): void {
  if (mode === nextMode) {
    return;
  }
  mode = nextMode;
  persistMode();
  renderPerformancePads();
}

function setPadCount(nextCount: PerformancePadCount): void {
  if (padCount === nextCount) {
    return;
  }
  padCount = nextCount;
  if (draftPadIndex >= padCount) {
    draftPadIndex = 0;
  }
  persistPadCount();
  renderPerformancePads();
}

function setActiveSetlist(setlist: Setlist): void {
  uiState.activeSetlistId = setlist.id;
  uiState.setlistCursorIndex = 0;
  postMessage({
    type: "setSetlists",
    setlists: uiState.setlists ?? [],
    activeSetlistId: setlist.id,
    cursorIndex: 0,
  });
  renderPerformancePads();
}

function changeSetlistBank(delta: number): void {
  const setlists = uiState.setlists ?? [];
  if (!setlists.length) {
    showNotification("No setlists", "Create a setlist before using bank controls.");
    return;
  }

  const active = getActiveSetlist();
  const currentIndex = Math.max(0, setlists.findIndex((setlist) => setlist.id === active?.id));
  const nextIndex = Math.max(0, Math.min(setlists.length - 1, currentIndex + delta));
  if (nextIndex === currentIndex) {
    showNotification(delta > 0 ? "Last bank" : "First bank");
    return;
  }
  setActiveSetlist(setlists[nextIndex]);
}

function selectSetlistSlot(index: number): void {
  const setlist = getActiveSetlist();
  if (!setlist) {
    showNotification("No setlist selected", "Create or select a setlist first.");
    return;
  }
  if (index < 0 || index >= setlist.slots.length) {
    showNotification("Empty path", "Assign a preset to this setlist slot first.");
    return;
  }
  const presetId = setlist.slots[index]?.presetId ?? "";
  if (!presetId) {
    showNotification("Empty path", "Assign a preset to this setlist slot first.");
    return;
  }

  uiState.setlistCursorIndex = index;
  postMessage({ type: "setSetlistCursor", cursorIndex: index });
  renderPerformancePads();
  void applyPresetFromLibrary(presetId).then(() => renderPerformancePads());
}

function assignSetlistSlot(index: number): void {
  const setlist = getActiveSetlist();
  if (!setlist) {
    showNotification("No setlist selected", "Create or select a setlist first.");
    return;
  }
  assigningSetlistSlotIndex = index;
  assigningSetlistSlotIndex = index;
  showNotification("Assign path", `Choose a preset for pad ${index + 1}.`);
  renderPerformancePads();
  openPresetChooserForSelection(
    async (presetId) => {
      const assigned = assignPresetToActiveSetlistSlot(index, presetId);
      if (!assigned) {
        showNotification("Assign failed", "Could not update the active setlist slot.");
        return;
      }
      showNotification("Path assigned", `Pad ${index + 1}: ${findPresetName(presetId)}`);
      renderPerformancePads();
    },
    () => {
      assigningSetlistSlotIndex = null;
      renderPerformancePads();
    },
  );
}

function getPresetAssignments(presetId: string): PerformancePadAssignment[] {
  return assignments[presetId] ?? [];
}

function setPresetAssignments(presetId: string, nextAssignments: PerformancePadAssignment[]): void {
  assignments = {
    ...assignments,
    [presetId]: nextAssignments.sort((left, right) => left.padIndex - right.padIndex),
  };
  persistAssignments();
}

function getNodeEffectType(node: GraphNode): string {
  return EffectTypeRegistry.resolve(node.type);
}

function getNodeTypeLabel(node: GraphNode): string {
  const typeInfo = EffectTypeRegistry.get(node.type);
  return typeInfo?.displayName || node.displayName || node.type;
}

function getNodeLabel(node: GraphNode): string {
  const typeLabel = getNodeTypeLabel(node);
  if (node.displayName && node.displayName !== typeLabel) {
    return `${node.displayName} · ${typeLabel}`;
  }
  return typeLabel;
}

function getAssignableNodes(preset: Preset | null): GraphNode[] {
  return (preset?.graph?.nodes ?? []).filter((node) => isToggleableSignalPathNode(node));
}

function getAssignmentForPad(presetId: string, padIndex: number): PerformancePadAssignment | null {
  return getPresetAssignments(presetId).find((assignment) => assignment.padIndex === padIndex) ?? null;
}

function getAssignedNode(preset: Preset, assignment: PerformancePadAssignment): GraphNode | null {
  return preset.graph?.nodes.find((node) => node.id === assignment.nodeId) ?? null;
}

function toggleEffectPad(padIndex: number): void {
  const preset = getActivePresetForRender();
  if (!preset?.id) {
    showNotification("No active preset", "Load a preset before using effect pads.");
    return;
  }
  const assignment = getAssignmentForPad(preset.id, padIndex);
  if (!assignment) {
    draftPadIndex = padIndex;
    showNotification("Pad is unassigned", "Choose an effect below and press Assign.");
    renderPerformancePads();
    return;
  }

  const node = getAssignedNode(preset, assignment);
  if (!node) {
    showNotification("Assigned effect missing", "Reassign this pad to a node in the current chain.");
    renderPerformancePads();
    return;
  }

  applySignalPathNodeBypassState(node, preset, !isNodeBypassed(node));
  renderPerformancePads();
}

function assignDraftPad(): void {
  const preset = getActivePresetForRender();
  if (!preset?.id) {
    showNotification("No active preset", "Load a preset before assigning effect pads.");
    return;
  }
  const nodes = getAssignableNodes(preset);
  const node = nodes.find((candidate) => candidate.id === draftNodeId)
    ?? nodes.find((candidate) => getNodeEffectType(candidate) === draftEffectType)
    ?? nodes[0]
    ?? null;
  if (!node) {
    showNotification("No assignable effects", "Add a toggleable effect to the signal chain first.");
    return;
  }

  const nextAssignment: PerformancePadAssignment = {
    padIndex: draftPadIndex,
    nodeId: node.id,
    effectType: getNodeEffectType(node),
    label: getNodeLabel(node),
  };
  const next = getPresetAssignments(preset.id)
    .filter((assignment) => assignment.padIndex !== draftPadIndex);
  next.push(nextAssignment);
  setPresetAssignments(preset.id, next);
  showNotification("Pad assigned", `Pad ${draftPadIndex + 1}: ${nextAssignment.label}`);
  renderPerformancePads();
}

function clearDraftPad(): void {
  const preset = getActivePresetForRender();
  if (!preset?.id) {
    return;
  }
  const next = getPresetAssignments(preset.id)
    .filter((assignment) => assignment.padIndex !== draftPadIndex);
  setPresetAssignments(preset.id, next);
  renderPerformancePads();
}

function renderModeButton(nextMode: PerformancePadMode, label: string): string {
  const active = mode === nextMode;
  return `
    <button
      class="performance-mode-btn${active ? " is-active" : ""}"
      type="button"
      data-performance-action="mode"
      data-mode="${nextMode}"
      aria-pressed="${active}"
    >${label}</button>
  `;
}

function renderHeader(): string {
  return `
    <header class="performance-pad-header">
      <div class="performance-pad-controls" aria-label="Performance pad controls">
        <div class="performance-mode-switch" role="group" aria-label="Pad mode">
          ${renderModeButton("setlist", "Setlist")}
          ${renderModeButton("effects", "Effects")}
        </div>
        <label class="performance-pad-count">
          <span>Pads</span>
          <select id="performance-pad-count-select" class="themed-select">
            ${VALID_PAD_COUNTS.map((count) => `<option value="${count}"${count === padCount ? " selected" : ""}>${count}</option>`).join("")}
          </select>
        </label>
      </div>
    </header>
  `;
}

function renderSetlistMode(): string {
  const setlist = getActiveSetlist();
  const setlists = uiState.setlists ?? [];
  const activeIndex = setlist ? setlists.findIndex((candidate) => candidate.id === setlist.id) : -1;
  const activeCursor = uiState.setlistCursorIndex ?? 0;
  const slots = setlist?.slots ?? [];
  const visibleSlots = Array.from({ length: padCount }, (_, padIndex) => {
    const slot = slots[padIndex] ?? null;
    const presetName = slot?.presetId ? findPresetName(slot.presetId) : "";
    const active = padIndex === activeCursor;
    const disabled = !slot?.presetId;
    return `
      <div class="performance-setlist-pad-wrap${assigningSetlistSlotIndex === padIndex ? " is-assigning" : ""}">
        <button
          class="performance-pad performance-setlist-pad${active ? " is-active" : ""}${disabled ? " is-empty" : ""}"
          type="button"
          data-performance-action="setlist-slot"
          data-slot-index="${padIndex}"
          aria-pressed="${active}"
          ${disabled ? "aria-disabled=\"true\"" : ""}
        >
          <span class="performance-pad-number">${padIndex + 1}</span>
          <span class="performance-pad-main">${disabled ? "Empty Path" : escapeHtml(presetName)}</span>
          <span class="performance-pad-sub">${active ? "Current" : disabled ? "Assign in setlist" : "Tap to load"}</span>
        </button>
        <button
          class="performance-pad-assign-btn"
          type="button"
          data-performance-action="assign-setlist-slot"
          data-slot-index="${padIndex}"
          aria-label="Assign preset to pad ${padIndex + 1}"
          title="Assign preset"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>
    `;
  }).join("");

  return `
    <section class="performance-pad-mode performance-pad-mode-setlist" aria-label="Setlist performance pads">
      <div class="performance-bank-strip">
        <button class="performance-bank-btn" type="button" data-performance-action="bank-down" ${activeIndex <= 0 ? "disabled" : ""}>
          <span>Bank -</span>
          <small>${activeIndex > 0 ? escapeHtml(setlists[activeIndex - 1]?.name ?? "") : "First"}</small>
        </button>
        <div class="performance-bank-current">
          <span>${escapeHtml(getSetlistBankLabel(setlist))}</span>
          <strong>${escapeHtml(setlist?.name ?? "No setlist selected")}</strong>
          <small>${slots.length ? `${Math.min(padCount, slots.length)} of ${slots.length} paths visible` : "No paths assigned"}</small>
        </div>
        <button class="performance-bank-btn" type="button" data-performance-action="bank-up" ${activeIndex < 0 || activeIndex >= setlists.length - 1 ? "disabled" : ""}>
          <span>Bank +</span>
          <small>${activeIndex >= 0 && activeIndex < setlists.length - 1 ? escapeHtml(setlists[activeIndex + 1]?.name ?? "") : "Last"}</small>
        </button>
      </div>
      ${setlist ? `<div class="performance-pad-grid performance-pad-grid-${padCount}">${visibleSlots}</div>` : `
        <div class="performance-pad-empty">
          <strong>No setlist selected</strong>
          <span>Create a setlist in the preset library, then return here for live path selection.</span>
        </div>
      `}
    </section>
  `;
}

function ensureDraftSelection(preset: Preset | null): void {
  const nodes = getAssignableNodes(preset);
  if (!nodes.length) {
    draftEffectType = "";
    draftNodeId = "";
    return;
  }

  const hasType = nodes.some((node) => getNodeEffectType(node) === draftEffectType);
  if (!hasType) {
    draftEffectType = getNodeEffectType(nodes[0]);
  }

  const nodesForType = nodes.filter((node) => getNodeEffectType(node) === draftEffectType);
  if (!nodesForType.some((node) => node.id === draftNodeId)) {
    draftNodeId = nodesForType[0]?.id ?? nodes[0].id;
  }
}

function renderEffectAssignmentPanel(preset: Preset | null): string {
  ensureDraftSelection(preset);
  const nodes = getAssignableNodes(preset);
  const typeOptions = Array.from(new Map(nodes.map((node) => [getNodeEffectType(node), getNodeTypeLabel(node)])));
  const nodeOptions = nodes.filter((node) => !draftEffectType || getNodeEffectType(node) === draftEffectType);

  if (!preset) {
    return `
      <div class="performance-assignment-panel is-empty">
        Load a preset to assign effects to pads.
      </div>
    `;
  }

  if (!nodes.length) {
    return `
      <div class="performance-assignment-panel is-empty">
        Add a toggleable effect to the active chain before assigning pads.
      </div>
    `;
  }

  return `
    <div class="performance-assignment-panel" aria-label="Effect pad assignment">
      <label>
        <span>Pad</span>
        <select id="performance-assign-pad" class="themed-select">
          ${Array.from({ length: padCount }, (_, index) => `<option value="${index}"${index === draftPadIndex ? " selected" : ""}>Pad ${index + 1}</option>`).join("")}
        </select>
      </label>
      <label>
        <span>Effect type</span>
        <select id="performance-assign-effect-type" class="themed-select">
          ${typeOptions.map(([type, label]) => `<option value="${escapeHtml(type)}"${type === draftEffectType ? " selected" : ""}>${escapeHtml(label)}</option>`).join("")}
        </select>
      </label>
      <label>
        <span>Node</span>
        <select id="performance-assign-node" class="themed-select">
          ${nodeOptions.map((node) => `<option value="${escapeHtml(node.id)}"${node.id === draftNodeId ? " selected" : ""}>${escapeHtml(getNodeLabel(node))}</option>`).join("")}
        </select>
      </label>
      <div class="performance-assignment-actions">
        <button class="performance-assign-btn" type="button" data-performance-action="assign-effect">Assign</button>
        <button class="performance-clear-btn" type="button" data-performance-action="clear-effect">Clear Pad</button>
      </div>
    </div>
  `;
}

function renderEffectsMode(): string {
  const preset = getActivePresetForRender();
  const presetId = preset?.id ?? "";
  const presetName = preset?.name ?? "No preset loaded";
  const padHtml = Array.from({ length: padCount }, (_, padIndex) => {
    const assignment = presetId ? getAssignmentForPad(presetId, padIndex) : null;
    const node = preset && assignment ? getAssignedNode(preset, assignment) : null;
    const missing = Boolean(assignment && !node);
    const on = Boolean(node && !isNodeBypassed(node));
    const assignedLabel = node ? getNodeLabel(node) : assignment?.label || "Unassigned";
    return `
      <button
        class="performance-pad performance-effect-pad${assignment ? " is-assigned" : " is-empty"}${on ? " is-on" : " is-off"}${missing ? " is-missing" : ""}${padIndex === draftPadIndex ? " is-editing" : ""}"
        type="button"
        data-performance-action="effect-pad"
        data-pad-index="${padIndex}"
        aria-pressed="${on}"
      >
        <span class="performance-pad-number">${padIndex + 1}</span>
        <span class="performance-pad-main">${escapeHtml(assignedLabel)}</span>
        <span class="performance-pad-sub">${missing ? "Missing" : assignment ? (on ? "On" : "Off") : "Tap to assign"}</span>
      </button>
    `;
  }).join("");

  return `
    <section class="performance-pad-mode performance-pad-mode-effects" aria-label="Effect bypass pads">
      <div class="performance-effect-context">
        <span>Active preset</span>
        <strong>${escapeHtml(presetName)}</strong>
        <small>Tap assigned pads to toggle bypass. Use assignment controls for the selected pad.</small>
      </div>
      <div class="performance-pad-grid performance-pad-grid-${padCount}">${padHtml}</div>
      ${renderEffectAssignmentPanel(preset ? clonePreset(preset) : null)}
    </section>
  `;
}

function renderPerformancePads(): void {
  if (!rootElement) {
    return;
  }

  rootElement.innerHTML = `
    ${renderHeader()}
    <div class="performance-pad-body">
      ${mode === "setlist" ? renderSetlistMode() : renderEffectsMode()}
    </div>
  `;
}

function handleRootClick(event: MouseEvent): void {
  const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-performance-action]");
  if (!target || !rootElement?.contains(target)) {
    return;
  }

  const action = target.dataset.performanceAction ?? "";
  if (action === "mode") {
    const nextMode = target.dataset.mode;
    if (isPerformancePadMode(nextMode)) {
      setMode(nextMode);
    }
    return;
  }
  if (action === "bank-down") {
    changeSetlistBank(-1);
    return;
  }
  if (action === "bank-up") {
    changeSetlistBank(1);
    return;
  }
  if (action === "setlist-slot") {
    selectSetlistSlot(Number.parseInt(target.dataset.slotIndex ?? "-1", 10));
    return;
  }
  if (action === "assign-setlist-slot") {
    assignSetlistSlot(Number.parseInt(target.dataset.slotIndex ?? "-1", 10));
    return;
  }
  if (action === "effect-pad") {
    toggleEffectPad(Number.parseInt(target.dataset.padIndex ?? "-1", 10));
    return;
  }
  if (action === "assign-effect") {
    assignDraftPad();
    return;
  }
  if (action === "clear-effect") {
    clearDraftPad();
  }
}

function handleRootChange(event: Event): void {
  const target = event.target as HTMLSelectElement | null;
  if (!target || !rootElement?.contains(target)) {
    return;
  }

  if (target.id === "performance-pad-count-select") {
    setPadCount(normalizePadCount(Number.parseInt(target.value, 10)));
    return;
  }
  if (target.id === "performance-assign-pad") {
    draftPadIndex = Math.max(0, Math.min(padCount - 1, Number.parseInt(target.value, 10)));
    renderPerformancePads();
    return;
  }
  if (target.id === "performance-assign-effect-type") {
    draftEffectType = target.value;
    draftNodeId = "";
    renderPerformancePads();
    return;
  }
  if (target.id === "performance-assign-node") {
    draftNodeId = target.value;
    renderPerformancePads();
  }
}

export function applyPerformancePadAppSettings(settings = uiState.appSettings): void {
  const storedMode = settings?.[SETTINGS.mode];
  mode = isPerformancePadMode(storedMode) ? storedMode : "setlist";
  padCount = normalizePadCount(settings?.[SETTINGS.padCount]);
  assignments = normalizeAssignments(settings?.[SETTINGS.assignments]);
  if (draftPadIndex >= padCount) {
    draftPadIndex = 0;
  }
  renderPerformancePads();
}

export function refreshPerformancePads(): void {
  if (!rootElement) {
    return;
  }
  renderPerformancePads();
  renderSignalPathBar();
}

export function initializePerformancePads(): void {
  rootElement = document.getElementById("panel-performance");
  if (!rootElement || rootElement.dataset.bound === "true") {
    return;
  }

  rootElement.dataset.bound = "true";
  rootElement.addEventListener("click", handleRootClick);
  rootElement.addEventListener("change", handleRootChange);

  applyPerformancePadAppSettings();
}
