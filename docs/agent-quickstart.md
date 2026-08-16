# Agent Quickstart

This doc is the minimal, high-signal guide for AI agents working in this repository.

## Minimal Context Bundle

If you only load a few files, use these:

- docs/architecture-overview.md
- docs/signal-chain.md
- docs/fx-library.md
- docs/data-models.md
- docs/user-interface.md
- .github/copilot-instructions.md

## Core Entry Points

- Application controller and UI bridge: core/src/PluginController.cpp, core/src/UiBridge.cpp
- DSP graph executor: core/src/dsp/SignalGraphExecutor.h
- Effect base and registry: core/src/dsp/EffectProcessor.h, core/src/dsp/EffectRegistry.h
- Preset schema and storage: core/src/presets/PresetTypes.h
- UI messages and state: core/ui/ts/messages.ts, core/ui/ts/state.ts

## Common Agent Tasks

### Add a New Effect

1. Implement EffectProcessor in core/src/dsp/effects/.
2. Register it via EffectRegistry in BuiltinEffects.h.
3. Define parameters (ranges, defaults) and category.
4. Update docs/fx-library.md if behavior changes.

### Add or Change a UI Message

1. Update types and handler in core/ui/ts/messages.ts.
2. Update the relevant dispatcher/controller path in core/src/MessageDispatcher.cpp and core/src/PluginController.cpp.
3. Keep messages backward compatible and validate payloads.
4. Update docs/user-interface.md for the protocol contract.

### Load a Resource (NAM or IR)

1. GraphNode.resource uses ResourceRef (resourceType + resourceId preferred).
2. Resolve via ResourceLibrary; fall back to embeddedId or filePath.
3. Validate file existence and log errors on failure.
4. Update docs/data-models.md if behavior changes.
5. NAM calibration policy: interface calibration input level is injected for all
   calibratable NAM nodes with valid model resources; per-node `useCalibration`
   still controls whether metadata-based auto-gain is active.

## Realtime Safety and Validation

- Audio thread: no allocations, no locks, no blocking I/O.
- Validate parameter ranges and resource presence; fail fast with clear errors.
- Graphs must be acyclic; invalid graphs should not reach Process().

## Build and Test Shortcuts

- Configure core: cmake -G "Visual Studio 18 2026" -A x64 -S core -B core/build
- Build JUCE standalone debug: cmake --build juce/builds --config Debug --target SoundshedGuitar_Standalone
- UI build: cd core/ui && npm run build
- Tests (Debug): cd core/build && ctest -C Debug --output-on-failure

## Live UI Testing (Computer-Use Debugging)

Static code review misses regressions that only show up at runtime — e.g. a DOM
`insertBefore()` against a node that moved to a different parent during a layout
rework, which throws and silently kills the rest of that render pass with no
compile error. Before declaring a UI-facing fix (especially in `core/ui/ts/signalPath.ts`,
mixer/tab rendering, or anything touching layout structure) actually done, run it.

The app's UI is WebView2 (Chromium) — a **different surface** from a normal browser
tab. Browser-automation/"computer use" tools cannot see or click this native window.
Instead, launch the Standalone build with WebView2's remote-debugging port enabled
and drive the *live, backend-connected* UI via Chrome DevTools Protocol:

```bash
cmake --build juce/builds --config Release --target SoundshedGuitar_Standalone --parallel
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9333" \
  "juce/builds/SoundshedGuitar_artefacts/Release/Standalone/Soundshed Guitar.exe" &
curl -s http://127.0.0.1:9333/json/list   # -> webSocketDebuggerUrl
node tools/agent-ui-debug/cdp-tool.mjs "$WS" --eval "<js>" --screenshot out.png
```

Full workflow, gotchas, and how to verify backend-truth (not just optimistic
client UI state) via the in-app debug-state snapshot: `tools/agent-ui-debug/README.md`.
Always `taskkill //F //IM "Soundshed Guitar.exe"` and remove any test presets
from `%APPDATA%\Soundshed Guitar\` when done — it's the real user profile.
