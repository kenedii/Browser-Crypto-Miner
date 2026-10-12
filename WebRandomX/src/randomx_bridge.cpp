/*
 * randomx_bridge.cpp - the C ABI that crypto-frontend/randomx.js expects from
 * randomx.wasm.
 *
 * RandomX is a C++11 library, so the browser gets it through this thin shim
 * instead of linking it directly. The shim exports exactly the functions
 * randomx.js calls:
 *
 *   rx_alloc(size)                    -> ptr      (malloc inside wasm memory)
 *   rx_free(ptr)                      -> void
 *   rx_init(seedPtr, seedLen)         -> 0 ok     (keys the VM for the epoch)
 *   rx_ready()                        -> 0/1
 *   rx_version()                      -> packed MAJOR<<16 | MINOR<<8 | PATCH
 *   rx_cache_size()                   -> cache bytes      (informational)
 *   rx_vm_size()                      -> dataset/scratchpad bytes (informational)
 *   rx_hash(blobPtr, blobLen, outPtr) -> 0 ok, 32 bytes written at outPtr
 *
 * Return codes: 0 ok, 1 no VM yet (rx_init was never called), 2 bad argument,
 * 3 cache allocation failed, 4 VM/dataset allocation failed, 5 RandomX threw.
 * rx_init() keys the VM with the 32-byte Monero epoch seed the pool sends as
 * seed_hash; it is idempotent for a repeated seed, because a pool repeats the
 * same seed on every job inside one epoch and re-keying would throw away a
 * fully initialized 256 MiB cache.
 *
 * Two deliberate choices make this practical in a browser tab:
 *
 *  - No JIT. wasm cannot mmap executable pages, and RandomX's own common.hpp
 *    already falls back to RANDOMX_HAVE_COMPILER 0 on wasm32, so the portable
 *    interpreter with soft AES is compiled - the configuration xmrig calls
 *    "light mode", and the only one Monero's rx/0 needs.
 *  - Light mode by default: the VM reads the 256 MiB Argon2 cache instead of
 *    building a 2 GiB dataset, so one tab needs ~300 MiB rather than ~2.3 GiB
 *    (rx_init costs a few seconds rather than several minutes). Configure with
 *    -DRX_FULL_MEM=1 to build the dataset instead; see WebRandomX/README.md.
 *
 * State is per module instance: one cache and one VM. xmr-worker.js spawns one
 * Web Worker per thread and each worker instantiates its own copy of
 * randomx.wasm, so the threads never share this state.
 */

#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <exception>

#include "randomx.h"
#include "configuration.h"   /* RANDOMX_ARGON_MEMORY, RANDOMX_DATASET_* */

#ifdef __EMSCRIPTEN__
#include <emscripten/emscripten.h>
#define RX_EXPORT extern "C" EMSCRIPTEN_KEEPALIVE
#else
#define RX_EXPORT extern "C"
#endif

/* randomx.h only grew the split version macros in 1.2.2; keep 1.2.1 buildable. */
#ifndef RANDOMX_VERSION_MAJOR
#define RANDOMX_VERSION_MAJOR 1
#endif
#ifndef RANDOMX_VERSION_MINOR
#define RANDOMX_VERSION_MINOR 2
#endif
#ifndef RANDOMX_VERSION_PATCH
#define RANDOMX_VERSION_PATCH 1
#endif

#ifndef RX_FULL_MEM
#define RX_FULL_MEM 0
#endif

/* Longest seed we remember for the idempotency check (Monero sends 32 bytes). */
#define RX_MAX_SEED 64

namespace {

/* Return codes, mirrored by the comment block above and WebRandomX/README.md. */
enum {
    RX_OK = 0,
    RX_ERR_NOT_READY = 1,
    RX_ERR_BAD_ARG = 2,
    RX_ERR_NO_CACHE = 3,
    RX_ERR_NO_VM = 4,
    RX_ERR_THREW = 5
};

randomx_cache* g_cache = nullptr;
randomx_dataset* g_dataset = nullptr;
randomx_vm* g_vm = nullptr;
bool g_ready = false;

uint8_t g_seed[RX_MAX_SEED];
size_t g_seedLen = 0;

/* No JIT and no large pages exist here; FULL_MEM is the only optional flag. */
randomx_flags rxFlags() {
    randomx_flags flags = RANDOMX_FLAG_DEFAULT;
#if RX_FULL_MEM
    flags = flags | RANDOMX_FLAG_FULL_MEM;
#endif
    return flags;
}

/* Drop the VM (and, in full-memory builds, the dataset) but keep the cache. */
void releaseVm() {
    if (g_vm) {
        randomx_destroy_vm(g_vm);
        g_vm = nullptr;
    }
    if (g_dataset) {
        randomx_release_dataset(g_dataset);
        g_dataset = nullptr;
    }
    g_ready = false;
}

} /* namespace */


