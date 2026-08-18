/**
 * multiPresetMixer.ts — Multi-Rig (Composite Preset) UI panel.
 *
 * Handles the "Multi-Rig" tab in the preset library popover:
 *   - Listing saved composite presets
 *   - Loading a composite preset (replaces active mixer slots)
 *   - Prompting to save the current mixer as a composite preset
 *   - Removing a composite preset
 */

import { uiState } from "./state.js";
import type { CompositePreset } from "./types.js";
import {
  saveCompositePreset,
  loadCompositePreset,
  getCompositePresetList,
  removeCompositePreset,
} from "./bridge.js";
import { escapeHtml } from "./utils.js";
import { showNotification } from "./notifications.js";
import { showConfirm } from "./dialogs.js";
import { Features, isFeatureEnabled } from "./featureFlags.js";
import { syncPresetLibraryFeatureVisibility, setSetlistPanelVisible } from "./presets.js";
import { renderSignalPathBar } from "./signalPath.js";
import { STANDARD_TAGS } from "./presetTags.js";

const multiRigSaveModal = document.getElementById("save-multi-rig-modal") as HTMLElement | null;
const multiRigNameInput = document.getElementById("multi-rig-name-input") as HTMLInputElement | null;
const multiRigDescriptionInput = document.getElementById("multi-rig-description-input") as HTMLTextAreaElement | null;

function getMultiRigTagsPickerValue(): string[] {
  const picker = document.getElementById("multi-rig-tags-picker");
  if (!picker) return [];
  return Array.from(picker.querySelectorAll<HTMLButtonElement>(".preset-tag-chip.active"))
    .map((btn) => btn.dataset.tag ?? "")
    .filter(Boolean);
}

function normalizeCompositePresetTag(tag: string): string {
  return tag.trim().toLowerCase();
}

function getAvailableCompositePresetTags(): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const preset of uiState.compositePresets ?? []) {
    for (const tag of preset.tags ?? []) {
      const normalized = normalizeCompositePresetTag(tag);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      result.push(normalized);
    }
  }

  return result.sort((left, right) => left.localeCompare(right));
}

function ensureMultiRigTagChips(tags: readonly string[]): void {
  const picker = document.getElementById("multi-rig-tags-picker");
  if (!picker) return;

  const existing = new Set(
    Array.from(picker.querySelectorAll<HTMLButtonElement>(".preset-tag-chip"))
      .map((button) => button.dataset.tag ?? "")
      .filter(Boolean),
  );

  let added = false;
  for (const tag of tags) {
    if (existing.has(tag)) continue;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "preset-tag-chip";
    chip.dataset.tag = tag;
    chip.textContent = tag;
    picker.appendChild(chip);
    added = true;
  }

  if (added) {
    bindMultiRigTagPicker();
  }
}

function setMultiRigTagsPickerValue(tags: string[]): void {
  const picker = document.getElementById("multi-rig-tags-picker");
  if (!picker) return;
  const tagSet = new Set(tags);
  picker.querySelectorAll<HTMLButtonElement>(".preset-tag-chip").forEach((btn) => {
    btn.classList.toggle("active", tagSet.has(btn.dataset.tag ?? ""));
  });
}

function bindMultiRigTagPicker(): void {
  const picker = document.getElementById("multi-rig-tags-picker");
  if (!picker) return;
  picker.querySelectorAll<HTMLButtonElement>(".preset-tag-chip").forEach((btn) => {
    if (btn.dataset.bound === "true") return;
    btn.dataset.bound = "true";
    btn.addEventListener("click", () => btn.classList.toggle("active"));
  });
}

/** The composite preset the current mixer was loaded from / last saved as, if it still exists. */
function findActiveCompositePreset(): CompositePreset | undefined {
  const id = uiState.activeCompositePresetId;
  if (!id) return undefined;
  return (uiState.compositePresets ?? []).find((cp) => cp.id === id);
}

