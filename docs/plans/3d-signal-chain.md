# 3D Signal Chain Visualization Plan

> **Status: DISABLED (2026-08-13).** The 3D stage is switched off in the product.
> Effect visualisation is served by the standard controls and custom layouts, and
> users choose between them from the effect header (see `core/ui/ts/layoutPicker.ts`
> and `core/ui/ts/layoutPreferences.ts`). The scene code under `core/ui/ts/amp3d/`
> is retained and still builds, but nothing reaches it: `CHAIN_3D_VIEW_ENABLED` in
> `core/ui/ts/signalPath.ts` is `false`, so the toggle button is not rendered and the
> dynamic `import("./amp3d/index.js")` never runs. Flip that flag to revive the
> experiment. The rest of this document is the original (now historical) plan.

Status: implemented (v1 + photo amp restore + photo 12U racks). Extends the existing Neural Amp 3D view into a full signal-chain stage. Amp/cab units reuse full AmpScene materials (tolex photo, grille cloth, panel hardware) in embed mode; chain stage owns studio lighting/PMREM. Generic effects use fixed **12U** photo-quality 19\" rack chassis: signal-order FX fill **top → bottom**, empty U spaces are blank plates; consecutive rack FX share one chassis (overflow starts a new tower). Splitter/mixer/analyzer/I/O are graph-only (no 3D stand-in). Dual-cab clusters reserve wide X clearance so neighbouring racks do not collide.

## Goal

When 3D effect mode is on, the visualization panel shows a **single persistent 3D scene** of the whole signal chain—not only the selected Neural Amp. Selecting a 2D signal-path node animates the camera to that unit. Every effect has a 3D stand-in; amps/cabs use the existing rig assets; Neural FX uses a **generic pedal** with model chooser; everything else defaults to a generic rack unit with knobs driven by real parameters. Parallel splits get separate spatial lanes.

## Decisions (locked)

| Topic | Decision |
|---|---|
| Neural FX (`fx_nam` / `kFxNam`) | Generic **pedal** unit + **model chooser** in the dock (same resource-picker pattern as amp model chooser) |
| Other pedals / drive / most FX | Generic **rack** in v1 unless a specific override exists |
| Setting key | Migrate `ui.neuralAmp3dView.enabled` → **`ui.signalChain3d.enabled`** with read-fallback + one-time write migration |
| Toggle copy | “3D chain” / “Show 3D signal chain” (not “3D amp”) |
| Mode scope | Global preference; once on, applies to the **whole chain** |
| Engine/DSP | No C++ changes in v1 |

### Setting migration

```ts
// ampSupport.ts (rename conceptually to chain3dSupport)
export const SIGNAL_CHAIN_3D_SETTING = "ui.signalChain3d.enabled";
const LEGACY_NEURAL_AMP_3D_SETTING = "ui.neuralAmp3dView.enabled";

export function isSignalChain3dEnabled(): boolean {
  const settings = uiState.appSettings ?? {};
  if (SIGNAL_CHAIN_3D_SETTING in settings) {
    return settings[SIGNAL_CHAIN_3D_SETTING] === true;
  }
  // Legacy fallback until migrated
  return settings[LEGACY_NEURAL_AMP_3D_SETTING] === true;
}

export function setSignalChain3dEnabled(enabled: boolean): void {
  uiState.appSettings[SIGNAL_CHAIN_3D_SETTING] = enabled;
  setAppSetting(SIGNAL_CHAIN_3D_SETTING, enabled);
  // Optional: clear or stop writing the legacy key after first write
}
```

On first read of legacy-only true/false, persist the new key so subsequent sessions do not depend on the old name. Keep reading the legacy key as fallback for one release cycle.

## Assumptions

1. **Interaction model**: Primary editing stays on the selected unit (knobs + bypass on that model). Orbit/pan/zoom remain scene-level. Non-selected units are visible but dimmed/less interactive.
2. **Performance**: Keep on-demand rendering (dirty-flag frames). Prefer instanced/shared glTF clones + material slots over per-node unique meshes.
3. **Custom layouts**: Nodes with positioned custom layouts keep 2D layout controls in the dock; 3D still shows a generic/special unit in the chain for navigation context.
4. **Blend NAM**: `amp_nam_blend` stays on standard/amp-head path only when not in blend-special UI conflict; if blend indicators block amp head, fall back to rack until blend has a dedicated unit. (Current code excludes blend from 3D—revisit in Phase 2.)
5. **No engine/DSP changes** in v1—pure UI/scene work over existing graph + param messages.

