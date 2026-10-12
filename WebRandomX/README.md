# WebRandomX - RandomX for the browser miner

Builds `randomx.wasm`, the Monero (`rx/0`) proof-of-work VM that
`crypto-frontend/xmr-worker.js` hashes with. Nothing here runs at page load:
the worker fetches `randomx.wasm` only when a user picks Monero and starts
mining, and every other coin works without it.

```
WebRandomX/
  CMakeLists.txt          the build: RandomX's portable sources + src/randomx_bridge.cpp
  src/randomx_bridge.cpp  the rx_* C ABI that crypto-frontend/randomx.js calls
  build.sh / build.ps1    clone RandomX, run emcmake/cmake, verify the result
  verify_wasm.js          post-build check: instantiate the .wasm exactly like the worker does
  randomx/                the RandomX checkout build.sh clones here (gitignored)
  build/                  CMake build tree (gitignored)
  randomx.wasm            the artefact (gitignored, ~1 MB)
```

## Build

Prerequisites: [emsdk](https://emscripten.org/docs/getting_started/downloads.html)
(activated, so `emcc`/`emcmake` are on `PATH`), CMake >= 3.13, git, and Node for
the verification step.

```bash
# Linux / macOS / Git Bash (after `source ./emsdk/emsdk_env.sh`)
cd crypto-frontend/WebRandomX
./build.sh                      # light mode: 256 MiB cache, ~300 MiB per tab
```

```powershell
# Windows (after `.\emsdk\emsdk_env.ps1`)
cd crypto-frontend\WebRandomX
.\build.ps1                     # -FullMem, -Ref v1.2.3, -SkipVerify also work
```

What the scripts do: shallow-clone RandomX `v1.2.1` into `./randomx` (delete the
directory to switch refs), apply `patches/randomx-wasm-soft-rounding.patch` (see
"Floating point rounding" below - without it the module cannot hash correctly),
configure with `emcmake`, build, then run `node verify_wasm.js` against the result
and copy `randomx.wasm` to `crypto-frontend/randomx.wasm` for local development.
Both copies are gitignored: a missing VM is not a broken deploy, it is a Monero
feature that reports itself as unavailable.

| | light mode (default) | `-FullMem` / `--full-mem` |
| --- | --- | --- |
| VM memory | 256 MiB Argon2 cache | 3072 MiB dataset (+256 MiB cache) |
| `rx_init` | seconds (one per epoch) | minutes (one per epoch) |
| Per-hash | slower | ~1.5-2x faster |
| Tab footprint | ~300 MiB | ~2.3 GiB |
| wasm memory cap | 2 GiB | 3 GiB (`RX_MAX_MEMORY_MB`) |

Light mode is the default because a browser tab that wants 2.3 GiB is a tab the
OS kills. Monero's difficulty is high enough that neither mode earns anything
reliably in a browser; see the honest note in `crypto-frontend/README.md`.

## Status in this checkout

`randomx.wasm` is deliberately **not** committed: it is a ~1 MB build artefact and
the miner is designed to work without it (the Monero engine then reports itself
unavailable and submits nothing, while BTC / LTC / DOGE keep working).

It **is** built and verified in this checkout - emsdk `latest` (Emscripten 6.0.12),
Ninja, CMake, RandomX v1.2.1, light mode, on Windows:

| what was run | result |
| --- | --- |
| `build.ps1` from a wiped `randomx/` + `build/` | clones v1.2.1, applies the rounding patch, configures, builds, verifies |
| `node verify_wasm.js` | all checks pass, including **all six of RandomX's own known-answer hash vectors** |
| RandomX's own `randomx-tests` suite compiled to wasm | `All tests PASSED` (the 10 JIT tests are skipped: wasm cannot map executable pages) |
| a differential fuzz of the FP rounding against the x86 FPU | 406,480 cases across all five operations and four modes, 0 mismatches |
| `randomx.wasm` served over HTTP, loaded through `randomx.js` | RandomX 1.2.1, ~253 ms per hash in Node, deterministic and nonce-sensitive |

`rx_init` keying costs ~0.5 s per epoch. A browser tab is several times slower per
hash than Node, which is why `xmr-worker.js` budgets by wall clock rather than by a
hash count.

## Floating point rounding (why the RandomX checkout is patched)

RandomX's VM has an `fprc` register that selects the rounding mode of every
floating point instruction, and the `CFROUND` instruction writes it from program
state (`specs.md` chapter 4.3). That mode is part of consensus: `FADD_M`, `FSUB_M`
and `FDIV_M` store FP results to the scratchpad, where integer instructions read
them back, so the exact bits a mode produces get hashed. x86-64 implements it with
MXCSR (`rx_mxcsr_default | mode << 13`) and aarch64 with FPCR - but **WebAssembly
has no rounding-mode control at all**: every f64 operation rounds to nearest-even,
and Emscripten's `fesetround()` is a stub that changes nothing.

A wasm build that ignores the mode is not a slower miner, it is a miner that
computes the wrong hash for almost every job, and every share it submits would be
rejected. This is exactly what RandomX's maintainers meant in tevador/RandomX#81:
"It's still possible to implement it in JS/WASM, but with significant performance
penalty because of software FP implementation" - and the fix used here is the one
a WASM RandomX implementer describes in RandomX#304, "using error free transforms
to implement floating point rounding to get around the CFROUND instruction".

`patches/randomx-wasm-soft-rounding.patch` (62 added lines, no deletions) teaches
the vendored checkout to do it in software. Every hunk is inside
`#if defined(__wasm__)`, so native builds of the same checkout keep their FPU:

1. `intrin_portable.h` - the five operations (`rx_add_vec_f128` and friends) call
   `rx_wasm_fp::fadd` / `fsub` / `fmul` / `fdiv` / `fsqrt` in the portable branch.
2. `instructions_portable.cpp` - `rx_set_rounding_mode`, `rx_get_rounding_mode`
   and `rx_reset_float_state` keep the mode in software instead of `fenv.h`.
3. `randomx.cpp` - the FP-environment save/restore around a hash saves and
   restores the software mode, so a hash leaves the mode as it found it (this is
   what RandomX's "Preserve rounding mode" test checks).

`src/randomx_wasm_fp.hpp` is that implementation, and its header comment explains
the algorithm: take the correctly rounded *nearest* result from the FPU, learn
where the *exact* result sits relative to it (Knuth's 2Sum and Dekker's product
where those are exact, `long double` = binary128 otherwise), then step one ulp in
the direction the mode asks for. It costs ~35 ms per hash on top of ~220 ms - the
error-free transforms are used in the common ranges, binary128 only where they
would not be exact.

Both `CMakeLists.txt` and `verify_wasm.js` refuse to accept a module built without
the patch, so a silently wrong VM cannot ship. `-DRX_FORCE_EXACT_FP=ON` builds the
same sources with every operation on the binary128 path; it exists to tell an
error-free-transform bug apart from an exact-path one.

## The ABI (`src/randomx_bridge.cpp`)

`randomx.js` owns no RandomX state; every call goes through this shim, which
keeps one cache and one VM per module instance (i.e. per worker - `xmr-worker.js`
spawns one Web Worker per thread and each instantiates its own `randomx.wasm`).

| export | signature | meaning |
| --- | --- | --- |
| `rx_alloc` | `(size) -> ptr` | `malloc` inside the wasm heap |
| `rx_free` | `(ptr)` | `free` |
| `rx_cache_size` | `() -> bytes` | Argon2 cache size (informational) |
| `rx_vm_size` | `() -> bytes` | dataset size, or L3 scratchpad in light mode |
| `rx_version` | `() -> u32` | packed `MAJOR<<16 \| MINOR<<8 \| PATCH` |
| `rx_ready` | `() -> 0/1` | 1 once a seed has keyed the VM |
| `rx_init` | `(seedPtr, seedLen) -> rc` | key the VM for the epoch; idempotent per seed |
| `rx_hash` | `(blobPtr, blobLen, outPtr) -> rc` | 32 raw digest bytes at `outPtr` |

Return codes: `0` ok, `1` no VM yet, `2` bad argument, `3` cache allocation
failed, `4` VM/dataset allocation failed, `5` RandomX threw. `rx_hash` refuses
with `1` instead of hashing an unkeyed VM, so the miner can never submit a
fabricated digest.

Mining a Monero job is then just: write the nonce at byte 39 of the pool's block
hashing blob (`randomx.js` `blobWithNonce`), `rx_hash` it, and compare
`LE_u64(digest[24..31]) < target`.

## Verification (`verify_wasm.js`)

`build.sh`/`build.ps1` run it automatically; run it by hand any time:

```bash
node verify_wasm.js                 # or: node verify_wasm.js path/to/randomx.wasm
```

It instantiates the `.wasm` from raw bytes - exactly like the worker, with no
Emscripten glue, and with the same host-import stubs `randomx.js` supplies - and
checks the facts the miner depends on: every declared host import being stubbed,
all eight `rx_*` exports, an exported `memory`, a constructors entry point
(`_initialize` / `__wasm_call_ctors`), a non-zero `rx_version`, `wrapWasm()`
accepting the module, `rx_hash` refusing to run before `rx_init`, the seed
argument validation, the reported cache/VM sizes, a real keying of the VM with a
32-byte seed, the digest being deterministic, the nonce at byte 39 changing it,
and `loadRandomX()` (the fetch/instantiate seam the worker uses) agreeing with the
raw C ABI byte for byte.

It also runs **RandomX's own hash test vectors**, parsed straight out of
`randomx/src/tests/tests.cpp` so they cannot drift from the source the module was
built from. Those vectors are what turns "the VM returned 32 bytes" into "the VM
computes RandomX": a wrong superscalar program, a broken AES path or a mis-rounded
floating point operation all produce plausible-looking digests that no pool would
accept, and all of them fail this check. They are also how the missing rounding
patch was caught - before it, every vector mismatched - so a build with an
unpatched checkout fails here rather than in a pool's share log.

It is not a *replacement* for RandomX's own test suite (run `randomx-tests` from a
native build, or the wasm build of it) but it catches every way *this* build can be
subtly wrong: dropped exports, a module stripped of its constructors, a dataset that
does not fit the memory cap, an import set the page cannot satisfy, or FP rounding
that does not match the reference.

## Design notes / gotchas

- **No JIT, ever.** wasm cannot map executable pages. RandomX's own
  `common.hpp` already sets `RANDOMX_HAVE_COMPILER 0` on wasm32, so the build
  compiles the portable interpreter with soft AES - the configuration the
  library documents as the slow-but-portable one. Nothing x86/ARM/RISC-V
  specific ends up in the binary: `vm_compiled.cpp` falls back to
  `JitCompilerFallback` and the shim never sets a JIT flag.
- **Reactor, not command.** The module is built with `--no-entry`
  (`-sSTANDALONE_WASM=1`) because the worker has no JS glue and instantiates the
  bytes by hand. A module with no `_start` never runs its C++ static
  constructors - RandomX has a global `Cpu` object - so `randomx.js` calls
  `_initialize()` (or `__wasm_call_ctors` when that is the name the toolchain
  emitted) right after instantiation. `CMakeLists.txt` forces whichever exists
  into the export list with `-Wl,--export-if-defined=...`, which - unlike
  `--export` - does not fail when the symbol is absent.
- **Host imports.** The module still declares a handful of
  `wasi_snapshot_preview1` and `env` imports that musl's stdio/abort paths
  compile to. `randomx.js` supplies minimal stubs and, if instantiation still
  fails, reports the exact `module.field` names it needed instead of a bare
  `InstantiationError`.
- **Memory.** `-sALLOW_MEMORY_GROWTH=1` with a small initial size, so the cache
  is only allocated when someone actually starts Monero mining. A failed
  256 MiB allocation returns NULL (`-sABORTING_MALLOC=0`) and comes back as rc 3
  instead of aborting the instance.
- **Serving.** `randomx.wasm` must be served as `application/wasm`
  (`crypto-frontend/nginx.conf` does this, with `no-cache`) from the same origin
  as the page, or with CORS. It is single-threaded, so no COOP/COEP headers are
  needed, and it is ~1 MB, so it is fetched only when the user picks Monero.
- **Epochs.** Monero re-keys RandomX roughly every 2048 blocks (~2.8 days). Pools
  send the same 32-byte `seed_hash` on every job inside an epoch, and `rx_init`
  short-circuits on a repeated seed precisely so the 256 MiB cache is built once
  per epoch instead of once per job.

## Troubleshooting

| Symptom (page log / verify output) | Cause and fix |
| --- | --- |
| `randomx.wasm ... HTTP 404` | not built or not served next to the page: run `build.sh`, or rebuild the frontend image so the Dockerfile copies `WebRandomX/randomx.wasm` into `dist/` |
| `is empty - build it with WebRandomX/build.sh` | a 0-byte placeholder was deployed; the build never produced the module |
| `missing exports: ...` | built from a stale source tree; delete `build/` and rebuild |
| `exports neither _initialize() nor __wasm_call_ctors()` | the linker dropped both constructor entry points; check the `-Wl,--export-if-defined=` link options survived |
| `needs WebAssembly imports this page does not provide: ...` | a newer Emscripten added an import; add a stub beside the others in `randomx.js` (`defaultImports`) |
| `rx_init() failed with rc 4` | the dataset does not fit `-sMAXIMUM_MEMORY`: raise `RX_MAX_MEMORY_MB` (for `-FullMem`) or build in light mode |
| `RandomX hash failed (rc 5)` | RandomX threw; usually an allocation failure or an exception-handling mismatch (`-fwasm-exceptions` missing at link time) |
| hundreds of ms per hash, tiny hashrate | expected: portable interpreter, light mode, a single browser tab |

Only mine on hardware and pages you own or have explicit permission to mine on:
a browser tab is a fraction of one CPU core, and pools generally require consent
for browser-based mining.