function openSaveCompositePresetModal(): void {
  // Editing an already-saved Multi-Rig re-opens this same modal pre-filled with its
  // current name/description/tags, rather than prompting for a brand new one.
  const editing = findActiveCompositePreset();

  if (!multiRigSaveModal || !multiRigNameInput) {
    const name = (prompt("Multi-Rig name:", editing?.name ?? "") ?? "").trim();
    if (name) saveCompositePreset(name, editing?.description, editing?.tags, editing?.id);
    return;
  }

  ensureMultiRigTagChips(getAvailableCompositePresetTags());
  multiRigNameInput.value = editing?.name ?? "";
  if (multiRigDescriptionInput) {
    multiRigDescriptionInput.value = editing?.description ?? "";
  }
  setMultiRigTagsPickerValue(editing?.tags ?? []);

  const titleEl = document.getElementById("save-multi-rig-modal-title");
  if (titleEl) titleEl.textContent = editing ? "Edit Multi-Rig Mix" : "Save Multi-Rig Mix";
  const confirmBtn = document.getElementById("save-multi-rig-confirm");
  if (confirmBtn) confirmBtn.textContent = editing ? "Update Mix" : "Save Mix";

  multiRigSaveModal.style.display = "flex";
  multiRigNameInput.focus();
  multiRigNameInput.select();
}

function closeSaveCompositePresetModal(): void {
  if (!multiRigSaveModal) return;
  multiRigSaveModal.style.display = "none";
}

function submitSaveCompositePresetModal(): void {
  if (!multiRigNameInput) return;
  const name = multiRigNameInput.value.trim();
  if (!name) {
    multiRigNameInput.classList.add("input-error");
    multiRigNameInput.focus();
    return;
  }
  multiRigNameInput.classList.remove("input-error");
  const editingId = findActiveCompositePreset()?.id;
  saveCompositePreset(name, multiRigDescriptionInput?.value.trim() ?? "", getMultiRigTagsPickerValue(), editingId);
  closeSaveCompositePresetModal();
}

// ── Rendering ─────────────────────────────────────────────────────────────────

export function renderCompositePresetList(): void {
  const container = document.getElementById("composite-preset-list");
  if (!container) return;

  const presets = uiState.compositePresets ?? [];

  if (presets.length === 0) {
    container.innerHTML = `<p class="composite-preset-empty">No Multi-Rig presets saved yet.<br>Switch to the <strong>Presets</strong> tab, click <strong>+ Mixer</strong> on two or more presets, then click <strong>Save</strong> in the mixer toolbar.</p>`;
    return;
  }

  container.innerHTML = presets
    .map((cp) => buildCompositePresetChip(cp))
    .join("");

  container.querySelectorAll<HTMLElement>(".composite-preset-chip").forEach((chip) => {
    const id = chip.dataset.id ?? "";

    // The whole card is clickable to load, matching regular preset list items.
    // Deleting a Multi-Rig is done from the mixer toolbar's Delete button instead.
    chip.addEventListener("click", () => {
      loadCompositePreset(id);
    });
    chip.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        loadCompositePreset(id);
      }
    });
  });
}

function buildCompositePresetChip(cp: CompositePreset): string {
  const slotCount = cp.slots?.length ?? 0;
  const desc = cp.description ? `<p class="composite-preset-desc">${escapeHtml(cp.description)}</p>` : "";
  const tags = cp.tags?.length
    ? `<div class="composite-preset-tags">${cp.tags.map((tag) => `<span class="preset-category-badge">${escapeHtml(tag)}</span>`).join("")}</div>`
    : "";
  return `
    <article class="composite-preset-chip" data-id="${escapeHtml(cp.id)}" data-name="${escapeHtml(cp.name)}" role="button" tabindex="0" title="Load Multi-Rig &quot;${escapeHtml(cp.name)}&quot;">
      <div class="composite-preset-chip-header">
        <span class="composite-preset-name">${escapeHtml(cp.name)}</span>
        <span class="composite-preset-slot-count">${slotCount} preset${slotCount !== 1 ? "s" : ""}</span>
      </div>
      ${desc}
      ${tags}
    </article>`;
}

// ── Save modal ────────────────────────────────────────────────────────────────

/**
 * Show an inline save dialog in the Multi-Rig tab, or a simple prompt fallback.
 * Called by the "Save Multi-Rig…" button in views.ts via a custom event.
 */
export function handleSaveCompositePresetFlow(): void {
  const activeCount =
    uiState.mixer?.activePresetIds?.length ?? 0;
  if (activeCount < 2) {
    showNotification("Add at least 2 presets to the mixer before saving a Multi-Rig.", "warning");
    return;
  }
  openSaveCompositePresetModal();
}

/**
 * "Delete" toolbar button in the mixer panel — removes the Multi-Rig preset the
 * current mixer was loaded from / last saved as. No-ops if nothing is currently linked.
 */