## Current state (baseline)

| Area | Today |
|---|---|
| Entry | Dynamic `import("./amp3d")` from `signalPath.ts`; three.js not in initial bundle |
| Capability | `AMP3D_SUPPORTED_TYPES` = NAM amp / optimized / blend only; **`fx_nam` excluded** |
| Setting | `ui.neuralAmp3dView.enabled` via `ampSupport.ts` |
| Scene | One `AmpScene`: head + optional single cabinet; knobs from continuous params |
| Cabinet rule | `nodeUsesFullRigNamCategory(node)` on the **selected** NAM node |
| Camera | Orbit around single rig; immersive shell via `body.amp3d-immersive` |
| Models | `amp-head`, `amp-cabinet`, `amp-knob`, `amp-switch`, `amp-led`, `amp-jack` |
| Chain UI | 2D bar already understands splitter→mixer parallel containers |

Key files: `core/ui/ts/amp3d/*`, `core/ui/ts/signalPath.ts` (amp3d bind/toggle), `core/ui/css/amp3d.css`, `core/ui/scripts/generate-amp-models.js`, `core/ui/assets/models/*`.

## Product rules

### When amp + cabinet appear

Show **amp head + cabinet stack** when **either**:

- A NAM (or equivalent amp) node in the chain is categorized as **full-rig** / gear_type implies cab, **or**
- The chain (or that parallel branch) contains a **`cab_ir`** (or simple cab) node.

Cabinet is **chain/branch scenery**, not only a property of the selected node.

### Dual IR → dual cabinets

For a `cab_ir` node with **two loaded IR resources** (slots A/B / `resources[0]` and `resources[1]` both present):

- Place **two cabinet meshes** side-by-side (or slightly angled) in that branch’s amp/cab zone.
- One IR only → one cabinet.
- Zero IRs but full-rig amp → still one cabinet (amp-implied cab).
- Full-rig amp **and** separate `cab_ir` → one head + cab count from IR slots (avoid double-stacking a second head; cab comes from IR/full-rig rule, head from amp node).

### Every effect gets a unit

| Kind | 3D representation |
|---|---|
| NAM amp head (`amp_nam`, `amp_nam_optimized`) | Existing head (+ cab rules above) |
| **Neural FX (`fx_nam` / `kFxNam`)** | **Generic pedal** + **model chooser** in dock |
| IR / simple cab | Cabinet mesh(es); no head unless amp also present on branch |
| Pedal-category / drive (non–Neural FX) | Generic **rack** in v1 (pedal form factor optional later) |
| EQ / dynamics / delay / reverb / utility | Generic **rack unit** with faceplate + knobs |
| Splitter / mixer | Small rack “patch” units or junction markers (non-parameter heavy) |
| Input / output | Stage markers / jack plates (not full racks) |
| Hosted plugin / WASM / unknown | Generic rack + label from effect name |
| Effect with **specific** assets later | Registry override (same placement API) |

### Neural FX pedal (detail)

- Register `EffectGuids.kFxNam` → `buildPedalUnit` (not amp head, not rack).
- Pedal face: effect/title label, footswitch-style bypass target, up to N continuous param knobs.
- **Model chooser** lives in the HTML dock above/beside overflow params (reuse existing node resource picker / NAM browser wiring already used for amp 3D dock models).
- Display text on pedal can mirror loaded model name (like amp LCD `displayText`).
- WASM host that acts as Neural-style FX may share the pedal builder only if product wants parity later; v1 = `kFxNam` only unless trivial to alias.

### Split chains → multi-lane stage

When the graph has splitter→…→mixer parallel regions (same structure the 2D bar already renders):

- Layout **one lane per live branch** (left-to-right or depth lanes).
- Shared pre-split chain is a single trunk; post-merge is a single trunk again.
- Each lane owns its own amp/cab zone if that branch has amp/cab.
- Camera focus on a node in a branch frames that lane (slight lateral move + dolly).

### Selection ↔ camera

