/**
 * Alpine.js integration (TS layer).
 *
 * - Alpine itself is loaded via classic <script src="dist/alpine.min.js"> (cdn build)
 *   so it is available as a global before our ES modules run.
 * - We register stores and component data factories here.
 * - All complex logic stays in the rest of the TS modules; Alpine only owns declarative DOM.
 */

import { STANDARD_TAGS } from "./presetTags.js";

declare global {
  interface Window {
    Alpine?: any;
  }
}

let started = false;

export function getAlpine(): any {
  const A = (typeof window !== 'undefined' ? window.Alpine : null) || (globalThis as any).Alpine;
  if (!A) {
    console.warn('[Alpine] Alpine global not found. Did the script load?');
  }
  return A;
}

/**
 * Initialize Alpine stores for global UI state slices.
 * Call once early in bootstrap, before or right after Alpine auto-starts.
 */
export function initAlpineStores(): void {
  const Alpine = getAlpine();
  if (!Alpine || (Alpine as any).__storesInitialized) return;

  // Main UI navigation / shell state (Phase 1 target)
  Alpine.store('ui', {
    // Active main panel shown in .main-content
    mainPanel: 'visualizer',

    // Simple flags for demo / feature wiring
    jamEnabled: true,
    toneSharingEnabled: true,

    // Example reactive header bits (will grow)
    activePresetName: 'Default Preset',
    presetIsDirty: false,
    presetStatus: 'Factory',

    // Method examples - real impl can delegate to existing modules
    switchMainPanel(panel: string) {
      (Alpine.store('ui') as any).mainPanel = panel;
      try {
        const legacy = (window as any).__switchMainPanel;
        if (typeof legacy === 'function') legacy(panel);
      } catch {}
    },
  });

  // FX Selector state (for Alpine x-for conversion)
  Alpine.store('fxSelector', {
    categories: [] as Array<{ id: string; name: string; color: string; count: number; active: boolean }>,
    effects: [] as Array<any>,
    activeCategory: 'amp',
    searchFilter: '',

    selectCategory(id: string) {
      const store = Alpine.store('fxSelector') as any;
      store.activeCategory = id;
      // The TS module will listen / react to re-render or we push updates from TS
      // For now, external code (fxSelector.ts) will update the arrays
    },

    updateFromTs(categories: any[], effects: any[], activeCat: string, search: string) {
      const store = Alpine.store('fxSelector') as any;
      store.categories = categories;
      store.effects = effects;
      store.activeCategory = activeCat;
      store.searchFilter = search;
    },
  });

  // Tags for the preset library's filter bar — same standard vocabulary
  // used by every tag picker (Save Preset, Save Multi-Rig, Tone Sharing).
  Alpine.store('presetTags', {
    tags: STANDARD_TAGS.map((tag) => ({ tag, label: tag })),
    activeFilters: [] as string[],
    toggle(tag: string) {
      const s = Alpine.store('presetTags') as any;
      if (s.activeFilters.includes(tag)) {
        s.activeFilters = s.activeFilters.filter((t: string) => t !== tag);
      } else {
        s.activeFilters.push(tag);
      }
      // TODO: wire to actual preset filter logic in presets.ts
    }
  });

  (Alpine as any).__storesInitialized = true;
  console.log('[Alpine] stores initialized');
}

/**
 * Start Alpine explicitly if we want full control.
 * The CDN build with defer + modules usually auto-starts, but calling start() is safe (idempotent in practice).
 */
export function startAlpine(): void {
  if (started) return;
  const Alpine = getAlpine();
  if (!Alpine) return;

  // You can register custom magic or directives here in the future.
  // Alpine.magic('example', ...)

  try {
    Alpine.start();
    started = true;
    console.log('[Alpine] started');
  } catch (e) {
    // It may already have started automatically
    if (!(e as Error).message?.includes('already started')) {
      console.warn('[Alpine] start() note:', e);
    }
    started = true;
  }
}

/**
 * Helper for components: call Alpine.initTree(el) after you dynamically insert HTML
 * that contains x-data / x-for etc.
 */
export function initAlpineTree(el: Element | null | undefined): void {
  const Alpine = getAlpine();
  if (Alpine && el) {
    try { Alpine.initTree(el); } catch {}
  }
}

// Re-export a convenient default for modules that want `import Alpine from './alpine.js'`
export default {
  getAlpine,
  initAlpineStores,
  startAlpine,
  initAlpineTree,
};