async function handleDeleteCompositePresetFlow(): Promise<void> {
  const editing = findActiveCompositePreset();
  if (!editing) {
    showNotification("No Multi-Rig preset is loaded to delete.", "warning");
    return;
  }
  const confirmed = await showConfirm(`Delete Multi-Rig "${editing.name}"? This cannot be undone.`, "Delete Multi-Rig");
  if (!confirmed) return;
  removeCompositePreset(editing.id);
  uiState.activeCompositePresetId = null;
  renderSignalPathBar();
}

// ── Message handlers ──────────────────────────────────────────────────────────

export function handleCompositePresetList(presets: CompositePreset[]): void {
  uiState.compositePresets = presets;
  ensureMultiRigTagChips(getAvailableCompositePresetTags());
  renderCompositePresetList();
  // Reveal/hide the Multi-Rig tab now that we know whether any exist.
  syncPresetLibraryFeatureVisibility();
}

export function handleCompositePresetSaved(id: string, name: string): void {
  uiState.activeCompositePresetId = id;
  showNotification(`Multi-Rig "${name}" saved.`, "success");
  getCompositePresetList();
  renderSignalPathBar(); // refresh mixer toolbar (Delete becomes available)
}

export function handleCompositePresetLoaded(id: string, name: string): void {
  uiState.activeCompositePresetId = id;
  showNotification(`Multi-Rig "${name}" loaded.`, "success");
}

// ── Tab switching ─────────────────────────────────────────────────────────────

export function initMultiRigTab(): void {
  const presetsTab = document.getElementById("preset-lib-tab-presets");
  const multiRigTab = document.getElementById("preset-lib-tab-multi-rig");
  const presetsPanel = document.getElementById("preset-library-presets-panel");
  const multiRigPanel = document.getElementById("preset-library-multi-rig-panel");

  if (!presetsTab || !multiRigTab || !presetsPanel || !multiRigPanel) return;

  // Fetch composite presets up front (not just on first tab click / save) so
  // the Multi-Rig tab can appear as soon as the popover opens, for anyone who
  // already has saved Multi-Rig presets from a previous session.
  if (isFeatureEnabled(Features.MultiRig)) {
    getCompositePresetList();
  }

  // Seed the tags picker with the standard vocabulary shared across every
  // tag picker in the app; any additional tags already used on saved
  // Multi-Rigs get appended on top by ensureMultiRigTagChips() elsewhere.
  ensureMultiRigTagChips(STANDARD_TAGS);

  presetsTab.addEventListener("click", () => {
    presetsTab.classList.add("active");
    multiRigTab.classList.remove("active");
    presetsPanel.hidden = false;
    multiRigPanel.hidden = true;
    setSetlistPanelVisible(true);
  });

  multiRigTab.addEventListener("click", () => {
    if (!isFeatureEnabled(Features.MultiRig)) {
      presetsTab.click();
      return;
    }

    multiRigTab.classList.add("active");
    presetsTab.classList.remove("active");
    presetsPanel.hidden = true;
    multiRigPanel.hidden = false;
    setSetlistPanelVisible(false);
    // Refresh list on open
    getCompositePresetList();
  });

  // "Save" toolbar button in the mixer panel fires a custom event
  document.addEventListener("mixerSaveMultiRig", () => {
    if (!isFeatureEnabled(Features.MultiRig)) {
      return;
    }

    // Switch to Multi-Rig tab so the save form is visible
    multiRigTab.click();
    handleSaveCompositePresetFlow();
  });

  // "Delete" toolbar button in the mixer panel fires a custom event
  document.addEventListener("mixerDeleteMultiRig", () => {
    if (!isFeatureEnabled(Features.MultiRig)) {
      return;
    }
    void handleDeleteCompositePresetFlow();
  });

  document.getElementById("save-multi-rig-modal-close")?.addEventListener("click", closeSaveCompositePresetModal);
  document.getElementById("save-multi-rig-cancel")?.addEventListener("click", closeSaveCompositePresetModal);
  document.getElementById("save-multi-rig-confirm")?.addEventListener("click", submitSaveCompositePresetModal);
  bindMultiRigTagPicker();
  multiRigNameInput?.addEventListener("input", () => multiRigNameInput.classList.remove("input-error"));
  multiRigNameInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitSaveCompositePresetModal();
    } else if (event.key === "Escape") {
      closeSaveCompositePresetModal();
    }
  });
  multiRigDescriptionInput?.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
      event.preventDefault();
      submitSaveCompositePresetModal();
    }
  });
  multiRigSaveModal?.addEventListener("mousedown", (event) => {
    if (event.target === multiRigSaveModal) {
      closeSaveCompositePresetModal();
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
