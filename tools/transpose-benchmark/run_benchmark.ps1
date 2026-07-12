<#
.SYNOPSIS
    Build and run the full transpose benchmark pipeline.

.DESCRIPTION
    1. Builds the TransposeBenchmark executable (unless -NoBuild is passed).
    2. Runs TransposeBenchmark to produce native-effect passes (results.json + WAVs).
    3. Auto-renders external plugin passes from external-plugins.json
       (skipped with -NoAutoRender). Prefers TransposeExternalRender.exe
       (JUCE host; supports parameterOverrides for Archetype/HyperTune Metal);
       falls back to render_external_passes.py via pedalboard when the C++
       tool is not available.
    4. Processes any external-plugin render manifests found in
       tools/transpose-benchmark/external-renders/*.json by running
       build_external_passes.py for each one.
    5. Generates an HTML report via generate_report.py.
    6. Optionally opens the report in the default browser.

    External auto-render prefers TransposeExternalRender.exe when present.
    Pedalboard is only used as a fallback (and may be auto-installed). Manual
    render manifests can still be supplied via external-renders/.

.PARAMETER BuildConfig
    CMake build configuration: Debug or Release. Default: Release.

.PARAMETER CoreBuildDir
    Path to the configured CMake build directory for the core project.
    Default: core/build (relative to repo root).

.PARAMETER OutputRoot
    Root directory for benchmark output snapshots.
    Default: transpose-benchmark-out (relative to repo root).

.PARAMETER SnapshotLabel
    Label for this benchmark run. Used as the snapshot sub-directory name.
    Default: snapshot-<UTC-timestamp> (chosen by the benchmark binary).

.PARAMETER AllDemoAudio
    Pass --all-demo-audio to the benchmark so all three demo samples are
    rendered instead of only the first.

.PARAMETER NoBuild
    Skip the CMake build step. Useful when the binary is already up to date.

.PARAMETER NoAutoRender
    Skip the automated external-plugin render step (render_external_passes.py).
    Useful when you have pre-rendered WAVs in external-renders/ and do not want
    to re-run pedalboard-based rendering.

.PARAMETER OpenReport
    Serve the report over HTTP (required for spectrogram overlays) and open
    it in the default browser. Browsers block WAV fetch under file://.

.EXAMPLE
    # Quick run with Release binary, one demo sample
    .\tools\transpose-benchmark\run_benchmark.ps1

.EXAMPLE
    # Full run with all demo samples, open result in browser
    .\tools\transpose-benchmark\run_benchmark.ps1 -AllDemoAudio -OpenReport

.EXAMPLE
    # Skip rebuild, use an existing Debug binary, custom output location
    .\tools\transpose-benchmark\run_benchmark.ps1 -NoBuild -BuildConfig Debug -OutputRoot C:\bench-out
#>

[CmdletBinding()]
param(
    [ValidateSet("Debug", "Release")]
    [string]$BuildConfig = "Release",

    [string]$CoreBuildDir = "",

    [string]$OutputRoot = "",

    [string]$SnapshotLabel = "",

    [switch]$AllDemoAudio,

    [switch]$NoBuild,

    [switch]$NoAutoRender,

    [switch]$OpenReport
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Resolve repo root (script lives at tools/transpose-benchmark/run_benchmark.ps1)
# ---------------------------------------------------------------------------
$ScriptDir  = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot   = (Resolve-Path (Join-Path (Join-Path $ScriptDir "..") "..")).Path
$ToolsDir   = $ScriptDir

if (-not $CoreBuildDir) { $CoreBuildDir = Join-Path (Join-Path $RepoRoot "core") "build" }
if (-not $OutputRoot)   { $OutputRoot   = Join-Path $RepoRoot "transpose-benchmark-out" }

$ExternalRendersDir  = Join-Path $ToolsDir "external-renders"
$CollectionJson      = Join-Path $ToolsDir "external-plugins.json"
$BuildExternalPy     = Join-Path $ToolsDir "build_external_passes.py"
$RenderExternalPy    = Join-Path $ToolsDir "render_external_passes.py"
$GenerateReportPy    = Join-Path $ToolsDir "generate_report.py"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
function Write-Step([string]$msg) {
    Write-Host ""
    Write-Host "==> $msg" -ForegroundColor Cyan
}

function Invoke-Checked([string]$description, [scriptblock]$block) {
    Write-Host "    $description" -ForegroundColor DarkGray
    & $block
    if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
        Write-Host "ERROR: '$description' failed (exit $LASTEXITCODE)" -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

function Find-Python {
    foreach ($candidate in @("python", "python3", "py")) {
        try {
            $ver = & $candidate --version 2>&1
            if ($LASTEXITCODE -eq 0 -and $ver -match "Python 3") { return $candidate }
        } catch { }
    }
    return $null
}

function Ensure-PythonModule([string]$PythonCmd, [string]$ModuleName) {
    & $PythonCmd -c "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('$ModuleName') else 1)" *> $null
    if ($LASTEXITCODE -eq 0) { return $true }

    Write-Host "    Installing missing Python module: $ModuleName" -ForegroundColor DarkGray
    & $PythonCmd -m pip install $ModuleName
    if ($LASTEXITCODE -ne 0) {
        Write-Host "    WARN: pip install failed for '$ModuleName'" -ForegroundColor Yellow
        return $false
    }

    & $PythonCmd -c "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('$ModuleName') else 1)" *> $null
    return ($LASTEXITCODE -eq 0)
}

# ---------------------------------------------------------------------------
# 1. Build
# ---------------------------------------------------------------------------
Write-Step "Build TransposeBenchmark ($BuildConfig)"

if ($NoBuild) {
    Write-Host "    Skipping build (-NoBuild)." -ForegroundColor Yellow
} else {
    if (-not (Test-Path $CoreBuildDir)) {
        Write-Host "ERROR: Core build directory not found: $CoreBuildDir" -ForegroundColor Red
        Write-Host "       Configure the project first:  cmake -S core -B core/build" -ForegroundColor Yellow
        exit 1
    }
    Invoke-Checked "cmake --build $CoreBuildDir --config $BuildConfig --target TransposeBenchmark" {
        cmake --build $CoreBuildDir --config $BuildConfig --target TransposeBenchmark
    }
}

# ---------------------------------------------------------------------------
# 2. Locate the benchmark binary
# ---------------------------------------------------------------------------
$binarySearchPaths = @(
    # MSVC multi-config layout with tests/ subdirectory (core/build/tests/<Config>/)
    (Join-Path (Join-Path (Join-Path $CoreBuildDir "tests") $BuildConfig) "TransposeBenchmark.exe"),
    # MSVC multi-config layout without tests/ subdirectory (core/build/<Config>/)
    (Join-Path (Join-Path $CoreBuildDir $BuildConfig) "TransposeBenchmark.exe"),
    # Unix/Ninja single-config layout
    (Join-Path $CoreBuildDir "TransposeBenchmark.exe"),
    (Join-Path $CoreBuildDir "TransposeBenchmark")
)
$BenchmarkBin = $null
foreach ($p in $binarySearchPaths) {
    if (Test-Path $p) { $BenchmarkBin = $p; break }
}
if (-not $BenchmarkBin) {
    Write-Host "ERROR: TransposeBenchmark binary not found under $CoreBuildDir" -ForegroundColor Red
    Write-Host "       Searched:" -ForegroundColor Yellow
    $binarySearchPaths | ForEach-Object { Write-Host "         $_" -ForegroundColor Yellow }
    exit 1
}
Write-Host "    Binary: $BenchmarkBin" -ForegroundColor DarkGray

# ---------------------------------------------------------------------------
# 3. Run the C++ benchmark
# ---------------------------------------------------------------------------
Write-Step "Run TransposeBenchmark"

$benchArgs = @($OutputRoot)
if ($SnapshotLabel) { $benchArgs += $SnapshotLabel }
if ($AllDemoAudio)  { $benchArgs = @("--all-demo-audio") + $benchArgs }

Write-Host "    $BenchmarkBin $benchArgs" -ForegroundColor DarkGray
& $BenchmarkBin @benchArgs
if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
    Write-Host "ERROR: TransposeBenchmark exited with code $LASTEXITCODE" -ForegroundColor Red
    exit $LASTEXITCODE
}

# ---------------------------------------------------------------------------
# 4. Find the snapshot directory that was just written
# ---------------------------------------------------------------------------
# The benchmark writes to <OutputRoot>/<snapshotLabel>/results.json.
# We find the most-recently-modified results.json under OutputRoot.
$latestResults = Get-ChildItem -Path $OutputRoot -Recurse -Filter "results.json" -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $latestResults) {
    Write-Host "ERROR: No results.json found under $OutputRoot after benchmark run." -ForegroundColor Red
    exit 1
}
$SnapshotDir = $latestResults.DirectoryName
Write-Host "    Snapshot: $SnapshotDir" -ForegroundColor DarkGray

# ---------------------------------------------------------------------------
# 5. Auto-render external plugin passes
#    Prefer TransposeExternalRender.exe (JUCE host) — it supports
#    parameterOverrides and loads plugins that hang under pedalboard
#    (e.g. HyperTune Metal). Fall back to pedalboard if the C++ tool is missing.
# ---------------------------------------------------------------------------
Write-Step "Auto-render external plugin passes"

$Python = Find-Python
if ($NoAutoRender) {
    Write-Host "    Skipping auto-render (-NoAutoRender)." -ForegroundColor Yellow
} else {
    $juceBuildDir = Join-Path (Join-Path $RepoRoot "juce") "builds"
    $externalRenderSearchPaths = @(
        (Join-Path (Join-Path $juceBuildDir $BuildConfig) "TransposeExternalRender.exe"),
        (Join-Path $juceBuildDir "TransposeExternalRender.exe"),
        (Join-Path $juceBuildDir "TransposeExternalRender")
    )
    $ExternalRenderBin = $null
    foreach ($p in $externalRenderSearchPaths) {
        if (Test-Path $p) { $ExternalRenderBin = $p; break }
    }

    if ($ExternalRenderBin) {
        Write-Host "    Using JUCE host: $ExternalRenderBin" -ForegroundColor DarkGray
        $renderArgs = @("--collection", $CollectionJson, $SnapshotDir)
        if ($AllDemoAudio) { $renderArgs = @("--all-demo-audio") + $renderArgs }
        Write-Host "    $ExternalRenderBin $renderArgs" -ForegroundColor DarkGray
        & $ExternalRenderBin @renderArgs
        if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
            Write-Host "    WARN: TransposeExternalRender exited with code $LASTEXITCODE" -ForegroundColor Yellow
        }
    } elseif (-not $Python) {
        Write-Host "    WARN: TransposeExternalRender not found and Python 3 missing -- skipping auto-render." -ForegroundColor Yellow
        Write-Host "    Build with: cmake --build juce/builds --config $BuildConfig --target TransposeExternalRender" -ForegroundColor Yellow
    } else {
        Write-Host "    TransposeExternalRender not found; falling back to pedalboard." -ForegroundColor Yellow
        Write-Host "    (Build the C++ tool for full parameterOverrides / HyperTune Metal support.)" -ForegroundColor Yellow
        $havePedalboard = Ensure-PythonModule $Python "pedalboard"
        if (-not $havePedalboard) {
            Write-Host "    WARN: pedalboard is unavailable; skipping auto-render." -ForegroundColor Yellow
        } else {
            $renderArgs = @($SnapshotDir, "--collection", $CollectionJson)
            if ($AllDemoAudio) { $renderArgs += "--all-demo-audio" }
            Write-Host "    $Python $RenderExternalPy $renderArgs" -ForegroundColor DarkGray
            & $Python $RenderExternalPy @renderArgs
            if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
                Write-Host "    WARN: render_external_passes.py exited with code $LASTEXITCODE" -ForegroundColor Yellow
                Write-Host "    If pedalboard is not installed: pip install pedalboard" -ForegroundColor Yellow
            }
        }
    }

    # Compute metrics for any auto-generated manifests in the snapshot dir.
    # C++ tool writes external-renders-<id>.json; pedalboard writes auto-manifest-<id>.json.
    if ($Python) {
        $autoManifests = @(
            Get-ChildItem -Path $SnapshotDir -Filter "auto-manifest-*.json" -ErrorAction SilentlyContinue
            Get-ChildItem -Path $SnapshotDir -Filter "external-renders-*.json" -ErrorAction SilentlyContinue
        )
        foreach ($am in $autoManifests) {
            Write-Host "    Computing metrics for: $($am.Name)" -ForegroundColor DarkGray
            $pyArgs = @($SnapshotDir, $am.FullName, "--collection", $CollectionJson)
            & $Python $BuildExternalPy @pyArgs
            if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
                Write-Host "    WARN: build_external_passes.py failed for $($am.Name) (exit $LASTEXITCODE)" -ForegroundColor Yellow
            }
        }
    } else {
        Write-Host "    WARN: Python 3 not found -- cannot compute external-pass metrics." -ForegroundColor Yellow
    }
}

# ---------------------------------------------------------------------------
# 6. Process manually-supplied external render manifests
# ---------------------------------------------------------------------------
Write-Step "Process manual external plugin passes"

if (-not $Python) {
    Write-Host "    WARN: Python 3 not found -- skipping external passes." -ForegroundColor Yellow
} elseif (-not (Test-Path $ExternalRendersDir)) {
    Write-Host "    No external-renders/ directory found -- skipping." -ForegroundColor DarkGray
    Write-Host "    To add manual external plugin results:" -ForegroundColor DarkGray
    Write-Host "      1. Render audio through each plugin (manually or via your DAW)." -ForegroundColor DarkGray
    Write-Host "      2. Create a manifest JSON (see external-renders.example.json)." -ForegroundColor DarkGray
    Write-Host "      3. Place it in: $ExternalRendersDir" -ForegroundColor DarkGray
} else {
    $manifests = @(Get-ChildItem -Path $ExternalRendersDir -Filter "*.json" -ErrorAction SilentlyContinue)
    if ($manifests.Count -eq 0) {
        Write-Host "    No manifest files in external-renders/ -- skipping." -ForegroundColor DarkGray
        Write-Host "    Drop render manifest JSONs into: $ExternalRendersDir" -ForegroundColor DarkGray
    } else {
        foreach ($manifest in $manifests) {
            Write-Host "    Processing manifest: $($manifest.Name)" -ForegroundColor DarkGray
            $pyArgs = @($SnapshotDir, $manifest.FullName, "--collection", $CollectionJson)
            & $Python $BuildExternalPy @pyArgs
            if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
                Write-Host "    WARN: build_external_passes.py failed for $($manifest.Name) (exit $LASTEXITCODE)" -ForegroundColor Yellow
            }
        }
    }
}

# ---------------------------------------------------------------------------
# 7. Generate HTML report
# ---------------------------------------------------------------------------
Write-Step "Generate HTML report"

if (-not $Python) {
    Write-Host "    WARN: Python 3 not found -- cannot generate report." -ForegroundColor Yellow
} else {
    $ReportPath = Join-Path $OutputRoot "report.html"
    Invoke-Checked "generate_report.py $OutputRoot" {
        & $Python $GenerateReportPy $OutputRoot -o $ReportPath
    }
    Write-Host ""
    Write-Host "Report written to: $ReportPath" -ForegroundColor Green
    Write-Host "    Spectrogram overlays need HTTP (file:// is blocked by browsers)." -ForegroundColor DarkGray
    Write-Host "    Serve with:  $Python $GenerateReportPy `"$OutputRoot`" --serve" -ForegroundColor DarkGray

    if ($OpenReport) {
        Write-Host "Serving report over HTTP and opening browser (Ctrl+C to stop)..." -ForegroundColor DarkGray
        & $Python $GenerateReportPy $OutputRoot --serve
    }
}

Write-Host ""
Write-Host "Done." -ForegroundColor Green
