#!/usr/bin/env python3
"""Generate an HTML report from TransposeBenchmark output snapshots.

Scans <outputRoot>/*/results.json (one directory per snapshot/revision) and
produces <outputRoot>/report.html with per-pass stats and audio players,
grouping snapshots side by side so renders can be A/B'd across revisions.

The report includes:
  - a copy-path control next to each audio sample
  - a top-of-page spectrogram panel where selected renders can be overlaid
    with per-layer transparency (client-side Web Audio + Canvas)

Usage:
    python tools/transpose-benchmark/generate_report.py <outputRoot> [-o report.html]
    python tools/transpose-benchmark/generate_report.py <outputRoot> --serve
    python tools/transpose-benchmark/generate_report.py <outputRoot> --serve --port 8765

Spectrogram overlays load WAVs with fetch(), which browsers block under file://
(CORS). Open the report over HTTP (--serve) so +Spec works.

Stdlib only; no third-party dependencies.
"""

from __future__ import annotations

import argparse
import html
import json
import sys
import threading
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def _load_external_passes(snapshot_dir: Path) -> list[dict]:
    merged: list[dict] = []
    for ext_path in sorted(snapshot_dir.glob("external-passes*.json")):
        try:
            payload = json.loads(ext_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"WARN: skipping {ext_path}: {exc}", file=sys.stderr)
            continue

        if isinstance(payload, list):
            passes = payload
        elif isinstance(payload, dict):
            passes = payload.get("passes", [])
        else:
            passes = []

        if not isinstance(passes, list):
            print(f"WARN: skipping {ext_path}: expected list or object with 'passes'", file=sys.stderr)
            continue

        for entry in passes:
            if not isinstance(entry, dict):
                continue
            merged.append(entry)
    return merged


def load_snapshots(output_root: Path) -> list[dict]:
    snapshots = []
    for results_path in sorted(output_root.glob("*/results.json")):
        try:
            data = json.loads(results_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"WARN: skipping {results_path}: {exc}", file=sys.stderr)
            continue
        passes = data.get("passes", [])
        if not isinstance(passes, list):
            passes = []

        external = _load_external_passes(results_path.parent)
        if external:
            passes.extend(external)

        data["passes"] = passes
        data["_dir"] = results_path.parent.name
        snapshots.append(data)
    return snapshots


def fmt_ms(value) -> str:
    if value is None or (isinstance(value, (int, float)) and value < 0):
        return "n/a"
    return f"{value:.2f} ms"


def fmt_samples(value) -> str:
    if value is None or (isinstance(value, (int, float)) and value < 0):
        return "n/a"
    return f"{int(value)}"


def entry_audio_src(snapshot_dir: str, entry: dict) -> str | None:
    wav = entry.get("wav")
    if not isinstance(wav, str) or not wav:
        return None
    if "://" in wav or wav.startswith("/"):
        return wav
    return f"{snapshot_dir}/{wav}"


def entry_abs_path(output_root: Path, snapshot_dir: str, entry: dict) -> str | None:
    wav = entry.get("wav")
    if not isinstance(wav, str) or not wav:
        return None
    if "://" in wav:
        return wav
    path = Path(wav)
    if path.is_absolute():
        return str(path)
    return str((output_root / snapshot_dir / wav).resolve())


def audio_controls_html(
    *,
    rel_src: str,
    abs_path: str,
    label: str,
) -> str:
    """Audio player + copy-path + add-to-spectrogram controls."""
    esc_src = html.escape(rel_src, quote=True)
    esc_abs = html.escape(abs_path, quote=True)
    esc_label = html.escape(label, quote=True)
    esc_label_text = html.escape(label)
    return (
        f"<div class='audio-cell' data-src='{esc_src}' data-path='{esc_abs}' data-label='{esc_label}'>"
        f"<audio controls preload='none' src='{esc_src}'></audio>"
        f"<div class='audio-actions'>"
        f"<button type='button' class='icon-btn copy-path' title='Copy file path: {esc_label_text}' "
        f"aria-label='Copy file path'>"
        f"<svg width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='currentColor' "
        f"stroke-width='2' stroke-linecap='round' stroke-linejoin='round' aria-hidden='true'>"
        f"<rect x='9' y='9' width='13' height='13' rx='2'></rect>"
        f"<path d='M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'></path>"
        f"</svg></button>"
        f"<button type='button' class='icon-btn add-spec' title='Add to spectrogram comparison' "
        f"aria-label='Add to spectrogram'>+Spec</button>"
        f"<span class='copy-toast' hidden>Copied</span>"
        f"</div></div>"
    )


def report_styles() -> str:
    return """
body{font-family:Segoe UI,Arial,sans-serif;margin:24px;background:#141414;color:#e6e6e6}
h1{font-size:1.5em} h2{font-size:1.2em;margin-top:2em;border-bottom:1px solid #444}
table{border-collapse:collapse;width:100%;margin:12px 0;font-size:0.85em}
th,td{border:1px solid #3a3a3a;padding:6px 8px;text-align:left;vertical-align:top}
th{background:#232323} tr:nth-child(even){background:#1c1c1c}
.stat{white-space:nowrap} .warn{color:#ffb86c;font-weight:bold}
.good{color:#7ec97e} audio{width:230px;display:block;margin-top:4px}
.meta{color:#9a9a9a;font-size:0.85em}
.filters{display:flex;gap:16px;flex-wrap:wrap;align-items:center;margin:12px 0 20px}
.filters label{font-size:0.9em}
.filters select{background:#232323;color:#e6e6e6;border:1px solid #555;padding:4px 8px}
.audio-cell{display:flex;flex-direction:column;gap:4px;min-width:240px}
.audio-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.icon-btn{
  display:inline-flex;align-items:center;justify-content:center;gap:4px;
  background:#2a2a2a;color:#d8d8d8;border:1px solid #555;border-radius:4px;
  padding:3px 8px;cursor:pointer;font-size:0.78em;line-height:1.2
}
.icon-btn:hover{background:#3a3a3a;color:#fff;border-color:#777}
.icon-btn.active{background:#3d5a80;border-color:#6ea8fe;color:#fff}
.copy-toast{color:#7ec97e;font-size:0.75em}
.spec-panel{
  background:#1a1a1a;border:1px solid #3a3a3a;border-radius:8px;
  padding:16px 18px;margin:16px 0 28px
}
.spec-panel h2{margin-top:0;border-bottom:none}
.spec-toolbar{display:flex;flex-wrap:wrap;gap:14px;align-items:center;margin:10px 0 12px}
.spec-toolbar label{font-size:0.85em;color:#c8c8c8;display:inline-flex;align-items:center;gap:6px}
.spec-toolbar select,.spec-toolbar input[type=range]{
  background:#232323;color:#e6e6e6;border:1px solid #555;accent-color:#6ea8fe
}
.spec-toolbar button{
  background:#2a2a2a;color:#e6e6e6;border:1px solid #555;border-radius:4px;
  padding:5px 12px;cursor:pointer
}
.spec-toolbar button:hover{background:#3a3a3a}
.spec-layers{display:flex;flex-direction:column;gap:8px;margin:8px 0 12px;min-height:1.5em}
.spec-layer{
  display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center;
  background:#222;border:1px solid #3a3a3a;border-radius:6px;padding:8px 10px
}
.spec-swatch{width:12px;height:12px;border-radius:2px;border:1px solid #666;flex:0 0 auto}
.spec-layer .name{font-size:0.85em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 180px;min-width:120px}
.spec-layer label{font-size:0.8em;color:#aaa;display:inline-flex;align-items:center;gap:6px;flex:0 0 auto}
.spec-layer input[type=range]{width:110px;accent-color:#6ea8fe}
.spec-layer input[type=range].time-shift{width:150px;flex:0 0 150px}
.spec-layer .shift-val{
  display:inline-block;min-width:4.5em;text-align:right;
  font-variant-numeric:tabular-nums;font-family:Consolas,ui-monospace,monospace
}
.spec-layer .opacity-val{
  display:inline-block;min-width:2.6em;text-align:right;
  font-variant-numeric:tabular-nums
}
.spec-layer button{
  background:transparent;color:#bbb;border:1px solid #555;border-radius:4px;
  padding:2px 8px;cursor:pointer;font-size:0.78em;flex:0 0 auto
}
.spec-layer button:hover{color:#fff;border-color:#888}
#specCanvasWrap{
  position:relative;width:100%;overflow:auto;background:#0d0d0d;
  border:1px solid #333;border-radius:6px
}
#specCanvas{display:block;width:100%;height:420px;cursor:crosshair}
.spec-help{font-size:0.82em;color:#9a9a9a;margin:0 0 8px;line-height:1.4}
.spec-empty{color:#888;font-size:0.85em;padding:4px 0}
.spec-status{font-size:0.8em;color:#9a9a9a;min-height:1.2em}
.spec-banner{
  display:none;background:#3a2a12;border:1px solid #c98a2e;color:#ffd89a;
  border-radius:6px;padding:10px 12px;margin:0 0 12px;font-size:0.88em;line-height:1.45
}
.spec-banner.show{display:block}
.spec-banner code{
  display:inline-block;background:#1c1408;color:#ffe0a8;padding:1px 6px;border-radius:3px;
  font-size:0.92em;margin:2px 0
}
.spec-banner .title{font-weight:600;color:#ffcc70;margin-bottom:4px}
.icon-btn:disabled{opacity:0.45;cursor:not-allowed}
""".strip()