/* ---- linear-memory helpers used by randomx.js --------------------------- */

RX_EXPORT void* rx_alloc(size_t size) {
    /* malloc() may grow (and therefore detach) the wasm memory; randomx.js
     * re-reads memory.buffer after every call, so pointers stay valid. */
    return std::malloc(size ? size : 1);
}

RX_EXPORT void rx_free(void* ptr) {
    std::free(ptr);
}

/* ---- informational sizes ------------------------------------------------ */

/* Bytes of Argon2 scratch the cache occupies (RANDOMX_ARGON_MEMORY KiB). */
RX_EXPORT size_t rx_cache_size(void) {
    return (size_t)RANDOMX_ARGON_MEMORY * 1024;
}

/* Bytes the VM needs on top of the cache: the 2 GiB dataset in full-memory
 * builds, otherwise only the 2 MiB L3 scratchpad (light mode). */
RX_EXPORT size_t rx_vm_size(void) {
#if RX_FULL_MEM
    return (size_t)RANDOMX_DATASET_BASE_SIZE + (size_t)RANDOMX_DATASET_EXTRA_SIZE;
#else
    return (size_t)RANDOMX_SCRATCHPAD_L3;
#endif
}

RX_EXPORT uint32_t rx_version(void) {
    return ((uint32_t)RANDOMX_VERSION_MAJOR << 16) |
           ((uint32_t)RANDOMX_VERSION_MINOR << 8) |
           (uint32_t)RANDOMX_VERSION_PATCH;
}

/* 1 once rx_init() has keyed a VM, which is what gates rx_hash(). */
RX_EXPORT int rx_ready(void) {
    return g_ready ? 1 : 0;
}

/* ---- cache/VM lifecycle ------------------------------------------------- */

/* Key RandomX with the pool's epoch seed. Idempotent for a repeated seed, so a
 * stream of jobs inside one Monero epoch never rebuilds the cache. */
RX_EXPORT int rx_init(const uint8_t* seed, size_t seedLen) {
    if (!seed || seedLen == 0) return RX_ERR_BAD_ARG;

    if (g_ready && g_seedLen == seedLen &&
        std::memcmp(g_seed, seed, seedLen) == 0) {
        return RX_OK;   /* same epoch, already keyed */
    }

    releaseVm();

    if (!g_cache) {
        try {
            g_cache = randomx_alloc_cache(rxFlags());
        } catch (const std::exception&) {
            g_cache = nullptr;
        } catch (...) {
            g_cache = nullptr;
        }
        if (!g_cache) return RX_ERR_NO_CACHE;
    }

    try {
        randomx_init_cache(g_cache, seed, seedLen);

#if RX_FULL_MEM
        if (!g_dataset) {
            g_dataset = randomx_alloc_dataset(rxFlags());
            if (!g_dataset) return RX_ERR_NO_VM;
        }
        randomx_init_dataset(g_dataset, g_cache, 0,
                             randomx_dataset_item_count());
#endif

        g_vm = randomx_create_vm(rxFlags(), g_cache,
                                 g_dataset /* nullptr in light mode */);
    } catch (const std::exception&) {
        releaseVm();
        return RX_ERR_THREW;
    } catch (...) {
        releaseVm();
        return RX_ERR_THREW;
    }

    if (!g_vm) {
        releaseVm();
        return RX_ERR_NO_VM;
    }

    /* Remember the seed so the next job in this epoch short-circuits above. */
    g_seedLen = (seedLen <= RX_MAX_SEED) ? seedLen : 0;
    if (g_seedLen) std::memcpy(g_seed, seed, seedLen);
    g_ready = true;
    return RX_OK;
}

/* RandomX(blob) -> 32 raw bytes at out32. */
RX_EXPORT int rx_hash(const uint8_t* blob, size_t blobLen, uint8_t* out32) {
    if (!blob || !out32 || blobLen == 0) return RX_ERR_BAD_ARG;
    if (!g_ready || !g_vm) return RX_ERR_NOT_READY;

    /* randomx_calculate_hash() returns void and is only reachable once the VM
     * exists; anything it throws (bad flags, allocation inside the VM) turns
     * into a non-zero code so randomx.js refuses the hash instead of returning
     * an uninitialized buffer to the miner. */
    try {
        randomx_calculate_hash(g_vm, blob, blobLen, out32);
    } catch (...) {
        return RX_ERR_THREW;
    }
    return RX_OK;
}
