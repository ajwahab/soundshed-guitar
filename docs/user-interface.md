# User Interface

## Key Files
- `core/ui/ts/messages.ts` — Message handlers and state application
- `core/ui/ts/state.ts` — UI state management
- `core/ui/ts/main.ts` — Application entry point
- `core/src/PluginController.cpp` — Engine-side state and message handling
- `core/src/UiBridge.h` — Native bridge interface

## Overview

The UI is a web-based single-page application (SPA) hosted in a native WebView. Communication with the plugin uses a bidirectional JSON message protocol. The UI maintains local state synchronized with the engine via events.

## Architecture

```
┌──────────────────────────────────────┐
│          Web UI (TypeScript)         │
│  ┌────────────────────────────────┐  │
│  │     View Components            │  │
│  ├────────────────────────────────┤  │
│  │     State Management           │  │
│  ├────────────────────────────────┤  │
│  │     Message Handler            │  │
│  └────────────────────────────────┘  │
└───────────────┬──────────────────────┘
                │ JSON Messages
┌───────────────▼──────────────────────┐
│          WebUI Bridge (C++)          │
│  Serialize/deserialize, dispatch     │
└───────────────┬──────────────────────┘
                │
┌───────────────▼──────────────────────┐
│       Plugin Controller (C++)        │
└──────────────────────────────────────┘
```

### WebView Host
- **Windows**: WebView2 (Chromium-based)
- **macOS**: WKWebView (WebKit-based)
- Sandboxed execution, communication only through message bridge

## Message Protocol

### Message Format
```json
{
  "type": "messageType",
  "payload": { ... },
  "timestamp": 1704801234567
}
```

### Engine → UI Messages

| Type | Payload | Description |
|------|---------|-------------|
| `state` | Full state object | Complete sync on startup/major changes |
| `presetLoaded` | `{preset, sceneId, activePresetIds, parameters}` | Preset load notification |
| `presetSaved` | `{preset, sceneId}` | Preset saved to disk confirmation |
| `presetList` | `{presets: [{id, name, category, source}]}` | Factory/user presets from disk |
| `error` | `{message, detail}` | Error notification |
| `signalPathTestResult` | `{frequency, duration, elapsed, ...}` | Signal test completed |
| `previewStarted` | `{id, title}` | Demo audio playback started |
| `previewComplete` | `{id, title}` | Demo audio playback finished |
| `previewStopped` | `{id?, title?}` | Demo audio playback stopped by user |
| `demoAudioRenderSaved` | `{path, sampleRate}` | Rendered demo audio written to disk |
| `demoAudioRenderFailed` | `{message}` | Demo audio render/save failed |
| `tunerUpdate` | `{note, cents, frequency, ...}` | Tuner pitch detection update |
| `tunerStarted` | `{}` | Tuner activated |
| `tunerStopped` | `{}` | Tuner deactivated |
| `modelLoaded` | `{path}` | NAM model loaded |
| `irLoaded` | `{path}` | IR cab loaded |
| `hostedPluginResourceLoadFailed` | `{nodeId, resourceType, resourceId?, filePath?, resourceIndex?, message}` | Hosted plugin failed to load; UI shows inline error and clears loading indicator |
| `hostedPluginResourceLoadCompleted` | `{nodeId, resourceType, resourceId?, resourceIndex?}` | Hosted plugin resource selection finished loading; UI clears loading indicator |
| `nodeResourceBrowseCancelled` | `{nodeId, resourceType, resourceIndex?, exposedResourceId?}` | Node resource browse dialog dismissed without a selection |
| `resourceImported` | `{...}` | Remote resource imported |
| `resourceImportFailed` | `{message}` | Remote resource import failed |
| `globalChain` | `{config}` | Global signal chain configuration |
| `effectCatalog` | `{effects: [...]}` | Available effect types |
| `dspPerformance` | `{...}` | DSP performance statistics |
| `signalLevelDiagnostics` | `{rawInput, input, output, nodes}` | Signal level diagnostics and per-node meters |
| `spatialPosition` | `{nodes: [{scope, presetId?, nodeId, azimuth, elevation, distance, itdUs, ildDb, rateHz, moving}]}` | Live source position for every 3D Spatial node, ~20 Hz. Purely cosmetic: it keeps the spatial panner's puck in sync with what is being heard, and the widget falls back to the anchor position if it never arrives. Only sent while at least one such node exists. |
| `metronomeState` | `{bpm, enabled, ...}` | Metronome state |
| `layoutSaved` | `{...}` | Effect layout saved |
| `layoutLibraryLoaded` | `{layoutLibrary}` | Layout library loaded |
| `compositeLibrary` | `{...}` | Composite effect library |
| `compositeDefinitionAdded` | `{...}` | Composite effect added |
| `compositeDefinitionRemoved` | `{...}` | Composite effect removed |
| `compositeEditState` | `{...}` | Composite edit mode state |
| `compositeEditModeExited` | `{}` | Exited composite edit mode |