- Selecting a 2D signal-path node (or clicking a 3D unit) sets selection and **animates** camera target/distance/azimuth to a per-unit anchor.
- Respect `prefers-reduced-motion`: snap instead of tween.
- Re-selecting same node: no restart of animation if already framed.
- Graph edits (add/remove/reorder/split) rebuild layout anchors; keep selection if node still exists.

## Architecture

### From single-rig view → chain stage

```text
signalPath.ts
  └─ SignalChain3dController (new)
        ├─ graph → ChainLayout (anchors, lanes, unit descriptors)
        ├─ Chain3dView (extends/replaces Amp3dView as host)
        │     ├─ shared WebGLRenderer / composer / lights / floor
        │     ├─ UnitInstance[] (one per graph node + markers)
        │     └─ CameraDirector (fit + focus tweens)
        └─ dock: selected unit’s overflow params / resource pickers
              (amp model chooser, Neural FX model chooser, advanced params)
```

**Do not** mount a separate WebGL context per node. One view, many unit roots under one scene.

### Module split (proposed)

| Module | Responsibility |
|---|---|
| `amp3d/chainTypes.ts` | `ChainUnitKind`, layout anchors, focus poses |
| `amp3d/chainLayout.ts` | Graph → ordered lanes + world positions (pure, unit-testable) |
| `amp3d/unitRegistry.ts` | type/category → builder (amp, cab, rack, pedal, junction) |
| `amp3d/units/rackUnit.ts` | Generic 1U/2U rack + generic knobs/LEDs |
| `amp3d/units/pedalUnit.ts` | **Generic stomp for Neural FX** (+ reusable for future pedals) |
| `amp3d/units/ampRigUnit.ts` | Refactor current `AmpScene` head/cab assembly into reusable unit |
| `amp3d/cameraDirector.ts` | Focus animation, framing margins, multi-lane fit |
| `amp3d/chainScene.ts` | Scene graph assembly, highlight, bypass dimming |
| `amp3d/chainView.ts` | Renderer, input routing, pick → node id |
| `amp3d/ampScene.ts` | Keep for amp materials/knobs; called by amp rig unit |
| `amp3d/ampSupport.ts` | Migrate to `SIGNAL_CHAIN_3D_SETTING`; keep legacy read fallback |
| `signalPath.ts` | Wire selection, graph diffs, param updates, toggle, immersive shell |

### Graph → layout algorithm (v1)

1. Topological walk from `input` using the same parallel discovery as `renderParallelForSplitter` (reuse logic; extract shared helper if needed).
2. Emit a list of **segments**: `trunk | parallelGroup(lanes[]) | trunk`.
3. Assign each processable node a `ChainUnitDesc`:
   - `nodeId`, `effectType`, `label`, `bypassed`, `params` snapshot, `resources`, `laneIndex`, `orderInLane`.
4. Place units on a grid:
   - X = order along chain (spacing ~ unit width + gap).
   - Z = lane offset for parallels (0 for trunk).
   - Y = 0 floor; racks sit on a virtual rack rail height; pedals and amps/cabs on floor (pedals shorter).
5. Amp/cab **cluster**: for each lane/trunk region, if amp and/or cab present, replace consecutive amp+cab node placements with a tight **rig cluster** (head on cab, dual cab if 2 IRs) while still mapping **both** node ids to pick targets (click head → amp node; click cab → cab node).

### Unit builders

Shared contract:

```ts
interface ChainUnit {
  readonly nodeId: string;
  readonly root: THREE.Group;
  setParams(params: Record<string, number>): void;
  setBypassed(bypassed: boolean): void;
  setHighlighted(active: boolean): void;
  setDisplayText?(text: string): void; // amp LCD / pedal model name
  getFocusAnchor(): { position: THREE.Vector3; fitDistance: number };
  getPickMeshes(): THREE.Object3D[];
  dispose(): void;
}
```

**Generic rack**

- New glTF (or procedural box) `rack-1u.gltf` / `rack-2u.gltf` via `generate-amp-models.js` style pipeline.
- Faceplate texture: effect title + up to N knobs from continuous params (reuse `computeKnobPlacements` / `MAX_PANEL_KNOBS` patterns; smaller face).
- Overflow params stay in HTML dock (same as amp today).
- Category tint from existing theme / category colors.

