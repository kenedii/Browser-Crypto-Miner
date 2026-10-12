#!/usr/bin/env bash
# Builds randomx.wasm for the browser miner (see README.md in this directory).
#
#   ./build.sh                 # light mode (default): 256 MiB cache, ~300 MiB/tab
#   ./build.sh --full-mem      # full memory mode: build the 2 GiB dataset, ~2.3 GiB/tab
#   ./build.sh --ref v1.2.3    # pin a different RandomX tag
#   ./build.sh --skip-verify   # build only, do not run verify_wasm.js
#
# On Windows use build.ps1 from a PowerShell that has run emsdk_env.ps1; this
# script works in Git Bash / WSL / Linux / macOS with emsdk's env activated.
#
# The output is an untracked build artefact on purpose: the frontend deploys fine
# without it (the Monero worker then reports the missing VM rather than hashing
# without one), so a missing emscripten toolchain can never break a deploy.
set -euo pipefail

cd "$(dirname "$0")"

RANDOMX_REPO="${RANDOMX_REPO:-https://github.com/tevador/RandomX.git}"
# RandomX v1.2.1 is the algorithm Monero mainnet's rx/0 uses; newer tags only add
# features (v2 config, extra optimizations) the pool's seed_hash does not select.
RANDOMX_REF="${RANDOMX_REF:-v1.2.1}"
FULL_MEM=0
SKIP_VERIFY=0
JOBS=""

while [ $# -gt 0 ]; do
    case "$1" in
        --full-mem)     FULL_MEM=1 ;;
        --ref)          RANDOMX_REF="$2"; shift ;;
        --jobs)         JOBS="$2"; shift ;;
        --skip-verify)  SKIP_VERIFY=1 ;;
        -h|--help)      sed -n '2,17p' "$0"; exit 0 ;;
        *)              echo "unknown option: $1" >&2; exit 2 ;;
    esac
    shift
done

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

say "Checking the toolchain"
command -v git     >/dev/null || die "git is required to fetch RandomX"
command -v emcmake >/dev/null || die "emcmake not found - install emsdk and activate it:
    git clone https://github.com/emscripten-core/emsdk
    ./emsdk/emsdk install latest && ./emsdk/emsdk activate latest
    source ./emsdk/emsdk_env.sh"
command -v cmake   >/dev/null || die "cmake (>= 3.13) is required"
emcc --version | head -n 1

if [ ! -f randomx/src/randomx.cpp ]; then
    say "Fetching RandomX ($RANDOMX_REF) into ./randomx"
    # A shallow tag clone keeps this a ~10 MB download; delete ./randomx to switch refs.
    git clone --depth 1 --branch "$RANDOMX_REF" "$RANDOMX_REPO" randomx
else
    say "Using the existing ./randomx checkout ($(git -C randomx describe --tags --always 2>/dev/null || echo unknown))"
fi

# A wasm build needs RandomX's floating point rounding modes implemented in
# software: WebAssembly rounds every operation to nearest, while RandomX's
# CFROUND instruction makes the mode part of consensus. The patch only changes
# code inside `#if defined(__wasm__)`, so it is inert everywhere else.
PATCH="patches/randomx-wasm-soft-rounding.patch"
[ -f "$PATCH" ] || die "the rounding patch is missing: $PATCH"
if git -C randomx apply --reverse --check "$PATCH" >/dev/null 2>&1; then
    say "RandomX checkout already carries the wasm rounding patch"
else
    say "Applying the wasm rounding patch to the RandomX checkout"
    git -C randomx apply --whitespace=nowarn "$PATCH" ||
        die "could not apply $PATCH - is ./randomx an unmodified RandomX checkout?"
fi

CMAKE_ARGS=(-S . -B build -DCMAKE_BUILD_TYPE=Release)
if [ "$FULL_MEM" = "1" ]; then
    say "Configuring a full-memory build (the VM builds the 2 GiB dataset in rx_init)"
    CMAKE_ARGS+=(-DRX_FULL_MEM=ON -DRX_MAX_MEMORY_MB=3221225472)
else
    say "Configuring a light-mode build (256 MiB cache, no dataset)"
fi

emcmake cmake "${CMAKE_ARGS[@]}"

say "Compiling (this takes a few minutes; the interpreter is the slow part)"
if [ -n "$JOBS" ]; then
    cmake --build build -j "$JOBS"
else
    cmake --build build
fi

[ -f randomx.wasm ] || die "the build finished but randomx.wasm is missing"
say "Built $(ls -l randomx.wasm | awk '{print $5}') bytes -> WebRandomX/randomx.wasm"

# The page fetches randomx.wasm next to its own URL, so keep a dev copy beside
# the served files. The Dockerfile packages WebRandomX/randomx.wasm itself, so
# this copy only matters for `python -m http.server`-style local runs.
cp -f randomx.wasm ../randomx.wasm
say "Copied to crypto-frontend/randomx.wasm (local dev; both are gitignored)"

if [ "$SKIP_VERIFY" = "0" ]; then
    command -v node >/dev/null || die "node is required for verify_wasm.js (or pass --skip-verify)"
    say "Verifying the module against randomx.js"
    node verify_wasm.js
fi

say "Done. Serve crypto-frontend/ and pick Monero (XMR) in the miner."