### UI → Engine Messages

| Type | Payload | Description |
|------|---------|-------------|
| `uiReady` | `{}` | WebView loaded and ready |
| `requestState` | `{}` | Request full state sync |
| `setParameter` | `{name, value}` | Update parameter value |
| `loadPreset` | `{preset, sceneId?}` | Load preset with full object and optionally select a scene |
| `savePreset` | `{name, category, description}` | Save current state as preset to disk |
| `loadModel` | `{filePath}` | Load NAM model by path |
| `loadIR` | `{filePath}` | Load IR cab by path |
| `browseModel` | `{}` | Open model file browser |
| `browseIR` | `{}` | Open IR file browser |
| `addSignalPathNode` | `{node, afterNodeId}` | Add effect to graph |
| `deleteSignalPathNode` | `{nodeId}` | Remove effect from graph |
| `replaceSignalPathNode` | `{nodeId, newNode}` | Replace effect in graph |
| `reorderSignalPathNode` | `{nodeId, newIndex}` | Reorder effect in graph |
| `updateSignalPathNodeParam` | `{nodeId, paramId, value}` | Update effect parameter |
| `updateSignalPathNodeBypass` | `{nodeId, bypassed}` | Bypass/enable effect |
| `updateNodeResource` | `{nodeId, resource}` | Change node resource |
| `browseNodeResource` | `{nodeId}` | Browse for node resource |
| `addActivePreset` | `{presetId}` | Add preset to multi-mixer |
| `removeActivePreset` | `{presetId}` | Remove preset from mixer |
| `setPresetMix` | `{presetId, mix}` | Set mixer preset level |
| `setPresetPan` | `{presetId, pan}` | Set mixer preset pan |
| `setPresetMute` | `{presetId, mute}` | Mute mixer preset |
| `setPresetSolo` | `{presetId, solo}` | Solo mixer preset |
| `setMasterGain` | `{gain}` | Set master output gain |
| `setLimiterEnabled` | `{enabled}` | Enable/disable limiter |
| `setInputMode` | `{mode}` | Set input mode (mono/stereo) |
| `setAmpCabState` | `{...}` | Set amp/cab enable state |
| `setAutoLevel` | `{...}` | Legacy compatibility message; controller forces mixer-wide auto-level back off |
| `setMetronome` | `{bpm?, enabled?, ...}` | Update metronome settings |
| `tuner` | `{action}` | Start/stop/configure tuner |
| `runSignalPathTest` | `{}` | Run signal path diagnostic |
| `previewDemoAudio` | `{audio}` | Preview demo audio clip |
| `renderDemoAudio` | `{audio? , takeId?, title?, suggestedName?, renderSampleRate?}` | Render selected demo audio to a WAV file using the current preset. `renderSampleRate` accepts `44100`, `48000`, `88200`, `96000`, `176400`, or `192000`; omit or pass `0` for the current device rate. The save-dialog filename appends the resolved rounded kHz rate before `.wav`. |
| `stopDemoAudio` | `{}` | Stop demo audio playback |
| `importRemoteResource` | `{...}` | Import resource from remote |
| `setSetting` | `{key, value}` | Persist and apply an app setting |
| `setUserInputCalibrationTrainingActive` | `{active}` | Temporarily bypass the active calibration profile while training |
| `setGlobalChainParam` | `{param, value}` | Set global chain parameter |
| `getGlobalChain` | `{}` | Request global chain state |
| `getEffectCatalog` | `{}` | Request effect catalog |
| `getPresetList` | `{}` | Request preset list from disk |
| `openAudioPreferences` | `{}` | Open audio device settings |

## State Object

Sent via `state` message on startup and major changes:

```json
{
  "parameters": {
    "input_trim": 0.0,
    "output_trim": -3.0,
    "amp1_drive": 0.65
  },
  "currentPreset": {
    "id": "preset-123",
    "name": "My Crunch Tone",
    "modified": true
  },
  "presets": [
    {"id": "preset-1", "name": "Clean", "category": "Clean"}
  ],
  "library": {
    "nam": [{"id": "plexi-bright", "name": "Plexi Bright", "category": "Marshall"}],
    "ir": [{"id": "4x12-sm57", "name": "4x12 SM57", "category": "Marshall"}]
  },
  "signalGraph": {
    "nodes": [...],
    "edges": [...]
  }
}
```

## JavaScript Bridge

### Sending Messages (UI → Engine)
```typescript
window.NAMBridge.postMessage({
  type: "setParameter",
  name: "amp1_drive",
  value: 0.72,
});
```