def report_script() -> str:
    """Client-side copy-path + multi-mode comparison viz (no external deps)."""
    # Large script embedded in the report; keep as one raw string for simplicity.
    return r"""
(function(){
  'use strict';

  // ----- Filters -----
  const labelFilter = document.getElementById('labelFilter');
  const sampleFilter = document.getElementById('sampleFilter');
  const effectFilter = document.getElementById('effectFilter');
  const sections = Array.from(document.querySelectorAll('.result-section'));
  const effectCells = Array.from(document.querySelectorAll('th[data-effect],td[data-effect]'));

  function applyFilters(){
    const label = labelFilter.value;
    const sample = sampleFilter.value;
    const effect = effectFilter.value;
    sections.forEach((section) => {
      const matchLabel = !label || section.dataset.label === label;
      const matchSample = !sample || section.dataset.sample === sample;
      section.style.display = (matchLabel && matchSample) ? '' : 'none';
    });
    effectCells.forEach((cell) => {
      const matchEffect = !effect || cell.dataset.effect === effect;
      cell.style.display = matchEffect ? '' : 'none';
    });
  }
  if (labelFilter) labelFilter.addEventListener('change', applyFilters);
  if (sampleFilter) sampleFilter.addEventListener('change', applyFilters);
  if (effectFilter) effectFilter.addEventListener('change', applyFilters);
  applyFilters();

  // ----- Copy path -----
  async function copyText(text){
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) {}
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) {}
    document.body.removeChild(ta);
    return ok;
  }

  document.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('.copy-path');
    if (!btn) return;
    const cell = btn.closest('.audio-cell');
    if (!cell) return;
    const path = cell.dataset.path || cell.dataset.src || '';
    const ok = await copyText(path);
    const toast = cell.querySelector('.copy-toast');
    if (toast) {
      toast.hidden = false;
      toast.textContent = ok ? 'Copied' : 'Copy failed';
      clearTimeout(btn._toastTimer);
      btn._toastTimer = setTimeout(() => { toast.hidden = true; }, 1400);
    }
  });

  // ----- Comparison visualization -----
  const canvas = document.getElementById('specCanvas');
  const layersEl = document.getElementById('specLayers');
  const statusEl = document.getElementById('specStatus');
  const helpEl = document.getElementById('specHelp');
  const clearBtn = document.getElementById('specClear');
  const fftSelect = document.getElementById('specFft');
  const hopSelect = document.getElementById('specHop');
  const maxFreqRange = document.getElementById('specMaxFreq');
  const maxFreqLabel = document.getElementById('specMaxFreqLabel');
  const viewSelect = document.getElementById('specView');
  const fileBanner = document.getElementById('fileProtocolBanner');
  if (!canvas || !layersEl) return;

  const isFileProtocol = (window.location.protocol === 'file:');
  if (isFileProtocol && fileBanner) fileBanner.classList.add('show');
  if (isFileProtocol) {
    document.querySelectorAll('.add-spec').forEach((btn) => {
      btn.disabled = true;
      btn.title = 'Serve the report over HTTP to enable analysis (see banner above)';
    });
  }

  const ctx = canvas.getContext('2d');
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const audioCache = new Map();
  const layers = [];
  let layerSeq = 0;
  let redrawTimer = 0;
  let rendering = false;

  const PALETTE = [
    '#4fc3f7', '#ff8a65', '#81c784', '#ce93d8',
    '#ffd54f', '#f06292', '#4db6ac', '#a1887f',
    '#90caf9', '#e57373', '#aed581', '#ba68c8'
  ];

  const VIEW_HELP = {
    spectrum: 'Mean spectrum (best for pitch): harmonic peaks shift left/right with transpose. Overlay curves of each layer. Time shift has little effect here (full-clip average).',
    logspec: 'Log-frequency spectrogram: equal vertical space per octave so pitch shifts read as vertical translation. Use per-layer Time sliders to align latency.',
    linspec: 'Linear spectrogram overlay (broadband energy often looks similar even when pitch differs). Use Time sliders to align latency.',
    diff: 'Difference spectrogram of the first two visible layers (A−B). Cyan = A stronger, Magenta = B stronger. Align with Time sliders first.',
    side: 'Side-by-side log spectrograms for the first two visible layers. Each panel respects that layer’s Time shift.',
    centroid: 'Spectral centroid over time (brightness / energy center). Pitch-down usually lowers the curve. Time shift moves traces horizontally.',
    pitch: 'F0 pitch track via autocorrelation (works best on sustained notes; noisy on dense chords). Time shift moves traces horizontally.',
    waveform: 'Waveform envelopes (timing / latency / level). Best place to nudge Time sliders until onsets line up.'
  };

  function setStatus(msg){ if (statusEl) statusEl.textContent = msg || ''; }
  function nextColor(){ return PALETTE[layers.length % PALETTE.length]; }
  function currentView(){ return viewSelect ? viewSelect.value : 'spectrum'; }

  function updateHelp(){
    if (helpEl) helpEl.textContent = VIEW_HELP[currentView()] || '';
  }

  function fft(re, im){
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let tmp = re[i]; re[i] = re[j]; re[j] = tmp;
        tmp = im[i]; im[i] = im[j]; im[j] = tmp;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = -2 * Math.PI / len;
      const wlenRe = Math.cos(ang), wlenIm = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let wRe = 1, wIm = 0;
        for (let j = 0; j < len / 2; j++) {
          const uRe = re[i + j], uIm = im[i + j];
          const vRe = re[i + j + len / 2] * wRe - im[i + j + len / 2] * wIm;
          const vIm = re[i + j + len / 2] * wIm + im[i + j + len / 2] * wRe;
          re[i + j] = uRe + vRe; im[i + j] = uIm + vIm;
          re[i + j + len / 2] = uRe - vRe; im[i + j + len / 2] = uIm - vIm;
          const nRe = wRe * wlenRe - wIm * wlenIm;
          wIm = wRe * wlenIm + wIm * wlenRe; wRe = nRe;
        }
      }
    }
  }

  function hannWindow(n){
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1 || 1)));
    return w;
  }

  function monoFromBuffer(buffer){
    const n = buffer.length;
    const out = new Float32Array(n);
    if (buffer.numberOfChannels === 1) { out.set(buffer.getChannelData(0)); return out; }
    const L = buffer.getChannelData(0), R = buffer.getChannelData(1);
    for (let i = 0; i < n; i++) out[i] = 0.5 * (L[i] + R[i]);
    return out;
  }

  // Downsample for pitch/waveform analysis (keeps first ~12s at ~8 kHz max useful for F0).
  function downsample(samples, srcRate, dstRate){
    if (dstRate >= srcRate) return { samples: samples, sampleRate: srcRate };
    const ratio = srcRate / dstRate;
    const n = Math.floor(samples.length / ratio);
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const src = i * ratio;
      const i0 = Math.floor(src);
      const frac = src - i0;
      const a = samples[i0] || 0;
      const b = samples[Math.min(i0 + 1, samples.length - 1)] || 0;
      out[i] = a + (b - a) * frac;
    }
    return { samples: out, sampleRate: dstRate };
  }

  function estimateF0Frame(frame, sampleRate, minHz, maxHz){
    // Autocorrelation peak in lag range for monophonic-ish content.
    const minLag = Math.max(2, Math.floor(sampleRate / maxHz));
    const maxLag = Math.min(frame.length - 2, Math.floor(sampleRate / minHz));
    if (maxLag <= minLag + 2) return 0;
    let energy = 0;
    for (let i = 0; i < frame.length; i++) energy += frame[i] * frame[i];
    if (energy < 1e-8) return 0;
    let bestLag = 0, bestCorr = 0;
    for (let lag = minLag; lag <= maxLag; lag++) {
      let corr = 0;
      const n = frame.length - lag;
      for (let i = 0; i < n; i++) corr += frame[i] * frame[i + lag];
      corr /= (energy + 1e-12);
      if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
    }
    if (bestCorr < 0.25 || bestLag <= 0) return 0;
    return sampleRate / bestLag;
  }

  function computeAnalysis(samples, sampleRate, fftSize, hopSize){
    const win = hannWindow(fftSize);
    const half = fftSize >> 1;
    const frames = Math.max(1, 1 + Math.floor(Math.max(0, samples.length - fftSize) / hopSize));
    const mags = new Float32Array(frames * half);       // dB spectrogram
    const linSum = new Float64Array(half);              // mean linear spectrum
    const centroid = new Float32Array(frames);          // Hz
    const re = new Float32Array(fftSize);
    const im = new Float32Array(fftSize);
    let minDb = Infinity, maxDb = -Infinity;
    let activeFrames = 0;

    for (let f = 0; f < frames; f++) {
      const start = f * hopSize;
      re.fill(0); im.fill(0);
      let frameEnergy = 0;
      for (let i = 0; i < fftSize; i++) {
        const s = (start + i < samples.length) ? samples[start + i] : 0;
        re[i] = s * win[i];
        frameEnergy += s * s;
      }
      fft(re, im);
      const base = f * half;
      let weighted = 0, total = 0;
      for (let k = 0; k < half; k++) {
        const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]) / fftSize;
        const db = 20 * Math.log10(mag + 1e-12);
        mags[base + k] = db;
        if (db > maxDb) maxDb = db;
        if (db < minDb) minDb = db;
        if (frameEnergy > 1e-6) {
          linSum[k] += mag;
          const freq = k * sampleRate / fftSize;
          weighted += freq * mag;
          total += mag;
        }
      }
      if (frameEnergy > 1e-6) {
        centroid[f] = total > 1e-12 ? (weighted / total) : 0;
        activeFrames++;
      } else {
        centroid[f] = 0;
      }
    }
    if (!isFinite(minDb) || !isFinite(maxDb) || maxDb - minDb < 1) { minDb = -100; maxDb = 0; }
    minDb = Math.max(minDb, maxDb - 80);

    const meanLin = new Float32Array(half);
    const meanDb = new Float32Array(half);
    const denom = Math.max(1, activeFrames);
    for (let k = 0; k < half; k++) {
      meanLin[k] = linSum[k] / denom;
      meanDb[k] = 20 * Math.log10(meanLin[k] + 1e-12);
    }

    // Pitch track on downsampled mono (~4 kHz is enough for guitar fundamentals).
    const ds = downsample(samples, sampleRate, 4000);
    const f0Hop = Math.max(64, Math.floor(ds.sampleRate * 0.02)); // 20 ms
    const f0Win = Math.max(256, Math.floor(ds.sampleRate * 0.04)); // 40 ms
    const f0Frames = Math.max(1, 1 + Math.floor(Math.max(0, ds.samples.length - f0Win) / f0Hop));
    const f0 = new Float32Array(f0Frames);
    const f0Frame = new Float32Array(f0Win);
    for (let f = 0; f < f0Frames; f++) {
      const start = f * f0Hop;
      for (let i = 0; i < f0Win; i++) f0Frame[i] = ds.samples[start + i] || 0;
      f0[f] = estimateF0Frame(f0Frame, ds.sampleRate, 55, 800);
    }

    // Envelope peaks for waveform view (decimated abs peaks).
    const envHop = Math.max(1, Math.floor(sampleRate / 200)); // ~200 pts/sec
    const envN = Math.ceil(samples.length / envHop);
    const envelope = new Float32Array(envN);
    for (let i = 0; i < envN; i++) {
      const a = i * envHop;
      const b = Math.min(samples.length, a + envHop);
      let peak = 0;
      for (let j = a; j < b; j++) {
        const v = Math.abs(samples[j]);
        if (v > peak) peak = v;
      }
      envelope[i] = peak;
    }

    return {
      frames, half, mags, minDb, maxDb, sampleRate, fftSize, hopSize,
      duration: samples.length / sampleRate,
      meanDb, meanLin, centroid, f0, f0HopSec: f0Hop / ds.sampleRate,
      envelope, envHopSec: envHop / sampleRate
    };
  }

  function resolveAudioUrl(src){
    try { return new URL(src, window.location.href).href; } catch (_) { return src; }
  }

  async function loadAudio(src){
    if (isFileProtocol) {
      throw new Error(
        'Analysis cannot load WAVs from file:// (browser CORS). '
        + 'Serve with: python tools/transpose-benchmark/generate_report.py transpose-benchmark-out --serve'
      );
    }
    const url = resolveAudioUrl(src);
    if (audioCache.has(url)) return audioCache.get(url);
    setStatus('Loading ' + src + '…');
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('HTTP ' + resp.status + ' for ' + url);
    const arr = await resp.arrayBuffer();
    const buffer = await audioCtx.decodeAudioData(arr.slice(0));
    audioCache.set(url, buffer);
    return buffer;
  }

  // Positive timeShiftMs delays the layer (features move right) — useful for
  // lining up algorithms that report / introduce different latency.
  const TIME_SHIFT_MIN_MS = -500;
  const TIME_SHIFT_MAX_MS = 500;

  function layerShiftSec(layer){
    return (Number(layer.timeShiftMs) || 0) / 1000;
  }

  function formatShiftMs(ms){
    // Fixed-width-ish text so the range thumb does not jump under the cursor
    // as the label grows from "0 ms" to "+500 ms".
    const v = Math.round(ms);
    const sign = v > 0 ? '+' : (v < 0 ? '-' : ' ');
    const abs = String(Math.abs(v)).padStart(3, ' ');
    return sign + abs + ' ms';
  }

  // Map global display time t (seconds) to a spectrogram frame index for layer.
  // Returns -1 when the shifted time is outside the layer's content.
  function frameAtTime(sp, tSec, shiftSec){
    const srcT = tSec - shiftSec;
    if (srcT < 0 || srcT > sp.duration + sp.hopSize / sp.sampleRate) return -1;
    return Math.min(sp.frames - 1, Math.max(0, Math.floor(srcT * sp.sampleRate / sp.hopSize)));
  }

  function rebuildLayerList(){
    layersEl.innerHTML = '';
    if (!layers.length) {
      const empty = document.createElement('div');
      empty.className = 'spec-empty';
      empty.textContent = 'No layers yet — click “+Spec” on any audio cell below.';
      layersEl.appendChild(empty);
      updateAddButtons();
      return;
    }
    layers.forEach((layer, idx) => {
      if (typeof layer.timeShiftMs !== 'number') layer.timeShiftMs = 0;

      const row = document.createElement('div');
      row.className = 'spec-layer';

      const swatch = document.createElement('span');
      swatch.className = 'spec-swatch';
      swatch.style.background = layer.color;

      const name = document.createElement('span');
      name.className = 'name';
      name.title = layer.label + '\n' + layer.src;
      name.textContent = (idx + 1) + '. ' + layer.label;

      const opacityLabel = document.createElement('label');
      const opacityVal = document.createElement('span');
      opacityVal.className = 'opacity-val';
      opacityVal.textContent = Math.round(layer.opacity * 100) + '%';
      const opacity = document.createElement('input');
      opacity.type = 'range'; opacity.min = '0'; opacity.max = '100';
      opacity.value = String(Math.round(layer.opacity * 100));
      opacity.addEventListener('input', () => {
        layer.opacity = Number(opacity.value) / 100;
        opacityVal.textContent = opacity.value + '%';
        scheduleRedraw();
      });
      opacityLabel.appendChild(document.createTextNode('Opacity '));
      opacityLabel.appendChild(opacity);
      opacityLabel.appendChild(opacityVal);

      // Keep slider + fixed-width label outside a wrapping <label> so layout
      // reflow from the ms text cannot shove the thumb under the pointer.
      const shiftWrap = document.createElement('div');
      shiftWrap.style.cssText = 'display:inline-flex;align-items:center;gap:6px;flex:0 0 auto';
      shiftWrap.title = 'Delay (+) or advance (−) this layer on the time axis to align latency';
      const shiftCaption = document.createElement('span');
      shiftCaption.textContent = 'Time';
      shiftCaption.style.fontSize = '0.8em';
      shiftCaption.style.color = '#aaa';
      const shiftVal = document.createElement('span');
      shiftVal.className = 'shift-val';
      shiftVal.textContent = formatShiftMs(layer.timeShiftMs);
      const shift = document.createElement('input');
      shift.type = 'range';
      shift.className = 'time-shift';
      shift.min = String(TIME_SHIFT_MIN_MS);
      shift.max = String(TIME_SHIFT_MAX_MS);
      shift.step = '1';
      shift.value = String(Math.round(layer.timeShiftMs));
      shift.addEventListener('input', () => {
        layer.timeShiftMs = Number(shift.value);
        shiftVal.textContent = formatShiftMs(layer.timeShiftMs);
        scheduleRedraw();
      });
      const shiftReset = document.createElement('button');
      shiftReset.type = 'button';
      shiftReset.textContent = '0';
      shiftReset.title = 'Reset time shift to 0 ms';
      shiftReset.addEventListener('click', () => {
        layer.timeShiftMs = 0;
        shift.value = '0';
        shiftVal.textContent = formatShiftMs(0);
        scheduleRedraw();
      });
      shiftWrap.appendChild(shiftCaption);
      shiftWrap.appendChild(shift);
      shiftWrap.appendChild(shiftVal);
      shiftWrap.appendChild(shiftReset);

      const solo = document.createElement('button');
      solo.type = 'button'; solo.textContent = 'Solo';
      solo.addEventListener('click', () => {
        layers.forEach((l, i) => { l.opacity = (i === idx) ? 1 : 0.12; });
        rebuildLayerList(); scheduleRedraw();
      });

      const remove = document.createElement('button');
      remove.type = 'button'; remove.textContent = 'Remove';
      remove.addEventListener('click', () => {
        const i = layers.findIndex((l) => l.id === layer.id);
        if (i >= 0) layers.splice(i, 1);
        rebuildLayerList(); scheduleRedraw();
      });

      row.appendChild(swatch); row.appendChild(name);
      row.appendChild(opacityLabel); row.appendChild(shiftWrap);
      row.appendChild(solo); row.appendChild(remove);
      layersEl.appendChild(row);
    });
    updateAddButtons();
  }

  function updateAddButtons(){
    const activeSrcs = new Set(layers.map((l) => l.src));
    document.querySelectorAll('.audio-cell').forEach((cell) => {
      const btn = cell.querySelector('.add-spec');
      if (!btn) return;
      if (activeSrcs.has(cell.dataset.src)) {
        btn.classList.add('active'); btn.textContent = 'In Spec';
      } else {
        btn.classList.remove('active'); btn.textContent = '+Spec';
      }
    });
  }

  function scheduleRedraw(){
    clearTimeout(redrawTimer);
    redrawTimer = setTimeout(() => { redraw(); }, 20);
  }

  function hexToRgb(hex){
    const h = hex.replace('#', '');
    const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function visibleLayers(){
    return layers.filter((l) => l.analysis && l.opacity > 0.01);
  }

  function layoutCanvas(cssH){
    const dpr = window.devicePixelRatio || 1;
    const cssW = Math.max(640, canvas.clientWidth || 960);
    canvas.width = Math.floor(cssW * dpr);
    canvas.height = Math.floor(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, cssW, cssH);
    return { cssW, cssH };
  }

  function drawAxesTimeFreq(leftPad, topPad, plotW, plotH, maxDuration, yTicks){
    ctx.strokeStyle = '#444'; ctx.fillStyle = '#9a9a9a';
    ctx.font = '11px Segoe UI, Arial, sans-serif'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(leftPad, topPad);
    ctx.lineTo(leftPad, topPad + plotH);
    ctx.lineTo(leftPad + plotW, topPad + plotH);
    ctx.stroke();
    const timeStep = maxDuration > 8 ? 2 : 1;
    for (let t = 0; t <= maxDuration + 1e-6; t += timeStep) {
      const x = leftPad + (t / maxDuration) * plotW;
      ctx.beginPath(); ctx.moveTo(x, topPad + plotH); ctx.lineTo(x, topPad + plotH + 4); ctx.stroke();
      ctx.fillText(t.toFixed(t % 1 === 0 ? 0 : 1) + 's', x - 6, topPad + plotH + 16);
    }
    yTicks.forEach((tick) => {
      const y = topPad + plotH * (1 - tick.frac);
      ctx.beginPath(); ctx.moveTo(leftPad - 4, y); ctx.lineTo(leftPad, y); ctx.stroke();
      ctx.fillText(tick.label, 2, y + 3);
    });
  }

  function freqToYLinear(freq, maxFreq, plotH){
    return plotH * (1 - Math.max(0, Math.min(1, freq / maxFreq)));
  }
  function freqToYLog(freq, minFreq, maxFreq, plotH){
    const f = Math.max(minFreq, Math.min(maxFreq, freq));
    const t = Math.log(f / minFreq) / Math.log(maxFreq / minFreq);
    return plotH * (1 - t);
  }
  function yToFreqLog(y, minFreq, maxFreq, plotH){
    const t = 1 - y / plotH;
    return minFreq * Math.pow(maxFreq / minFreq, t);
  }

  function magAt(sp, frame, bin){
    return sp.mags[frame * sp.half + bin];
  }

  function binForFreq(sp, freq){
    const bin = Math.round(freq * sp.fftSize / sp.sampleRate);
    return Math.max(0, Math.min(sp.half - 1, bin));
  }

  function drawSpectrogramOverlay(opts){
    const { leftPad, topPad, plotW, plotH, maxDuration, maxFreqHz, logScale } = opts;
    const pw = Math.floor(plotW), ph = Math.floor(plotH);
    const img = ctx.createImageData(pw, ph);
    const data = img.data;
    const minLogF = 60;
    const vis = visibleLayers();

    vis.forEach((layer) => {
      const sp = layer.analysis;
      const { r, g, b } = hexToRgb(layer.color);
      const opacity = layer.opacity;
      const shiftSec = layerShiftSec(layer);
      const nyquist = sp.sampleRate * 0.5;
      const freqLimit = Math.min(maxFreqHz, nyquist);
      const dbRange = Math.max(1e-6, sp.maxDb - sp.minDb);

      for (let x = 0; x < pw; x++) {
        const t = (x / pw) * maxDuration;
        const frame = frameAtTime(sp, t, shiftSec);
        if (frame < 0) continue;
        for (let y = 0; y < ph; y++) {
          let freq;
          if (logScale) freq = yToFreqLog(y, minLogF, freqLimit, ph);
          else freq = (1 - y / ph) * freqLimit;
          const bin = binForFreq(sp, freq);
          const db = magAt(sp, frame, bin);
          let intensity = Math.max(0, Math.min(1, (db - sp.minDb) / dbRange));
          intensity = Math.pow(intensity, 0.55);
          const a = intensity * opacity;
          if (a <= 0.003) continue;
          const idx = (y * pw + x) * 4;
          data[idx] = Math.min(255, data[idx] + r * a);
          data[idx + 1] = Math.min(255, data[idx + 1] + g * a);
          data[idx + 2] = Math.min(255, data[idx + 2] + b * a);
          data[idx + 3] = 255;
        }
      }
    });
    ctx.putImageData(img, leftPad, topPad);

    const ticks = [];
    if (logScale) {
      [80, 160, 320, 640, 1280, 2500, 5000, 10000].forEach((f) => {
        if (f > maxFreqHz) return;
        const frac = Math.log(f / minLogF) / Math.log(maxFreqHz / minLogF);
        if (frac >= 0 && frac <= 1) ticks.push({ frac, label: f >= 1000 ? (f/1000)+'k' : String(f) });
      });
    } else {
      for (let i = 0; i <= 4; i++) {
        const frac = i / 4;
        const f = Math.round(maxFreqHz * frac);
        ticks.push({ frac, label: f >= 1000 ? (f/1000).toFixed(f%1000===0?0:1)+'k' : String(f) });
      }
    }
    drawAxesTimeFreq(leftPad, topPad, plotW, plotH, maxDuration, ticks);
  }

  function drawDifference(opts){
    const { leftPad, topPad, plotW, plotH, maxDuration, maxFreqHz } = opts;
    const vis = visibleLayers();
    if (vis.length < 2) {
      ctx.fillStyle = '#888'; ctx.font = '13px Segoe UI, Arial, sans-serif';
      ctx.fillText('Difference view needs at least two layers (A = first, B = second).', leftPad, topPad + 24);
      return;
    }
    const A = vis[0].analysis, B = vis[1].analysis;
    const shiftA = layerShiftSec(vis[0]), shiftB = layerShiftSec(vis[1]);
    const pw = Math.floor(plotW), ph = Math.floor(plotH);
    const img = ctx.createImageData(pw, ph);
    const data = img.data;
    const minLogF = 60;
    // Normalize each layer's frame to peak 0 dB so level mismatches don't dominate.
    for (let x = 0; x < pw; x++) {
      const t = (x / pw) * maxDuration;
      const fA = frameAtTime(A, t, shiftA);
      const fB = frameAtTime(B, t, shiftB);
      if (fA < 0 && fB < 0) continue;
      let peakA = -1e9, peakB = -1e9;
      if (fA >= 0) for (let k = 0; k < A.half; k++) peakA = Math.max(peakA, magAt(A, fA, k));
      if (fB >= 0) for (let k = 0; k < B.half; k++) peakB = Math.max(peakB, magAt(B, fB, k));
      for (let y = 0; y < ph; y++) {
        const freq = yToFreqLog(y, minLogF, maxFreqHz, ph);
        const dbA = (fA >= 0 ? magAt(A, fA, binForFreq(A, freq)) - peakA : -80);
        const dbB = (fB >= 0 ? magAt(B, fB, binForFreq(B, freq)) - peakB : -80);
        const d = Math.max(-24, Math.min(24, dbA - dbB)); // dB difference
        const idx = (y * pw + x) * 4;
        if (d >= 0) {
          // A stronger → cyan
          const a = Math.pow(d / 24, 0.7);
          data[idx] = 20; data[idx+1] = Math.min(255, 40 + 200 * a); data[idx+2] = Math.min(255, 60 + 220 * a); data[idx+3] = 255;
        } else {
          // B stronger → magenta
          const a = Math.pow((-d) / 24, 0.7);
          data[idx] = Math.min(255, 60 + 220 * a); data[idx+1] = 20; data[idx+2] = Math.min(255, 60 + 180 * a); data[idx+3] = 255;
        }
      }
    }
    ctx.putImageData(img, leftPad, topPad);
    const ticks = [];
    [80, 160, 320, 640, 1280, 2500, 5000, 10000].forEach((f) => {
      if (f > maxFreqHz) return;
      const frac = Math.log(f / minLogF) / Math.log(maxFreqHz / minLogF);
      if (frac >= 0 && frac <= 1) ticks.push({ frac, label: f >= 1000 ? (f/1000)+'k' : String(f) });
    });
    drawAxesTimeFreq(leftPad, topPad, plotW, plotH, maxDuration, ticks);
    ctx.fillStyle = '#9a9a9a'; ctx.font = '11px Segoe UI, Arial, sans-serif';
    ctx.fillText('Cyan = ' + vis[0].label.slice(0, 40) + ' stronger', leftPad, topPad - 4);
    ctx.fillText('Magenta = ' + vis[1].label.slice(0, 40) + ' stronger', leftPad + plotW * 0.45, topPad - 4);
  }

  function drawSideBySide(opts){
    const { cssW, maxDuration, maxFreqHz } = opts;
    const vis = visibleLayers();
    if (!vis.length) return;
    const n = Math.min(2, vis.length);
    const gap = 10;
    const leftPad = 48, bottomPad = 28, topPad = 28;
    const panelW = (cssW - leftPad - 10 - gap * (n - 1)) / n;
    const plotH = 360 - bottomPad - topPad;
    for (let i = 0; i < n; i++) {
      const x0 = leftPad + i * (panelW + gap);
      // Temporarily draw into a clipped region by translating
      ctx.save();
      // Draw one-layer overlay into a temp canvas approach: set only this layer visible via local draw
      const layer = vis[i];
      const pw = Math.floor(panelW), ph = Math.floor(plotH);
      const img = ctx.createImageData(pw, ph);
      const data = img.data;
      const sp = layer.analysis;
      const shiftSec = layerShiftSec(layer);
      const { r, g, b } = hexToRgb(layer.color);
      const minLogF = 60;
      const dbRange = Math.max(1e-6, sp.maxDb - sp.minDb);
      for (let x = 0; x < pw; x++) {
        const t = (x / pw) * maxDuration;
        const frame = frameAtTime(sp, t, shiftSec);
        for (let y = 0; y < ph; y++) {
          const freq = yToFreqLog(y, minLogF, maxFreqHz, ph);
          const db = frame < 0 ? sp.minDb : magAt(sp, frame, binForFreq(sp, freq));
          let intensity = frame < 0 ? 0 : Math.pow(Math.max(0, Math.min(1, (db - sp.minDb) / dbRange)), 0.55);
          const idx = (y * pw + x) * 4;
          data[idx] = r * intensity; data[idx+1] = g * intensity; data[idx+2] = b * intensity; data[idx+3] = 255;
        }
      }
      ctx.putImageData(img, x0, topPad);
      ctx.strokeStyle = '#444'; ctx.strokeRect(x0, topPad, panelW, plotH);
      ctx.fillStyle = layer.color; ctx.font = '12px Segoe UI, Arial, sans-serif';
      const shiftNote = layer.timeShiftMs ? ' [' + formatShiftMs(layer.timeShiftMs) + ']' : '';
      ctx.fillText((i + 1) + '. ' + layer.label.slice(0, 40) + shiftNote, x0, 16);
      ctx.restore();
    }
    if (vis.length === 1) {
      ctx.fillStyle = '#888'; ctx.font = '12px Segoe UI, Arial, sans-serif';
      ctx.fillText('Add a second layer for side-by-side comparison.', leftPad, 380);
    }
  }

  function drawLineChart(opts){
    // Generic multi-series line chart: series are arrays of {x:0..1, y:value}, y mapped with yMap
    const { leftPad, topPad, plotW, plotH, title, yMin, yMax, yLabelFn, series, xLabel } = opts;
    ctx.strokeStyle = '#444'; ctx.fillStyle = '#9a9a9a';
    ctx.font = '11px Segoe UI, Arial, sans-serif'; ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(leftPad, topPad); ctx.lineTo(leftPad, topPad + plotH); ctx.lineTo(leftPad + plotW, topPad + plotH);
    ctx.stroke();
    if (title) { ctx.fillStyle = '#c8c8c8'; ctx.fillText(title, leftPad, topPad - 6); ctx.fillStyle = '#9a9a9a'; }

    for (let i = 0; i <= 4; i++) {
      const frac = i / 4;
      const y = topPad + plotH * (1 - frac);
      const val = yMin + (yMax - yMin) * frac;
      ctx.beginPath(); ctx.moveTo(leftPad - 4, y); ctx.lineTo(leftPad, y); ctx.stroke();
      ctx.fillText(yLabelFn(val), 2, y + 3);
      ctx.strokeStyle = '#222';
      ctx.beginPath(); ctx.moveTo(leftPad, y); ctx.lineTo(leftPad + plotW, y); ctx.stroke();
      ctx.strokeStyle = '#444';
    }
    for (let i = 0; i <= 4; i++) {
      const frac = i / 4;
      const x = leftPad + plotW * frac;
      ctx.beginPath(); ctx.moveTo(x, topPad + plotH); ctx.lineTo(x, topPad + plotH + 4); ctx.stroke();
      ctx.fillText(xLabel(frac), x - 8, topPad + plotH + 16);
    }

    series.forEach((s) => {
      if (!s.points.length) return;
      ctx.strokeStyle = s.color;
      ctx.globalAlpha = s.opacity;
      ctx.lineWidth = 2;
      ctx.beginPath();
      let started = false;
      s.points.forEach((p) => {
        if (p.y == null || !isFinite(p.y)) { started = false; return; }
        const x = leftPad + p.x * plotW;
        const y = topPad + plotH * (1 - (p.y - yMin) / (yMax - yMin || 1));
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
      ctx.globalAlpha = 1;
    });
  }

  function drawMeanSpectrum(opts){
    const { leftPad, topPad, plotW, plotH, maxFreqHz, logX } = opts;
    const vis = visibleLayers();
    let yMin = 0, yMax = -120;
    const series = [];
    const minF = 60;
    vis.forEach((layer) => {
      const sp = layer.analysis;
      const points = [];
      const nPts = Math.floor(plotW);
      for (let i = 0; i < nPts; i++) {
        let freq;
        if (logX) {
          const t = i / (nPts - 1 || 1);
          freq = minF * Math.pow(maxFreqHz / minF, t);
        } else {
          freq = (i / (nPts - 1 || 1)) * maxFreqHz;
        }
        const bin = binForFreq(sp, freq);
        const db = sp.meanDb[bin];
        points.push({ x: i / (nPts - 1 || 1), y: db });
        if (db > yMax) yMax = db;
        if (db < yMin) yMin = db;
      }
      series.push({ color: layer.color, opacity: layer.opacity, points });
    });
    if (yMax - yMin < 10) { yMin = yMax - 40; }
    yMin = Math.max(yMin, yMax - 70);

    // Peak markers: find local maxima on each mean spectrum (helps see harmonic shift)
    drawLineChart({
      leftPad, topPad, plotW, plotH,
      title: 'Mean spectrum (dB) — peaks should slide when pitch shifts',
      yMin, yMax,
      yLabelFn: (v) => v.toFixed(0),
      xLabel: (frac) => {
        const f = logX ? minF * Math.pow(maxFreqHz / minF, frac) : frac * maxFreqHz;
        return f >= 1000 ? (f/1000).toFixed(1)+'k' : String(Math.round(f));
      },
      series
    });

    // Annotate top peaks per layer
    vis.forEach((layer, li) => {
      const sp = layer.analysis;
      const peaks = [];
      const fMinBin = binForFreq(sp, minF);
      const fMaxBin = binForFreq(sp, maxFreqHz);
      for (let k = fMinBin + 2; k < fMaxBin - 2; k++) {
        const db = sp.meanDb[k];
        if (db > sp.meanDb[k-1] && db > sp.meanDb[k+1] && db > sp.meanDb[k-2] && db > sp.meanDb[k+2]) {
          peaks.push({ bin: k, db, freq: k * sp.sampleRate / sp.fftSize });
        }
      }
      peaks.sort((a, b) => b.db - a.db);
      const top = peaks.slice(0, 4);
      ctx.fillStyle = layer.color; ctx.globalAlpha = 0.9;
      ctx.font = '10px Segoe UI, Arial, sans-serif';
      top.forEach((p, pi) => {
        let xFrac;
        if (logX) xFrac = Math.log(Math.max(minF, p.freq) / minF) / Math.log(maxFreqHz / minF);
        else xFrac = p.freq / maxFreqHz;
        const x = leftPad + Math.max(0, Math.min(1, xFrac)) * plotW;
        const y = topPad + plotH * (1 - (p.db - yMin) / (yMax - yMin || 1));
        ctx.beginPath(); ctx.arc(x, y, 3, 0, Math.PI * 2); ctx.fill();
        if (pi < 3) ctx.fillText(Math.round(p.freq) + 'Hz', x + 4, y - 4 - li * 10);
      });
      ctx.globalAlpha = 1;
    });
  }

  function drawCentroid(opts){
    const { leftPad, topPad, plotW, plotH, maxDuration, maxFreqHz } = opts;
    const vis = visibleLayers();
    const series = vis.map((layer) => {
      const sp = layer.analysis;
      const shift = layerShiftSec(layer);
      const points = [];
      for (let f = 0; f < sp.frames; f++) {
        const t = f * sp.hopSize / sp.sampleRate + shift;
        const x = t / maxDuration;
        if (x < -0.02 || x > 1.02) continue;
        points.push({ x: Math.max(0, Math.min(1, x)), y: sp.centroid[f] > 0 ? sp.centroid[f] : null });
      }
      return { color: layer.color, opacity: layer.opacity, points };
    });
    drawLineChart({
      leftPad, topPad, plotW, plotH,
      title: 'Spectral centroid (Hz) over time',
      yMin: 0, yMax: Math.min(maxFreqHz, 6000),
      yLabelFn: (v) => v >= 1000 ? (v/1000).toFixed(1)+'k' : String(Math.round(v)),
      xLabel: (frac) => (frac * maxDuration).toFixed(1) + 's',
      series
    });
  }

  function drawPitch(opts){
    const { leftPad, topPad, plotW, plotH, maxDuration } = opts;
    const vis = visibleLayers();
    let yMax = 200;
    const series = vis.map((layer) => {
      const sp = layer.analysis;
      const shift = layerShiftSec(layer);
      const points = [];
      for (let f = 0; f < sp.f0.length; f++) {
        const t = f * sp.f0HopSec + shift;
        const x = t / maxDuration;
        if (x < -0.02 || x > 1.02) continue;
        const hz = sp.f0[f];
        if (hz > yMax) yMax = hz;
        points.push({ x: Math.max(0, Math.min(1, x)), y: hz > 0 ? hz : null });
      }
      return { color: layer.color, opacity: layer.opacity, points };
    });
    yMax = Math.min(800, Math.max(200, yMax * 1.2));
    drawLineChart({
      leftPad, topPad, plotW, plotH,
      title: 'Estimated F0 (Hz) — monophonic notes; ignore wild jumps on chords',
      yMin: 60, yMax,
      yLabelFn: (v) => String(Math.round(v)),
      xLabel: (frac) => (frac * maxDuration).toFixed(1) + 's',
      series
    });
  }

  function drawWaveform(opts){
    const { leftPad, topPad, plotW, plotH, maxDuration } = opts;
    const vis = visibleLayers();
    ctx.strokeStyle = '#444'; ctx.fillStyle = '#9a9a9a';
    ctx.font = '11px Segoe UI, Arial, sans-serif';
    ctx.beginPath();
    ctx.moveTo(leftPad, topPad); ctx.lineTo(leftPad, topPad + plotH); ctx.lineTo(leftPad + plotW, topPad + plotH);
    ctx.stroke();
    const mid = topPad + plotH / 2;
    ctx.strokeStyle = '#333';
    ctx.beginPath(); ctx.moveTo(leftPad, mid); ctx.lineTo(leftPad + plotW, mid); ctx.stroke();

    vis.forEach((layer) => {
      const sp = layer.analysis;
      const shift = layerShiftSec(layer);
      ctx.strokeStyle = layer.color; ctx.globalAlpha = layer.opacity; ctx.lineWidth = 1.5;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < sp.envelope.length; i++) {
        const t = i * sp.envHopSec + shift;
        if (t < 0 || t > maxDuration) continue;
        const x = leftPad + (t / maxDuration) * plotW;
        const amp = Math.min(1, sp.envelope[i]);
        const y = mid - amp * (plotH * 0.45);
        if (!started) { ctx.moveTo(x, y); started = true; }
        else ctx.lineTo(x, y);
      }
      // mirror
      for (let i = sp.envelope.length - 1; i >= 0; i--) {
        const t = i * sp.envHopSec + shift;
        if (t < 0 || t > maxDuration) continue;
        const x = leftPad + (t / maxDuration) * plotW;
        const amp = Math.min(1, sp.envelope[i]);
        const y = mid + amp * (plotH * 0.45);
        ctx.lineTo(x, y);
      }
      if (started) {
        ctx.closePath();
        ctx.globalAlpha = layer.opacity * 0.25;
        ctx.fillStyle = layer.color;
        ctx.fill();
        ctx.globalAlpha = layer.opacity;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    });
    ctx.fillStyle = '#9a9a9a';
    for (let i = 0; i <= 4; i++) {
      const frac = i / 4;
      const x = leftPad + plotW * frac;
      ctx.fillText((frac * maxDuration).toFixed(1) + 's', x - 8, topPad + plotH + 16);
    }
    ctx.fillText('Amplitude envelope', leftPad, topPad - 6);
  }

  function redraw(){
    if (rendering) return;
    rendering = true;
    try {
      const view = currentView();
      updateHelp();
      const cssH = (view === 'side') ? 400 : 420;
      const { cssW } = layoutCanvas(cssH);

      if (!layers.length) {
        ctx.fillStyle = '#666'; ctx.font = '14px Segoe UI, Arial, sans-serif';
        ctx.fillText('Add renders with +Spec — try “Mean spectrum” to see pitch shifts clearly', 16, 32);
        setStatus('');
        return;
      }

      const maxFreqHz = Number(maxFreqRange ? maxFreqRange.value : 8000);
      if (maxFreqLabel) maxFreqLabel.textContent = maxFreqHz + ' Hz';

      let maxDuration = 0;
      layers.forEach((l) => {
        if (!l.analysis) return;
        // Include time-shift so delayed layers still fit on the axis.
        const shift = layerShiftSec(l);
        maxDuration = Math.max(maxDuration, l.analysis.duration + Math.max(0, shift), l.analysis.duration - Math.min(0, shift));
      });
      if (maxDuration <= 0) maxDuration = 1;

      const leftPad = 52, bottomPad = 28, topPad = 22;
      const plotW = cssW - leftPad - 12;
      const plotH = cssH - bottomPad - topPad;
      const common = { leftPad, topPad, plotW, plotH, maxDuration, maxFreqHz, cssW, logScale: true };

      if (view === 'spectrum') {
        drawMeanSpectrum({ leftPad, topPad, plotW, plotH, maxFreqHz, logX: true });
        setStatus(visibleLayers().length + ' layer(s) · mean spectrum (log Hz) — harmonic peaks should shift with transpose');
      } else if (view === 'logspec') {
        drawSpectrogramOverlay({ ...common, logScale: true });
        setStatus(visibleLayers().length + ' layer(s) · log-frequency spectrogram');
      } else if (view === 'linspec') {
        drawSpectrogramOverlay({ ...common, logScale: false });
        setStatus(visibleLayers().length + ' layer(s) · linear spectrogram (often looks similar)');
      } else if (view === 'diff') {
        drawDifference(common);
        setStatus('Difference of first two visible layers (peak-normalized per frame)');
      } else if (view === 'side') {
        drawSideBySide(common);
        setStatus('Side-by-side log spectrograms');
      } else if (view === 'centroid') {
        drawCentroid(common);
        setStatus('Spectral centroid over time');
      } else if (view === 'pitch') {
        drawPitch(common);
        setStatus('F0 pitch track (autocorrelation)');
      } else if (view === 'waveform') {
        drawWaveform(common);
        setStatus('Amplitude envelopes');
      }
    } finally {
      rendering = false;
    }
  }

  async function analyzeBuffer(buffer, label){
    const fftSize = Number(fftSelect ? fftSelect.value : 2048);
    const hopSize = Number(hopSelect ? hopSelect.value : 512);
    setStatus('Analysing ' + label + '…');
    await new Promise((r) => setTimeout(r, 10));
    const mono = monoFromBuffer(buffer);
    return computeAnalysis(mono, buffer.sampleRate, fftSize, hopSize);
  }

  async function addLayerFromCell(cell){
    const src = cell.dataset.src;
    const label = cell.dataset.label || src;
    if (!src) return;
    if (layers.some((l) => l.src === src)) {
      setStatus('Already in comparison: ' + label);
      return;
    }
    try {
      if (audioCtx.state === 'suspended') await audioCtx.resume();
      const buffer = await loadAudio(src);
      const analysis = await analyzeBuffer(buffer, label);
      layers.push({
        id: ++layerSeq, src, label,
        color: nextColor(),
        opacity: layers.length === 0 ? 1.0 : 0.85,
        timeShiftMs: 0,
        analysis
      });
      rebuildLayerList();
      scheduleRedraw();
      setStatus('Added: ' + label);
      const panel = document.getElementById('spectrogram-panel');
      if (panel && layers.length === 1) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      console.error(err);
      setStatus('Failed to load/render: ' + (err && err.message ? err.message : err));
    }
  }

  async function recomputeAll(){
    if (!layers.length) { scheduleRedraw(); return; }
    setStatus('Recomputing ' + layers.length + ' analysis…');
    for (const layer of layers) {
      try {
        const buffer = await loadAudio(layer.src);
        layer.analysis = await analyzeBuffer(buffer, layer.label);
      } catch (err) {
        console.error(err);
        setStatus('Failed recomputing ' + layer.label);
      }
    }
    scheduleRedraw();
  }

  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('.add-spec');
    if (!btn) return;
    if (btn.disabled || isFileProtocol) {
      setStatus('Open this report via HTTP to use analysis views (see yellow banner).');
      if (fileBanner) fileBanner.classList.add('show');
      return;
    }
    const cell = btn.closest('.audio-cell');
    if (!cell) return;
    const src = cell.dataset.src;
    const existing = layers.findIndex((l) => l.src === src);
    if (existing >= 0) {
      layers.splice(existing, 1);
      rebuildLayerList(); scheduleRedraw();
      setStatus('Removed from comparison');
      return;
    }
    addLayerFromCell(cell);
  });

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      layers.splice(0, layers.length);
      rebuildLayerList(); scheduleRedraw(); setStatus('Cleared');
    });
  }
  if (fftSelect) fftSelect.addEventListener('change', recomputeAll);
  if (hopSelect) hopSelect.addEventListener('change', recomputeAll);
  if (viewSelect) viewSelect.addEventListener('change', () => { updateHelp(); scheduleRedraw(); });
  if (maxFreqRange) {
    maxFreqRange.addEventListener('input', () => {
      if (maxFreqLabel) maxFreqLabel.textContent = maxFreqRange.value + ' Hz';
      scheduleRedraw();
    });
  }

  window.addEventListener('resize', scheduleRedraw);
  updateHelp();
  rebuildLayerList();
  scheduleRedraw();
})();
""".strip()


