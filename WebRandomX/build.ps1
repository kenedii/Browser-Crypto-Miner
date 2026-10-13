# Builds randomx.wasm for the browser miner on Windows (see README.md here).
#
#   .\build.ps1                 # light mode (default): 256 MiB cache, ~300 MiB/tab
#   .\build.ps1 -FullMem        # full memory mode: build the 2 GiB dataset, ~2.3 GiB/tab
#   .\build.ps1 -Ref v1.2.3     # pin a different RandomX tag
#   .\build.ps1 -SkipVerify     # build only, do not run verify_wasm.js
#
# Run `emsdk_env.ps1` (or `emsdk activate`) in this PowerShell session first, so
# that emcc/emcmake/cmake are on PATH. Build output stays untracked: the frontend
# image builds fine without randomx.wasm and simply reports the missing VM.
[CmdletBinding()]
param(
    [switch]$FullMem,
    [switch]$SkipVerify,
    [string]$Ref = 'v1.2.1',
    [string]$Repo = 'https://github.com/tevador/RandomX.git',
    [string]$Generator = '',
    [int]$Jobs = 0
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Say($m) { Write-Host "`n==> $m" }
function Die($m) { Write-Host "`nERROR: $m" -ForegroundColor Red; exit 1 }

Say 'Checking the toolchain'
foreach ($tool in 'git', 'emcmake', 'cmake') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Die "$tool not found - install emsdk, run emsdk_env.ps1, and retry.`n    git clone https://github.com/emscripten-core/emsdk`n    .\emsdk\emsdk install latest; .\emsdk\emsdk activate latest; .\emsdk\emsdk_env.ps1"
    }
}
& emcc --version | Select-Object -First 1

if (-not (Test-Path 'randomx\src\randomx.cpp')) {
    Say "Fetching RandomX ($Ref) into .\randomx"
    # Shallow tag clone (~10 MB); delete .\randomx to switch refs.
    & git clone --depth 1 --branch $Ref $Repo randomx
    if ($LASTEXITCODE -ne 0) { Die 'git clone failed' }
} else {
    Say 'Using the existing .\randomx checkout'
}

# A wasm build needs RandomX's floating point rounding modes implemented in
# software: WebAssembly rounds every operation to nearest, while RandomX's
# CFROUND instruction makes the mode part of consensus. The patch only changes
# code inside `#if defined(__wasm__)`, so it is inert for any other platform and
# is applied here so a fresh checkout builds a correct module. See README.md.
$patchFile = Join-Path $PSScriptRoot 'patches\randomx-wasm-soft-rounding.patch'
if (-not (Test-Path $patchFile)) { Die "the rounding patch is missing: $patchFile" }
# Select-String rather than `git apply --reverse --check`: git writes its "does
# not apply" diagnostics to stderr, and with $ErrorActionPreference = 'Stop' that
# aborts the script even when the answer is simply "this tree is not patched".
$alreadyPatched = [bool](Select-String -Path 'randomx\src\intrin_portable.h' -Pattern 'randomx_wasm_fp' -Quiet)
if ($alreadyPatched) {
    Say 'RandomX checkout already carries the wasm rounding patch'
} else {
    Say 'Applying the wasm rounding patch to the RandomX checkout'
    $prevPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    & git -C randomx apply --whitespace=nowarn $patchFile 2>&1 | Out-Null
    $applyRc = $LASTEXITCODE
    $ErrorActionPreference = $prevPreference
    if ($applyRc -ne 0) { Die "could not apply $patchFile - is .\randomx an unmodified RandomX checkout?" }
}

# CMake's default generator on Windows is Visual Studio / NMake, which needs an
# MSVC toolchain the emsdk environment does not ship, so a bare `emcmake cmake`
# fails on a machine without Visual Studio. Ninja (or make) is what Emscripten's
# own instructions use, so pick Ninja whenever it is on PATH.
if (-not $Generator) {
    if (Get-Command ninja -ErrorAction SilentlyContinue) { $Generator = 'Ninja' }
    elseif (Get-Command make -ErrorAction SilentlyContinue) { $Generator = 'Unix Makefiles' }
}
if ($Generator) { Say "Configuring with the $Generator generator" }

$cmakeArgs = @('-S', '.', '-B', 'build', '-DCMAKE_BUILD_TYPE=Release')
if ($Generator) { $cmakeArgs += @('-G', $Generator) }
if ($FullMem) {
    Say 'Configuring a full-memory build (the VM builds the 2 GiB dataset in rx_init)'
    $cmakeArgs += @('-DRX_FULL_MEM=ON', '-DRX_MAX_MEMORY_MB=3221225472')
} else {
    Say 'Configuring a light-mode build (256 MiB cache, no dataset)'
}

& emcmake cmake @cmakeArgs
if ($LASTEXITCODE -ne 0) { Die 'emcmake cmake failed' }

Say 'Compiling (this takes a few minutes; the interpreter is the slow part)'
if ($Jobs -gt 0) { & cmake --build build -j $Jobs } else { & cmake --build build }
if ($LASTEXITCODE -ne 0) { Die 'cmake --build failed' }

if (-not (Test-Path 'randomx.wasm')) { Die 'the build finished but randomx.wasm is missing' }
Say ("Built {0:N0} bytes -> WebRandomX\randomx.wasm" -f (Get-Item 'randomx.wasm').Length)

# The page fetches randomx.wasm next to its own URL, so keep a dev copy beside
# the served files. The Dockerfile packages web\randomx.wasm, so
# this copy only matters for a local static server.
Copy-Item 'randomx.wasm' '..\web\randomx.wasm' -Force
Say 'Copied to web\randomx.wasm (local dev; both are gitignored)'

if (-not $SkipVerify) {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die 'node is required for verify_wasm.js (or pass -SkipVerify)' }
    Say 'Verifying the module against randomx.js'
    & node verify_wasm.js
    if ($LASTEXITCODE -ne 0) { Die 'verify_wasm.js reported problems with the build' }
}

Say 'Done. Serve web\ and pick Monero (XMR) in the miner.'