### Receiving Messages (Engine → UI)
```typescript
// Called by native code
window.IPlugReceiveData = function(jsonString) {
    const message = JSON.parse(jsonString);
    handleMessage(message);
};
```

## Synchronization

### Startup Sequence
1. WebView loads UI application
2. UI sends `requestState` message
3. Engine sends `state` message with full snapshot
4. UI renders initial state

### Parameter Updates
```
UI changes parameter:
1. User adjusts control
2. UI updates local state immediately (optimistic)
3. UI sends setParameter message (debounced 50ms)
4. Engine updates parameter
5. Engine includes update in next state broadcast

Engine changes parameter (automation):
1. DAW writes automation value
2. Engine includes in state broadcast
3. UI updates display
```

### Conflict Resolution
Engine value is authoritative. If UI receives a state broadcast with a different value than it sent, it adopts the engine value.

### Scene Editing

Presets can expose multiple named scenes. The UI edits one scene at a time in the signal-path bar,
while the engine keeps the full preset definition synchronized. Existing single-graph presets are
treated as a one-scene preset automatically.

## UI Views

| View | Purpose |
|------|---------|
| **Main** | Amp panel, global controls, level meters |
| **Preset Browser** | Local preset management, search, load/save |
| **Community Browser** | Remote preset search and download |
| **Signal Chain Editor** | Visual node-based effect chain |
| **Resource Browser** | NAM model and IR selection |
| **Settings** | Audio preferences, storage, theme |

## Settings → Audio

### User Input Calibration

The live product uses named user input calibration profiles instead of the older NAM interface calibration reference model.

**Behavior**
- A profile stores one fixed gain value in dB.
- The active profile applies that gain once at the mixer input before the pre-chain and preset graphs.
- While calibration training is active, the live calibration gain is bypassed temporarily so the capture reflects the raw input.

### Advanced DSP Level Targets

Two advanced settings affect runtime level behavior immediately:

- **Nominal Operating Level**: shared loudness target used by NAM output normalization when resource-owned normalization data is unavailable.
- **Output Protection Ceiling**: final ceiling used by mixer output protection.

**Defaults**
- Nominal operating level: **-18 dBFS**
- Output protection ceiling: **-1 dBFS**

## Parameter Controls

| Control | Usage |
|---------|-------|
| Knob | Continuous parameters (gain, drive) |
| Slider | Linear parameters (trim, mix) |
| Toggle | On/off states (bypass) |
| Dropdown | Selection (effect type, category) |
| Button | Actions (load, save, browse) |

## Signal Chain Editor Notes

- To create parallel paths, add the **Splitter** effect from the Utility category. The join **Mixer** node is inserted automatically and is not user-addable.

### Spatial panner (`core/ui/ts/spatialPanner.ts`)

The **3D Spatial** effect gets a bespoke widget in its parameter panel, mounted the same
way the EQ curve is (see `updateSpatialVisualization` in `signalPath.ts`).

- **Top-down radar** — azimuth and distance. The listener is at the centre facing up the
  screen; distance rings are logarithmic so the near field, where the cues change
  fastest, is actually draggable. The source puck shrinks with distance and shifts
  colour when it passes behind.
- **Elevation arc** — height, linked back to ear level by a dashed drop line so the two
  views read as one object rather than two unrelated controls.
- **Motion** — while the motion engine is running, the dashed ring is the anchor you
  dragged and the filled puck is what you are actually hearing, driven by the
  `spatialPosition` message. A fading trail shows the trajectory.
- **Honesty** — with `listenMode = Speakers` the elevation pane is dimmed and the rear
  half of the radar is shaded, because the DSP is no longer delivering those cues. The
  header hint switches from "Best on headphones" to say so.
- **Interaction** — pointer and touch drag, Shift for fine adjustment, double-click to
  reset just the axis you clicked, and full keyboard control: arrows pan and tilt,
  Alt+Up/Down changes distance, Home re-centres. The canvas is focusable with a live
  `aria-label` describing the position in words.
- Redraws are coalesced through a single `requestAnimationFrame`; there is no free-running
  animation loop.

### Neural Amp 3D view (`core/ui/ts/amp3d/`)

Neural Amp nodes (`kAmpNam`, `kAmpNamOptimized`, `kAmpNamBlend`) can swap the generic knob
grid for a photoreal 3D amp head. A toggle button (`.node-amp3d-toggle-btn`) sits in the
effect shell's meta rail next to the bypass switch; the preference is per user and stored
in app settings under `ui.neuralAmp3dView.enabled`.