**Generic pedal (Neural FX)**

- New glTF `pedal-generic.gltf` (or procedural) in the same generate pipeline: enclosure, footswitch, small knobs, optional mini LED.
- Dock always includes **model chooser** when the selected node is `kFxNam` (and any other resource-backed pedal registered the same way).
- Continuous params → knobs on enclosure; advanced/enums → dock.

**Specific overrides (registry)**

```ts
unitRegistry.register(EffectGuids.kAmpNam, buildAmpRigUnit);
unitRegistry.register(EffectGuids.kAmpNamOptimized, buildAmpRigUnit);
unitRegistry.register(EffectGuids.kCabIr, buildCabUnit);
unitRegistry.register(EffectGuids.kFxNam, buildPedalUnit); // Neural FX
unitRegistry.setDefault(buildRackUnit);
// later: delay tank, spring reverb, drive pedals, etc.
```

### Amp/cab clustering rules (detail)

For a linear region (trunk or single lane), scan nodes:

```text
… → [pre FX] → AMP? → CAB? → [post FX] → …
```

- `AMP` present, category full-rig, no `CAB` → head + 1 cab (implied).
- `AMP` present, not full-rig, `CAB` with 1 IR → head + 1 cab.
- `AMP` present, `CAB` with 2 IRs → head + 2 cabs.
- No `AMP`, `CAB` with 1/2 IRs → cab only (1/2).
- Multiple amps on one lane (unusual): separate rigs in order; each cab pairs with nearest upstream amp unless edges say otherwise (v1: pair cab with closest preceding amp on same lane).

### Selection & messaging

- Keep using existing `updateSignalPathNodeParam` / bypass toggles from knob/switch picks on the **focused** unit.
- Pointer pick: raycast unit pick meshes → `selectNode(nodeId)` (same path as 2D bar selection) → camera director focuses.
- Signal level glow: continue feeding peak into **focused amp** unit only (optional later: per-node meters).

### Mode UX

- Toolbar toggle uses migrated **`ui.signalChain3d.enabled`**; label **“3D chain”**.
- Enabled: immersive stage always shows chain scene while a preset graph exists; node params dock overlays selected unit extras (model pickers, advanced, enums).
- Disabled: current 2D equipment images + layouts (unchanged).
- Empty graph / only I/O: empty stage with floor + subtle “add an effect” state (no crash).

## Visual / animation design

- **Focus tween**: ~280–400 ms ease-out on target + distance; optional slight azimuth bias toward unit facing.
- **Highlight**: emissive edge / slight Y lift / stronger key light on selected unit; others ~70% exposure.
- **Bypass**: power LED off + darker face (amp already does power ramp—reuse; pedal footswitch LED).
- **Lane cues**: faint floor strips or rail lines under parallel lanes.
- **Fit all**: double-click empty space or a “frame chain” control resets to full-chain framing.

## Implementation phases

### Phase 0 — Prep / extract (small PR)

- Extract pure graph walk helpers used by 2D parallel rendering into a shared module (or duplicate minimally for layout tests).
- Document dual-IR resource indexing for `cab_ir` (confirm slot 0/1 = loaded check).
- **Migrate setting** `ui.neuralAmp3dView.enabled` → `ui.signalChain3d.enabled` (legacy read fallback).
- Rename user-facing strings from “3D amp” → “3D chain” where the toggle is global.
- Add unit tests for “which nodes imply cab” and “IR slot count → cabinet count” with fixture graphs.

### Phase 1 — Chain layout + camera (no new meshes yet)

- Introduce `chainLayout.ts` + tests (linear, single split, nested split if supported, empty).
- Introduce `Chain3dView` hosting **multiple** existing amp rigs / placeholder boxes side-by-side as stand-ins.
- Wire selection → `CameraDirector.focus(nodeId)`.
- Gate behind migrated `ui.signalChain3d.enabled`.

### Phase 2 — Generic rack + Neural FX pedal + registry

- Generate `rack-1u` model + materials (metal face, rails, generic knobs).
- Generate **`pedal-generic`** model + materials.
- `unitRegistry` maps all catalog types to rack default; **`kFxNam` → pedal**.
- Amp types keep amp rig builder; cab types keep cabinet builder.
- Dock shows selected node’s non-knob controls for **any** type; **model chooser for amp NAM and Neural FX**.