def build_report(snapshots: list[dict], output_root: Path) -> str:
    # Collect union sets across snapshots for stable table/filter ordering.
    effects = set()
    samples = set()
    semitones = set()
    labels = []
    seen_labels = set()

    for snap in snapshots:
        label_raw = str(snap.get("snapshot", snap["_dir"]))
        if label_raw not in seen_labels:
            seen_labels.add(label_raw)
            labels.append(label_raw)

        for plugin in snap.get("externalPlugins", []):
            if not isinstance(plugin, dict):
                continue
            plugin_label = plugin.get("pluginLabel")
            if isinstance(plugin_label, str) and plugin_label:
                effects.add(plugin_label)

        for entry in snap.get("passes", []):
            effect_label = entry.get("effectLabel")
            sample = entry.get("sample")
            semitone = entry.get("semitones")
            if isinstance(effect_label, str):
                effects.add(effect_label)
            if isinstance(sample, str):
                samples.add(sample)
            if isinstance(semitone, int):
                semitones.add(semitone)

    effect_labels = sorted(effects)
    sample_names = sorted(samples)
    semitone_values = sorted(semitones)

    by_snapshot: list[dict[tuple, dict]] = []
    for snap in snapshots:
        index: dict[tuple, dict] = {}
        for entry in snap.get("passes", []):
            effect_label = entry.get("effectLabel")
            sample = entry.get("sample")
            semitone = entry.get("semitones")
            if isinstance(effect_label, str) and isinstance(sample, str) and isinstance(semitone, int):
                index[(sample, semitone, effect_label)] = entry
        by_snapshot.append(index)

    parts: list[str] = []
    parts.append("<!DOCTYPE html><html><head><meta charset='utf-8'>")
    parts.append("<title>Transpose Benchmark Report</title>")
    parts.append(f"<style>{report_styles()}</style></head><body>")
    parts.append("<h1>Transpose Benchmark Report</h1>")

    snap_labels = [html.escape(str(s.get("snapshot", s["_dir"]))) for s in snapshots]
    parts.append("<p class='meta'>Snapshots: " + ", ".join(
        f"{label} (generated {html.escape(str(s.get('generatedAt', '?')))})"
        for label, s in zip(snap_labels, snapshots)) + "</p>")
    parts.append(
        "<p class='meta'>Renders are latency-compensated using each effect's "
        "<em>reported</em> latency. 'meas' latency comes from envelope "
        "cross-correlation; a large reported/measured delta indicates a PDC "
        "reporting bug. rtf = realtime factor (audio time / processing time, "
        "higher is better). Use the copy icon next to any sample to copy its "
        "file path; use <strong>+Spec</strong> to overlay spectrograms above.</p>")

    # ----- Spectrogram comparison panel -----
    parts.append("<section id='spectrogram-panel' class='spec-panel'>")
    parts.append("<h2>Spectrogram comparison</h2>")
    parts.append(
        "<div id='fileProtocolBanner' class='spec-banner' role='alert'>"
        "<div class='title'>Spectrogram needs HTTP (file:// is blocked by the browser)</div>"
        "Browsers refuse to <code>fetch()</code> local WAV files when the report is opened "
        "as a <code>file://</code> path (CORS). Audio players still work; spectrogram "
        "overlays do not.<br>"
        "From the repo root run:<br>"
        "<code>python tools/transpose-benchmark/generate_report.py transpose-benchmark-out --serve</code>"
        "<br>or:<br>"
        "<code>cd transpose-benchmark-out &amp;&amp; python -m http.server 8765</code>"
        " then open <code>http://127.0.0.1:8765/report.html</code>"
        "</div>")
    parts.append(
        "<p class='meta'>Add any render with <strong>+Spec</strong>. Linear spectrograms of "
        "broadband guitar often look alike even when pitch differs — use "
        "<strong>Mean spectrum</strong> or <strong>Difference</strong> to see transpose. "
        "Serve the report over HTTP so the browser can load WAVs.</p>")
    parts.append("<div class='spec-toolbar'>")
    parts.append("<button type='button' id='specClear'>Clear all</button>")
    parts.append("<label>View <select id='specView'>")
    view_opts = [
        ("spectrum", "Mean spectrum (best for pitch)"),
        ("diff", "Difference A−B"),
        ("logspec", "Log spectrogram overlay"),
        ("side", "Side-by-side log specs"),
        ("centroid", "Spectral centroid"),
        ("pitch", "F0 pitch track"),
        ("waveform", "Waveform envelope"),
        ("linspec", "Linear spectrogram"),
    ]
    for value, label in view_opts:
        parts.append(f"<option value='{value}'>{html.escape(label)}</option>")
    parts.append("</select></label>")
    parts.append("<label>FFT size <select id='specFft'>")
    for n in (1024, 2048, 4096):
        sel = " selected" if n == 2048 else ""
        parts.append(f"<option value='{n}'{sel}>{n}</option>")
    parts.append("</select></label>")
    parts.append("<label>Hop <select id='specHop'>")
    for n in (256, 512, 1024):
        sel = " selected" if n == 512 else ""
        parts.append(f"<option value='{n}'{sel}>{n}</option>")
    parts.append("</select></label>")
    parts.append(
        "<label>Max freq <input type='range' id='specMaxFreq' min='1000' max='16000' "
        "step='250' value='5000'> <span id='specMaxFreqLabel'>5000 Hz</span></label>")
    parts.append("</div>")
    parts.append("<p class='spec-help' id='specHelp'></p>")
    parts.append("<div class='spec-layers' id='specLayers'></div>")
    parts.append("<div id='specCanvasWrap'><canvas id='specCanvas'></canvas></div>")
    parts.append("<div class='spec-status' id='specStatus'></div>")
    parts.append("</section>")

    # ----- Filters -----
    parts.append("<div class='filters'>")
    parts.append("<label for='labelFilter'>Result label: </label>")
    parts.append("<select id='labelFilter'><option value=''>All</option>")
    for label in labels:
        parts.append(
            f"<option value='{html.escape(label)}'>{html.escape(label)}</option>")
    parts.append("</select>")
    parts.append("<label for='sampleFilter'>Demo audio: </label>")
    parts.append("<select id='sampleFilter'><option value=''>All</option>")
    for sample in sample_names:
        parts.append(
            f"<option value='{html.escape(sample)}'>{html.escape(sample)}</option>")
    parts.append("</select>")
    parts.append("<label for='effectFilter'>Transpose variant: </label>")
    parts.append("<select id='effectFilter'><option value=''>All</option>")
    for effect in effect_labels:
        parts.append(
            f"<option value='{html.escape(effect)}'>{html.escape(effect)}</option>")
    parts.append("</select>")
    parts.append("</div>")

    # Dry references from the first snapshot that has them.
    for snap, label in zip(snapshots, snap_labels):
        refs = snap.get("references", [])
        if refs:
            parts.append(f"<h2>Dry references ({label})</h2><table>")
            parts.append("<tr><th>Sample</th><th>Sample rate</th><th>Audio</th></tr>")
            for ref in refs:
                rel = f"{snap['_dir']}/{ref['wav']}"
                abs_path = str((output_root / snap["_dir"] / ref["wav"]).resolve())
                sample_name = str(ref.get("sample", ref["wav"]))
                label_text = f"Dry · {sample_name}"
                parts.append(
                    "<tr><td>" + html.escape(sample_name) + "</td>"
                    f"<td>{ref['sampleRate']:.0f} Hz</td>"
                    f"<td>{audio_controls_html(rel_src=rel, abs_path=abs_path, label=label_text)}</td></tr>")
            parts.append("</table>")
            break

    for snap, passes in zip(snapshots, by_snapshot):
        label_raw = str(snap.get("snapshot", snap["_dir"]))
        label = html.escape(label_raw)
        for sample in sample_names:
            has_data = any((sample, semitone, effect) in passes
                           for semitone in semitone_values
                           for effect in effect_labels)
            if not has_data:
                continue

            parts.append(
                f"<section class='result-section' data-label='{html.escape(label_raw)}' "
                f"data-sample='{html.escape(sample)}'>")
            parts.append(f"<h2>{label} — {html.escape(sample)}</h2><table>")

            header = "<tr><th>Semitones</th>"
            for effect in effect_labels:
                header += (
                    f"<th data-effect='{html.escape(effect)}'>{html.escape(effect)}<br>"
                    "<span class='meta'>latency rep/meas · rtf · avg/max block · peak/RMS · "
                    "pitch err±jitter</span></th>")
            header += "</tr>"
            parts.append(header)

            for semitone in semitone_values:
                row = [f"<tr><td class='stat'>{semitone:+d} st</td>"]
                for effect in effect_labels:
                    entry = passes.get((sample, semitone, effect))
                    if entry is None:
                        row.append(f"<td class='meta' data-effect='{html.escape(effect)}'>not in results</td>")
                        continue

                    delta = entry.get("latencyDeltaSamples")
                    delta_class = "good"
                    if delta is None:
                        delta_text = ""
                    else:
                        threshold = max(64, abs(int(entry.get("reportedLatencySamples", 0))) // 10)
                        if abs(int(delta)) > threshold:
                            delta_class = "warn"
                        delta_text = f" (Δ {int(delta):+d})"

                    audio_src = entry_audio_src(snap["_dir"], entry)
                    abs_path = entry_abs_path(output_root, snap["_dir"], entry) or ""
                    audio_tag = ""
                    if audio_src:
                        st_label = f"{semitone:+d}" if semitone != 0 else "0"
                        layer_label = f"{effect} · {st_label} st · {sample} · {label_raw}"
                        audio_tag = audio_controls_html(
                            rel_src=audio_src,
                            abs_path=abs_path or audio_src,
                            label=layer_label,
                        )

                    rtf = entry.get("realtimeFactor")
                    avg_block = entry.get("avgBlockUs")
                    max_block = entry.get("maxBlockUs")
                    peak_db = entry.get("peakDb")
                    rms_db = entry.get("rmsDb")

                    def fmt_num(value, precision=1):
                        if value is None:
                            return "n/a"
                        return f"{float(value):.{precision}f}"

                    # Pitch accuracy: median cents error of the output fundamental
                    # against the requested interval. A shifter can look perfect on
                    # latency and CPU while not actually transposing, so flag hard.
                    pitch_err = entry.get("pitchErrorCents")
                    pitch_jitter = entry.get("pitchJitterCents")
                    pitch_frames = entry.get("pitchFrames")
                    if pitch_err is None:
                        pitch_html = "<div class='stat meta'>pitch n/a</div>"
                    else:
                        err = float(pitch_err)
                        # 25 cents is well past "in tune" but below a quarter tone;
                        # anything above it is an audible tuning error, not artifact.
                        pitch_class = "good" if abs(err) <= 25.0 else "warn"
                        frames_text = f" · {int(pitch_frames)} fr" if pitch_frames else ""
                        pitch_html = (
                            f"<div class='stat'>pitch <span class='{pitch_class}'>"
                            f"{err:+.1f}</span> ± {fmt_num(pitch_jitter)} cents"
                            f"<span class='meta'>{frames_text}</span></div>")

                    cell = (
                        f"<div class='stat'>lat {fmt_samples(entry.get('reportedLatencySamples'))} / "
                        f"{fmt_samples(entry.get('measuredLatencySamples'))} smp"
                        f"<span class='{delta_class}'>{delta_text}</span></div>"
                        f"<div class='stat'>{fmt_ms(entry.get('reportedLatencyMs'))} / "
                        f"{fmt_ms(entry.get('measuredLatencyMs'))}</div>"
                        f"<div class='stat'>rtf {fmt_num(rtf)}x · "
                        f"blk {fmt_num(avg_block, 0)}/{fmt_num(max_block, 0)} µs</div>"
                        f"<div class='stat'>peak {fmt_num(peak_db)} dB · "
                        f"rms {fmt_num(rms_db)} dB</div>"
                        f"{pitch_html}"
                        f"{audio_tag}")
                    row.append(f"<td data-effect='{html.escape(effect)}'>{cell}</td>")
                row.append("</tr>")
                parts.append("".join(row))

            parts.append("</table></section>")

    parts.append(f"<script>\n{report_script()}\n</script>")
    parts.append("</body></html>")
    return "".join(parts)


def serve_report(output_root: Path, port: int, open_browser: bool) -> int:
    """Serve output_root over HTTP so the report can fetch WAVs for spectrograms."""
    root = output_root.resolve()
    report = root / "report.html"
    if not report.is_file():
        print(f"ERROR: {report} not found — generate the report first", file=sys.stderr)
        return 1

    class ReportHandler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(root), **kwargs)

        def log_message(self, fmt, *args):  # noqa: A003
            sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))

        def end_headers(self):
            # Allow audio decoding from the same origin without cache surprises.
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Access-Control-Allow-Origin", "*")
            super().end_headers()

    try:
        server = ThreadingHTTPServer(("127.0.0.1", port), ReportHandler)
    except OSError as exc:
        print(f"ERROR: cannot bind 127.0.0.1:{port}: {exc}", file=sys.stderr)
        return 1

    url = f"http://127.0.0.1:{port}/report.html"
    print(f"Serving {root}")
    print(f"Open: {url}")
    print("Press Ctrl+C to stop.")

    if open_browser:
        # Delay slightly so the socket is listening before the browser hits it.
        threading.Timer(0.35, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    finally:
        server.server_close()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output_root", type=Path,
                        help="Benchmark output root containing <snapshot>/results.json dirs")
    parser.add_argument("-o", "--output", type=Path, default=None,
                        help="Report path (default: <output_root>/report.html)")
    parser.add_argument("--serve", action="store_true",
                        help="After writing the report, serve output_root over HTTP and open it "
                             "(required for spectrogram overlays; file:// is blocked by browsers)")
    parser.add_argument("--port", type=int, default=8765,
                        help="Port for --serve (default: 8765)")
    parser.add_argument("--no-open", action="store_true",
                        help="With --serve, do not open a browser window")
    args = parser.parse_args()

    if not args.output_root.is_dir():
        print(f"ERROR: not a directory: {args.output_root}", file=sys.stderr)
        return 1

    snapshots = load_snapshots(args.output_root)
    if not snapshots:
        print(f"ERROR: no <snapshot>/results.json found under {args.output_root}", file=sys.stderr)
        return 1

    report_path = args.output or (args.output_root / "report.html")
    report_path.write_text(
        build_report(snapshots, args.output_root.resolve()),
        encoding="utf-8",
    )
    print(f"Wrote {report_path} ({len(snapshots)} snapshot(s))")

    if args.serve:
        # Brief pause so the write is fully flushed before the browser loads.
        time.sleep(0.05)
        return serve_report(args.output_root, args.port, open_browser=not args.no_open)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