- **Models** — glTF 2.0 components in `core/ui/assets/models/` (`amp-head`, `amp-knob`,
  `amp-switch`, `amp-led`, `amp-jack`, `amp-cabinet`), generated by the committed script
  `core/ui/scripts/generate-amp-models.js` (`npm run build:models`). The glTF files carry
  geometry plus named material slots only (`extras.materialSlot`); textures are generated
  procedurally at runtime from canvas so the silkscreen labels follow the node's real
  parameter list and the repo stays small. The one exception is the tolex covering of the
  head and cabinet, which uses the photographed swatch
  `core/ui/assets/models/amp-tolex-black.jpeg` (its normal map is derived from the image at
  load time, and the theme tint is applied as a light multiplier). If the image cannot be
  loaded or read back, the procedural tolex is used instead.
- **three.js** — vendored locally into `dist/vendor/three/` by `scripts/copy-vendor.js` and
  resolved through the import map in `index.template.html`. `signalPath.ts` loads the view
  with `await import("./amp3d/index.js")`, so nothing three-related is fetched until the
  user actually turns the 3D view on. `amp3d/ampSupport.ts` is deliberately three-free so
  the WebGL capability check and the stored preference can be imported statically.
- **Cabinet** — a 4x12 is stacked under the head when `nodeUsesFullRigNamCategory(node)` is
  true (i.e. the loaded capture is a full rig).
- **Layout** — when the 3D view is on, `signalPath.ts` puts `amp3d-immersive` on `<body>` and
  the render claims the whole area between the effect shell header and the window footer (the
  class is what threads the height down through the tab panel, visualization panel and effect
  shell, all of which otherwise size to their content). The model chooser and the leftover
  HTML parameter controls share a single translucent `.amp3d-dock` that floats over the
  bottom of the render, chooser on top, so the floor or the base of the cabinet stays visible
  behind them. The camera reserves part of that band (`measureBottomInset()` in `ampView.ts`,
  re-measured whenever the dock reflows) and adds fixed headroom above the model so the top of
  the head is never clipped.
- **Themes** — `ampTheme.ts` holds a small studio lighting rig (exposure, backdrop, key /
  fill / rim lights, environment intensity, grille backlight, LED colour, floor) per app
  theme: `dark`, `light` and `classic` ("Vintage"). Changing the theme re-renders the
  panel, which rebuilds the scene with the new preset.
- **Interaction** — drag a knob vertically to change its parameter (Shift for fine, wheel to
  step, double-click to restore the default); click the power switch to bypass or enable the
  node, which also kills the power LED, the grille backlight and the model display. Dragging
  anywhere else orbits within a limited arc; the wheel zooms; double-clicking the background
  resets the camera.
- **Amp internals** — when the node is active, `ampValves.ts` fills the thin slab between the
  grille backlight plane and the perforated grille face with a row of slowly breathing valve
  heaters (always warm, whatever the theme), a few small circuit indicators and drifting
  ember/dust particles in the theme's glow colour, plus one short-range point light so the
  cavity actually receives the glow. It is only ever seen through the grille perforations, so
  it reads as "something is alive in there" rather than as an overlay. Bypassing the node
  hides the whole group.
- **Fallbacks** — parameters that cannot be a physical knob (toggles, enums, advanced params
  and any beyond the panel's knob capacity) are still rendered as standard HTML controls in
  the floating dock, so no control is ever lost. If WebGL is unavailable the toggle is not
  offered at all, and if the models fail to load the viewport shows an inline error telling
  the user to switch back. The animated internals are decorative: if they cannot be built the
  amp still renders without them.
- Rendering is on demand (a `requestAnimationFrame` per state change). While the amp is
  active, on screen and the user has not set `prefers-reduced-motion: reduce`, the view keeps
  a self-scheduling loop capped at 30fps to drive the internals; it stops as soon as the node
  is bypassed. Reduced motion holds the deterministic `t = 0` pose. The view instance is
  reused across parameter-panel re-renders rather than being rebuilt, and it is disposed when
  the params panel closes, so nothing animates off screen.

## Performance Targets

| Metric | Target |
|--------|--------|
| Initial Load | < 500ms |
| View Switch | < 100ms |
| Parameter Response | < 50ms |
| Frame Rate | 60fps |

## Error Handling

| Error Type | Presentation |
|------------|--------------|
| Validation | Inline message near control |
| Operation Failure | Toast notification |
| Connection Error | Status indicator |
| Critical Error | Modal dialog |

## Accessibility

- Tab order for all controls
- ARIA labels on interactive elements
- Keyboard navigation (arrows for lists, Enter/Space for activation)
- Sufficient color contrast, scalable text

## See Also
- [Theme System](theme-system.md) — CSS theming
- [Architecture Overview](architecture-overview.md) — System layers
- [Signal Chain](signal-chain.md) — Graph modification messages
