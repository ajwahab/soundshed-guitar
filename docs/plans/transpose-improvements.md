# Transpose Improvements Plan

Status: in progress (2026-07). Covers the transpose/pitch-shift effect family: `pitch_shift`, `transpose` (also the global pre-chain transpose), `transpose_stft`, and `transpose_hybrid`. Related Signalsmith users: `octave`, `arp_auto`.

## Goal

Ship **high-quality ultra-low-latency transpose down to -12 st** for live guitar use, with honest PDC and competitive tone vs HyperTune / Archetype.

Two regimes need different engines:

| Regime | What wins today | Target |
|---|---|---|
| Shallow drop **±1…-3 st** | Signalsmith tone | ~8–12 ms with good tone |
| Deep drop **-5…-12 st** (live) | STFT latency + commercial-like tone | **≤10–12 ms** measured, HyperTune-class |
| Offline / max quality | Signalsmith | Latency secondary |

Do **not** force one fixed Signalsmith `presetCheaper` config to serve both live regimes.

## Current State

| Effect | Engine | Range (st) | Latency @48k (measured) | Notes |
|---|---|---|---|---|
| `pitch_shift` | Signalsmith `presetCheaper(2, sr, false)` | -12..+12 (continuous) | ~4800 samples (~100 ms) when shifting | Tonality limit 8 kHz |
| `transpose` | Signalsmith `presetCheaper(2, sr, false)` | -36..+12 (integer) | ~4800 samples (~100 ms) when shifting | Tonality limit 16 kHz; global pre-chain node, clamped to ±12 by controller/mixer/UI |
| `transpose_stft` | STFT phase vocoder | -12..+12 | ~331–619 LL / ~629–1195 poly (measured) | Experimental-flag gated in UI |
| `transpose_hybrid` | Dual-band **dual STFT** (900 Hz split) + dry transient assist | -15..0 | ~352–1269 (measured) | Auto-switches to polyphonic STFT at ≥4 st depth; experimental-gated; high CPU |

Sources: `core/src/dsp/effects/PitchShiftEffect.h`, `TransposeEffect.h`, `StftTransposeEffect.h`, `HybridTransposeEffect.h`; registration in `core/src/dsp/effects/BuiltinEffects.h`.

Benchmark snapshot of record: `transpose-benchmark-out/snapshot-20260712-040908` (internal + HyperTune Metal + Archetype Mansoor X).

### Competitive bar @ -12 st (measured)

| Variant | Measured latency | CPU (avg block µs) | Listening (first pass) |
|---|---:|---:|---|
| HyperTune Metal | ~7–10 ms | ~270 | Reference |
| Archetype Mansoor X | ~18 ms | ~400 | Reference (under-reports PDC) |
| STFT low-latency | ~13 ms | ~376 | ≈ HyperTune/Archetype mono+poly |
| STFT polyphonic | ~25 ms | ~796 | Best of our low-latency options @ -7 |
| Hybrid | ~26 ms | ~2150 | Most poly artifacts @ -12 |
| Signalsmith | ~100 ms | ~60–70 | Best small-shift tone; not live-viable at current config |

### Implementation note: hybrid is not time-domain lows

Plan text previously described hybrid as “time-domain lows + STFT highs.” **Code is dual STFT** (`mLowPitch` / `mHighPitch` both `StftTransposeChannel`) with a 900 Hz split + transient dry assist. That explains ~2× CPU vs polyphonic STFT and extra smear risk. Hybrid is a research branch until redesigned.

## Signalsmith latency model (canonical)