### Phase 3 — Amp/cab product rules

- Implement clustering + dual cabinet for two IR slots.
- Full-rig without cab node still shows cabinet.
- Cab-only branch shows cabinet without head.
- Update structure signatures so IR load/unload rebuilds cab count.

### Phase 4 — Parallel lanes polish

- Z-offset lanes, lane floor marks, camera lateral focus.
- Collapse/expand split in 2D updates 3D layout.
- Stress: wide chains (many nodes) — auto spacing + min camera distance clamps.

### Phase 5 — Specific effect visuals (incremental)

- Optional bespoke units (e.g. delay, reverb, gate) registered one-by-one.
- Optional pedal form factor for other `category === "pedal"` types.
- Live animation flags remain off by default (`AMP3D_LIVE_ANIMATION_ENABLED`).

## Testing

| Layer | What |
|---|---|
| Unit | `chainLayout` fixtures: linear, dual cab IR, full-rig no cab, split 2-way, cab-only, reorder |
| Unit | Cabinet count helper: 0/1/2 resources |
| Unit | Setting migration: legacy key alone enables 3D; new key wins when both set |
| Unit | Registry: `kFxNam` → pedal kind; default → rack; amp → amp rig |
| Unit | Existing `amp3dLayout.test.ts` still passes |
| Manual | Toggle 3D, select along chain, Neural FX model chooser + knobs, amp knobs, bypass, theme switch, split add/collapse |
| Manual | Fresh install vs upgraded install with only legacy setting |
| Manual | WebGL fail path still shows fallback message |
| Perf | Long chain (12+ nodes) + dual cab: idle GPU quiet (on-demand frames) |

No C++/ctest required unless shared graph helpers move into core (not planned).

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| WebGL cost with many units | Shared geometries/materials; dispose on graph remove; shadow autoUpdate false; cap pixel ratio |
| Layout thrash on every param tweak | Structure signature = types/order/resources/bypass/theme/knob **keys**; param **values** update in place |
| Pick conflicts (cab vs head) | Separate pick meshes + nodeId userData |
| Nested / multi-split graphs | v1 layout supports one level deeply via recursive parallel groups; document limits |
| Immersive CSS only tuned for single amp | Generalize `amp3d-immersive` rules for chain stage height |
| `signalPath.ts` size | Keep new logic in `amp3d/`; thin adapters only in signalPath |
| Legacy setting left behind | Read fallback + write new key on toggle; document in changelog |

## Out of scope (v1)

- Editing graph topology via 3D (drag to reorder).
- Multi-preset mixer as multiple full stages.
- Real-time cable bezier physics.
- Per-effect photogrammetry assets beyond amp/cab/rack/pedal-generic.
- Pedal form factor for every pedal-category effect (only Neural FX guaranteed).
- Mobile/touch-specific redesign beyond existing pointer path.

## Success criteria

1. With 3D mode on, **every** non-I/O effect node is visible as a 3D unit in one scene.
2. Selecting a 2D node animates camera to that unit; picking a unit selects it in 2D.
3. Full-rig amp **or** IR cab ⇒ cabinet visible; two IR models ⇒ two cabinets.
4. Split graphs show distinct lane areas per branch.
5. Standard effects expose generic knobs for primary continuous params; advanced/enums remain in dock.
6. **Neural FX** renders as a **generic pedal** with working **model chooser**.
7. Preference stored as **`ui.signalChain3d.enabled`**; users with the old key keep their choice.
8. No regression: disable 3D → previous 2D shell; NAM amp quality remains when focused.

## Remaining open questions

1. Should 3D mode include **global** pre/post chain nodes in the stage, or only the active preset graph?
2. Max nodes before switching to “focus neighborhood” (hide far units) — needed for huge graphs?
3. Should `amp_nam_blend` get amp-head 3D in v1 or stay 2D until blend UI is designed for 3D?

## Suggested first implementation slice

**Phase 0** (setting migration + string rename + layout helper extract) then **Phase 1** (chain layout + camera) behind `ui.signalChain3d.enabled`. Pedal/rack art lands in Phase 2 with Neural FX model chooser dock wiring.