Source: [Signalsmith Stretch docs](https://signalsmith-audio.co.uk/code/stretch/) / README + vendored `signalsmith-stretch.h` (v1.3.2).

Latency is reported in **two halves**:

| API | Meaning |
|---|---|
| `inputLatency()` | How far **ahead** input sits relative to internal *processing time* (where pitch automation is centered) |
| `outputLatency()` | How far **behind** that processing time the audible output is |

For live 1:1 pitch shift (`process` with equal in/out lengths):

```text
PDC samples = inputLatency() + outputLatency()
```

Also relevant:

- After `reset()`, processing time is `inputLatency()` samples **before** the first real input → pre-roll until the stream aligns.
- `outputLatency()` includes an optional **split-computation** hop: when `splitComputation` is true, one extra `intervalSamples` of output latency smooths CPU spikes.
- `presetCheaper` defaults `splitComputation=true`; we pass **`false`** intentionally for lower latency.
- Tonality limit is a **fraction of sample rate**: `setTransposeSemitones(st, hz / sampleRate)` — our usage form is correct.
- For offline fixed-length renders: optional `seek` at start + silence pad + `flush` at end. Live/stream use does not require this; the benchmark deliberately measures stream warm-up latency.

Helper: `core/src/dsp/effects/SignalsmithLatency.h` → `SignalsmithTotalLatencySamples()`.

### Latency contract (product)

| Situation | Report | Audio path |
|---|---|---|
| Shift active (nonzero st / wet pitch path) | `input + output` | Stretch process |
| Transparent (0 st, full wet) | **0** | Dry copy bypass |
| Partial mix while shifting | same total as wet | Dry delayed by total latency before blend |

Constant-latency-through-zero is **not** the chosen contract (transparent-at-zero is preferred for global transpose).

## Known Defects

1. ~~**Signalsmith latency under-report.**~~ **Fixed (2026-07):** report `inputLatency() + outputLatency()`; 0 st reports 0. Same pattern applied to `octave` and `arp_auto`. Dry/wet mix for `pitch_shift` / `transpose` / `octave` uses a latency-aligned dry delay.
2. **Inconsistent tonality limits.** `pitch_shift` uses 8 kHz, `transpose` uses 16 kHz for the same engine and preset. Unify (or make it deliberate and documented).
3. **Range/contract drift.**
   - Docs mention -24/-36 ranges but the runtime global transpose is clamped to ±12 (`PluginController.cpp`, `MultiPresetMixer.cpp`, `controls.ts`). Decide: expand the runtime clamp or narrow the effect/docs.
   - `pitch_shift` has a `stepMode`/`minSemitones`/`maxSemitones` contract in UI/docs but the backend only supports `semitones` + `mix`. Restore backend support or remove from UI/docs.
4. **Pitch Shift “does not shift” (listening).** First-pass listening claimed no shift; unit test preload +12 ZCR path exists. Re-verify with benchmark WAVs after latency fix (compensated renders may have been misaligned due to PDC under-report).
5. **STFT latency slight over-report** on deep downshifts (e.g. rep 768 vs meas ~619 @ -12 LL). Safer than under-report; tighten later.
6. **Hybrid docs/code mismatch** and high CPU / poly artifacts @ -12 — do not promote from experimental yet.

## Latency Improvements

1. ~~**Honest Signalsmith PDC + dry align.**~~ Done (defect #1).
2. **Semitone-aware Signalsmith configuration.** Replace fixed `presetCheaper(2, sr, false)` with manual `configure(block, interval)` scaled by shift depth — small shifts (±1–3 st) can target ~10 ms total. Scope as **shallow-shift / HQ mode**, not the live -12 path. After every reconfigure, re-query `SignalsmithTotalLatencySamples()` (never hardcode 2400/4800). Keep `splitComputation=false` unless block peaks force it.
3. **Sample-rate-aware STFT profiles.** Scale analysis/synthesis windows with sample rate so 96 kHz does not silently lose resolution.
4. **Time-domain drop-tune mode.** For integer -1..-4 st monophonic-ish guitar, SOLA/bucket-brigade can reach sub-10 ms with better attacks than STFT — only after shallow-shift A/B shows need beyond Signalsmith shallow config.

## Polyphonic Quality Improvements (live -12 path = STFT)

1. **Laroche–Dolson identity phase locking** in `transpose_stft` polyphonic mode — quality without extra latency; may allow slightly smaller windows later.
2. **Retune STFT profiles for deep down** (-8…-12), not only `abs(st)` buckets.
3. **Close HyperTune gap (~13 ms → ~8–10 ms)** only after phase lock; validate mono+poly listening.
4. **Hybrid redesign or drop.** Prefer true time-domain lows + locked STFT highs, or fold transient-assist into single-band STFT. Do **not** promote hybrid on current dual-STFT evidence.
5. **Promote STFT** (not hybrid) out of experimental once A/B beats Signalsmith for live deep drop and matches commercial references.

## Product / default strategy (after quality work)

| Use | Recommended engine |
|---|---|
| Global / live drop to -12 | STFT (poly for chords; LL if latency budget is brutal) |
| Shallow live (±1–3) | Semitone-aware Signalsmith, or STFT only if shallow quality is fixed |
| Max quality / offline | Signalsmith HQ |
| FX library | Keep STFT/hybrid experimental until STFT wins A/B |

## Validation: Transpose Benchmark Harness

An offline benchmark renders the demo audio through every variant at multiple semitone settings and produces an HTML report comparing snapshots (revisions) side by side — latency (reported vs measured), throughput, and rendered audio for listening tests.

- Renderer: `core/tests/TransposeBenchmark.cpp` (CMake target `TransposeBenchmark`, ctest label `benchmark`, excluded from fast test runs).
- Report generator: `tools/transpose-benchmark/generate_report.py` (Python stdlib only).
- Inputs: `core/ui/demo/guitar-riff-01.wav`, `guitar-riff-02.wav`, `DI_Guitar_L.wav` (trimmed to 12 s, native sample rate, 512-sample blocks).
- Latency is measured two ways: `GetLatencySamples()` (what PDC would use) and envelope cross-correlation against the dry signal (ground truth). Rendered WAVs are compensated by the *reported* latency, so any PDC misreport is audible in the report.

### Running the benchmark

**Quick start — use the pipeline script (recommended):**

```powershell
# From repo root. Builds, runs, auto-renders external plugin passes, generates report.
.\tools\transpose-benchmark\run_benchmark.ps1

# All three demo samples + open report in browser when done:
.\tools\transpose-benchmark\run_benchmark.ps1 -AllDemoAudio -OpenReport

# Skip rebuild when the binary is already current (faster iteration):
.\tools\transpose-benchmark\run_benchmark.ps1 -NoBuild

# Skip auto-render (e.g. plugins not installed; use manual WAVs from external-renders/ instead):
.\tools\transpose-benchmark\run_benchmark.ps1 -NoAutoRender

# Debug binary, custom output directory:
.\tools\transpose-benchmark\run_benchmark.ps1 -BuildConfig Debug -OutputRoot C:\bench-out
```

The script wraps all steps below. Run it once to get everything; use the manual steps when you need finer control.

**Manual steps:**

```powershell
# 1. Build (Debug for a smoke test; use Release for meaningful perf stats)
cmake --build core/build --config Release --target TransposeBenchmark

# 2. Run one snapshot — label it with the git rev or a descriptive name.
#    By default this renders only the first demo riff (faster iteration).
core\build\Release\TransposeBenchmark.exe transpose-benchmark-out <snapshot-label>

# 2b. Optional: render all demo audio instead of the default first riff
core\build\Release\TransposeBenchmark.exe --all-demo-audio transpose-benchmark-out <snapshot-label>

# 3a. Auto-render external plugin passes via pedalboard (requires: pip install pedalboard)
python tools/transpose-benchmark/render_external_passes.py transpose-benchmark-out/<snapshot-label>

# 3b. Compute metrics for each auto-generated manifest
python tools/transpose-benchmark/build_external_passes.py transpose-benchmark-out/<snapshot-label> transpose-benchmark-out/<snapshot-label>/auto-manifest-<pluginId>.json

# 3c. Optional: import manual DAW renders instead (see "Including external plugin passes" below).
python tools/transpose-benchmark/build_external_passes.py transpose-benchmark-out/<snapshot-label> tools/transpose-benchmark/external-renders/<pluginId>.json

# 4. Generate/refresh the report (aggregates all snapshots under the output root)
python tools/transpose-benchmark/generate_report.py transpose-benchmark-out

# 5. Open the report
start transpose-benchmark-out\report.html
```

### Including external plugin passes

External plugin results can be added automatically or manually.

**Automated (recommended) — via `render_external_passes.py`:**

The pipeline script calls `render_external_passes.py` automatically. It reads
`tools/transpose-benchmark/external-plugins.json`, loads each VST3 plugin via
[pedalboard](https://github.com/spotify/pedalboard), sets the transpose
parameter at each configured semitone, processes the demo audio, and writes
manifests into the snapshot directory.

Requirements:
```powershell
pip install pedalboard
```

Plugin definitions in `external-plugins.json` must include:
- `pluginPath`: absolute path to the installed `.vst3` file
- `semitones`: list of integer semitone values to render
- `transposeParameter.name`: plugin parameter name (e.g. `"Transpose"`)
- `transposeParameter.mapping`: `"text"` (scan string values) or `"normalized"` (assume ±24 st linear range)

Optional:
- `parameterOverrides`: array of `{ "name": "...", "value": 0.0 }` (normalized 0..1) or `{ "name": "...", "text": "Off" }` applied once after load. Used for Archetype to disable amp/cab/gate/FX sections so only Transpose remains for a fair comparison.

**Manual fallback — via DAW renders:**

If a plugin cannot be loaded headlessly (e.g. requires GUI activation), pass `-NoAutoRender` and render manually:

1. **Render audio** through the external plugin at each semitone setting using the same dry sources: `core/ui/demo/guitar-riff-01.wav`, `guitar-riff-02.wav`, `DI_Guitar_L.wav`.

2. **Copy the rendered WAVs** into the snapshot directory under `external/` (e.g. `transpose-benchmark-out/<snapshot>/external/HyperTune_m12.wav`).

3. **Write a render manifest** and drop it in `tools/transpose-benchmark/external-renders/`. See `tools/transpose-benchmark/external-renders.example.json` for the schema:

   ```json
   {
     "pluginId": "hypertune_vst3",
     "entries": [
       { "sample": "guitar-riff-01.wav", "semitones": -12,
         "wav": "external/HyperTune_guitar-riff-01_m12.wav", "reportedLatencySamples": 0 },
       { "sample": "guitar-riff-01.wav", "semitones": 12,
         "wav": "external/HyperTune_guitar-riff-01_p12.wav", "reportedLatencySamples": 0 }
     ]
   }
   ```

   - `pluginId` must match an entry in `tools/transpose-benchmark/external-plugins.json` for label/path metadata to be resolved automatically.
   - `wav` is relative to the snapshot directory.
   - `reportedLatencySamples` should reflect the plugin's reported PDC value (0 if unknown).

4. **Run the pipeline script** — it discovers all `*.json` files in `external-renders/` and calls `build_external_passes.py` for each one, producing `external-passes-<pluginId>.json` in the snapshot directory. `generate_report.py` then merges these into the HTML report automatically.

### Comparing revisions

1. On the baseline revision, run the benchmark with a label like `baseline-<git-rev>`.
2. Apply a change (e.g. Signalsmith PDC fix, semitone-aware config), rebuild, and run again with a new label.
3. Re-run the report generator — each snapshot becomes a column, with Δ-latency warnings highlighted and audio players for A/B listening at each semitone setting.

**Gate metrics for each experiment:**

- Reported vs measured latency @ **-2** and **-12** (PDC honesty)
- Listening: mono riff + poly/chords (add a sustained chord fixture if only riffs exist)
- CPU: reject paths that approach Hybrid’s cost without a clear quality win

Notes:

- Debug-build timing numbers (realtime factor, block µs) are pessimistic; use `--config Release` for performance comparisons. Latency and audio output are valid in either config.
- Default runs render only the first riff (`guitar-riff-01.wav`) for faster iteration. Use `--all-demo-audio` when validating across all demo inputs.
- A full all-demo run is ~153 passes; expect several minutes in Debug.
- Output directories under `testing/transpose-benchmark/` and `transpose-benchmark-out/` are benchmark artifacts and should not be committed.

## Suggested Order of Work

1. ~~Fix Signalsmith `GetLatencySamples()` (input+output), 0 st → 0, dry delay for mix; same for Octave/AutoArp.~~ **Done.**
2. Re-run transpose benchmark snapshot; expect Signalsmith reported ≈ measured (~4800 @ 48k with current preset); compensated WAVs align.
3. Re-verify Pitch Shift listening / ZCR (defect #4) now that compensation is honest.
4. Unify tonality limits (defect #2).
5. STFT phase locking + deep-down profile retune; A/B vs HyperTune @ -12.
6. Semitone-aware Signalsmith for **shallow** shifts only; A/B @ -2.
7. Wire default live/global transpose to the winning low-latency path for deep drops; keep Signalsmith as HQ/shallow.
8. Hybrid redesign or SOLA drop-tune only if still needed; promote experimental effects only with data.
9. Resolve range/contract drift (defect #3) — product decision.

## What not to do next

- Promote hybrid as the default path on current dual-STFT evidence.
- Shrink STFT windows without phase locking.
- Spend major effort making Signalsmith do live -12 (commercial bar is ~8–18 ms; STFT is already there tonally).
- Expand global range past ±12 before the live engine is solid.
- Enable Signalsmith `splitComputation` “for quality” — it only adds latency for smoother CPU.

## Manual Listening Review

### first-pass

- all: Pitch Shift effect does not shift.
- -12st: All variants sound ok with basic riff
- -7st: Transpose STFT polyphonic, Transpose (Signalsmith) sound best. Former has best latency
- -2st: Transpose (Signalsmith) is the only version with reasonable sound. Pitch Shift effect does not shift.

### Current Archetype VS HyperTune VS Ours

- -12: Our Transpose Hybrid has the most artifacts for polyphonic input. Our STFT low latency and polyphonic sound like HyperTune and Archetype for monophonic and polyphonic
- -7: Our STFT starts to have artifacts; Transpose (Signalsmith) sounds most like HyperTune. HyperTune has slightly more presence
