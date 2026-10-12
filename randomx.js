/*
 * randomx.js - shared Monero (RandomX) mining math for the browser miner.
 *
 * Loaded by the page (after sha256.js), imported by the CPU worker
 * (xmr-worker.js via importScripts) and required directly by the Node tests.
 * Everything in the "protocol" half is pure: no DOM, no network, no WebGPU.
 *
 * Monero does NOT use Bitcoin's stratum dialect. The pool speaks xmrig's
 * "login / job / submit" protocol and hands out a *block hashing blob* - the
 * serialized block header with the 4-byte nonce already reserved inside it -
 * plus a 64-bit target. Mining is therefore:
 *
 *     1. blob[39..42] = nonce          (little-endian uint32, see NONCE_OFFSET)
 *     2. hash          = RandomX(blob) (32 raw bytes)
 *     3. share         = LE_u64(hash[24..31]) < target
 *
 * Only step 2 needs the real RandomX VM (a ~1 MB WebAssembly build, see
 * WebRandomX/). Everything else - target parsing exactly as xmrig's
 * Job::setTarget does it, the nonce offset, the little-endian nonce hex the
 * pool expects back on submit, and the strictly-less-than share test - lives
 * here and is unit tested by test_xmr_protocol.js, which runs a mock pool and
 * an injected stub hash so the whole session can be exercised without the VM.
 *
 * `loadRandomX()` is the WASM seam: it fetches randomx.wasm, instantiates it
 * and returns an engine with hash(blob) -> Uint8Array(32). If the module is not
 * present it returns an engine whose .ready is false and whose .error explains
 * why - the miner then *refuses to mine* rather than submitting fabricated
 * hashes, which a pool would reject anyway.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.XmrCrypto = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
    'use strict';

    // Monero's reference 64-bit target scale (xmrig uses the same constant).
    var MAX64 = 0xFFFFFFFFFFFFFFFFn;
    var U32_MAX = 0xFFFFFFFFn;

    // RandomX hashes the whole hashing blob, so the nonce is written *into* it.
    // xmrig Job::nonceOffset() returns 39 for every non-RX/YADA/RandomWOW
    // RandomX variant and nonceSize() is 4 (see xmrig Job.cpp).
    var NONCE_OFFSET = 39;
    var NONCE_SIZE = 4;

    // The RandomX seed variant this miner supports. Monero mainnet has used
    // "rx/0" since the RandomX hard fork; a pool that advertises anything else
    // (rx/wow, ...) needs a different VM build.
    var SUPPORTED_SEED = 'rx/0';

    // ---- hex helpers (this file must stand alone for the Node tests) --------
    function hexToBytes(hex) {
        var s = String(hex || '').trim().replace(/^0x/i, '');
        if (s.length % 2 !== 0) s = '0' + s;
        var n = (s.length / 2) | 0;
        var out = new Uint8Array(n);
        for (var i = 0; i < n; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
        return out;
    }

    function bytesToHex(bytes) {
        var s = '';
        for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
        return s;
    }

    function isHex(s) { return /^[0-9a-fA-F]+$/.test(s); }

    // ---- 64-bit little-endian readers --------------------------------------
    function leU32(hex) {
        var b = hexToBytes(hex);
        if (b.length < 4) return null;
        return (BigInt(b[0]) | (BigInt(b[1]) << 8n) | (BigInt(b[2]) << 16n) | (BigInt(b[3]) << 24n));
    }

    function leU64(hex) {
        var b = hexToBytes(hex);
        if (b.length < 8) return null;
        var v = 0n;
        for (var i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[i]);
        return v;
    }

    // ---- target / difficulty math (mirrors xmrig Job::setTarget) -----------
    // xmrig decodes the pool's "target" hex string to bytes and then:
    //   4 bytes  ->  MAX64 / (0xFFFFFFFF / LE_u32)     ("short" form, scaled)
    //   8 bytes  ->  LE_u64                            (full 64-bit target)
    // Anything shorter than 4 bytes is invalid. The two forms differ by orders
    // of magnitude, so guessing wrong silently mistargets every share - hence
    // the explicit length switch below and the tests pinned to both forms.
    function parseTarget(raw) {
        if (raw === null || raw === undefined) return null;

        // Pools that advertise a difficulty instead of a target: target = MAX64/diff.
        if (typeof raw === 'number') {
            if (!(raw > 0) || !isFinite(raw)) return null;
            return difficultyToTarget(raw);
        }

        // A raw job object (what the stratum client actually has in hand) may be
        // passed straight through: prefer an explicit target, else diff/difficulty.
        if (typeof raw === 'object') {
            return parseTarget(raw.target !== undefined && raw.target !== null
                ? raw.target
                : (raw.diff !== undefined ? raw.diff : raw.difficulty));
        }

        var s = String(raw).trim().replace(/^0x/i, '');
        if (!isHex(s)) return null;
        if (s.length < 4) return null;

        if (s.length === 8) {
            var v = leU32(s);
            if (v === null || v === 0n) return null;
            return MAX64 / (U32_MAX / v);
        }
        if (s.length === 16) {
            var t = leU64(s);
            return (t === null || t === 0n) ? null : t;
        }
        return null;
    }

    // xmrig toDiff(): the pool's difficulty metric is MAX64 / target, so a
    // *lower* difficulty is an easier share. Reported to the user as a number.
    function targetToDifficulty(target) {
        var t = typeof target === 'bigint' ? target : parseTarget(target);
        if (!t || t <= 0n) return 0;
        return Number(MAX64 / t);
    }

    function difficultyToTarget(diff) {
        var d = Math.round(Number(diff) || 0);
        if (d <= 0) return null;
        var t = MAX64 / BigInt(d);
        return t > 0n ? t : null;
    }

    // ---- the share test ---------------------------------------------------
    // RandomX leaves the 32-byte digest in natural byte order; the PoW value is
    // the little-endian uint64 at bytes 24..31 and a share needs
    //     value < target      (strictly; xmrig uses the same comparison)
    function hashValue(hash) {
        if (!hash || hash.length < 32) return null;
        var v = 0n;
        for (var i = 7; i >= 0; i--) v = (v << 8n) | BigInt(hash[24 + i] & 0xff);
        return v;
    }

    function hashMeetsTarget(hash, target) {
        var t = typeof target === 'bigint' ? target : parseTarget(target);
        var v = hashValue(hash);
        if (v === null || t === null || t === undefined || t <= 0n) return false;
        return v < t;
    }

    // Rarity of a found hash on the pool's own scale (MAX64 / value), so the
    // "Best Share" tile is directly comparable with the job's difficulty.
    function hashDifficulty(hash) {
        var v = hashValue(hash);
        if (v === null || v === 0n) return 0;
        return Number(MAX64 / v);
    }

    // ---- nonce helpers ----------------------------------------------------
    // The pool expects the nonce back as the hex of the 4 little-endian bytes
    // it would occupy inside the blob (xmrig Cvt::toHex on &result.nonce), NOT
    // as the hex of the numeric value.
    function nonceToHex(nonce) {
        var v = (nonce >>> 0);
        var b = [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
        return bytesToHex(b);
    }

    function hexToNonce(hex) {
        var b = hexToBytes(hex);
        if (b.length < 4) return null;
        return ((b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0);
    }

    // Write a nonce into a copy of the blob at NONCE_OFFSET. The blob is the
    // block template the pool sent (hex or bytes): its nonce bytes must be
    // replaced, not appended, or the resulting hash cannot be verified.
    function blobWithNonce(blob, nonce, offset) {
        var out = (blob instanceof Uint8Array) ? new Uint8Array(blob) : hexToBytes(blob);
        var at = (offset === undefined || offset === null) ? NONCE_OFFSET : offset;
        if (out.length < at + NONCE_SIZE) {
            throw new Error('blob is too short (' + out.length + ' bytes) for a nonce at ' + at);
        }
        var v = (nonce >>> 0);
        out[at] = v & 0xff;
        out[at + 1] = (v >>> 8) & 0xff;
        out[at + 2] = (v >>> 16) & 0xff;
        out[at + 3] = (v >>> 24) & 0xff;
        return out;
    }

    // ---- pool job -> normalized job ---------------------------------------
    // xmrig's login/job protocol hands the miner a ready-made hashing blob, a
    // job id, a height and the current RandomX seed hash, plus either a "target"
    // (hex, see parseTarget) or a "diff"/"difficulty" number. Nothing is hashed
    // until the VM has been re-keyed with that seed (once per epoch).
    function normalizeJob(params) {
        if (!params) return null;
        var blobHex = params.blob || params.blocktemplate_blob || null;
        if (!blobHex) return null;

        var target = parseTarget(params.target !== undefined && params.target !== null
            ? params.target
            : (params.diff !== undefined ? params.diff : params.difficulty));
        if (!target) return null;

        var blob = hexToBytes(blobHex);
        if (blob.length < NONCE_OFFSET + NONCE_SIZE) return null;

        return {
            job_id: String(params.job_id || params.jobId || params.id || ''),
            blobHex: String(blobHex).toLowerCase(),
            blob: blob,
            target: target,
            difficulty: targetToDifficulty(target),
            height: params.height || 0,
            seed_hash: params.seed_hash || params.seedHash || '',
            algorithm: SUPPORTED_SEED
        };
    }

    // ---- RandomX WASM seam ------------------------------------------------
    // The engine built by WebRandomX/ (see WebRandomX/src/randomx_bridge.cpp) is
    // a freestanding module with no JS glue, so it is instantiated straight from
    // the .wasm bytes:
    //
    //   rx_alloc(size)                -> ptr          rx_free(ptr)
    //   rx_cache_size() / rx_vm_size() -> bytes the VM+dataset need (informational)
    //   rx_init(seedPtr, seedLen)     -> 0 on success (keys the VM for the epoch)
    //   rx_ready()                    -> 1 once a seed has been loaded
    //   rx_version()                  -> packed RandomX version
    //   rx_hash(blobPtr, blobLen, outPtr) -> 0 on success, 32 bytes written at outPtr
    //
    // rx_hash is synchronous and CPU-bound; callers run it inside a Web Worker so
    // the page stays responsive.
    function wrapWasm(instance) {
        var ex = instance && instance.exports;
        if (!ex || typeof ex.rx_hash !== 'function' || typeof ex.rx_alloc !== 'function' || !ex.memory) {
            return unavailableEngine(new Error('randomx.wasm is missing the expected exports'));
        }

        // A standalone emscripten module built without a main() is a "reactor":
        // its C++ static constructors (RandomX has a global Cpu object) only run
        // when the embedder calls the initialiser after instantiation. wasm-ld
        // names it _initialize (the WASI reactor convention) or, on some
        // toolchains, __wasm_call_ctors - call whichever came out, exactly once.
        // A build with JS glue initialises itself and exports neither, which is
        // why their absence is not fatal here; WebRandomX/verify_wasm.js does
        // fail the build on it, because a VM without constructors cannot hash.
        var initialise = (typeof ex._initialize === 'function') ? ex._initialize
                       : (typeof ex.__wasm_call_ctors === 'function') ? ex.__wasm_call_ctors
                       : null;
        if (initialise) {
            try { initialise.call(ex); }
            catch (e) { return unavailableEngine(e); }
        }

        function mem() { return new Uint8Array(ex.memory.buffer); }

        // NOTE: every call re-reads ex.memory.buffer because rx_alloc can grow
        // (and therefore detach) the memory, which would invalidate a cached view.
        function writeBytes(bytes) {
            var ptr = ex.rx_alloc(bytes.length) >>> 0;
            if (!ptr) throw new Error('randomx.wasm could not allocate ' + bytes.length + ' bytes');
            mem().set(bytes, ptr);
            return ptr;
        }

        var engine = {
            ready: true,
            wasm: true,
            version: (typeof ex.rx_version === 'function') ? (ex.rx_version() >>> 0) : 0,
            seed: null,

            // Re-key the VM for the current epoch. Idempotent per seed: a pool
            // repeats the same seed_hash on every job inside one epoch, and
            // re-keying an already-ready VM would waste a dataset build.
            initSeed: function (seedHex) {
                var key = String(seedHex || '').toLowerCase();
                if (engine.seed === key && (typeof ex.rx_ready !== 'function' || ex.rx_ready())) return true;
                var bytes = hexToBytes(key);
                if (!bytes.length) throw new Error('job has no seed_hash - cannot key RandomX');
                var ptr = 0;
                try {
                    ptr = writeBytes(bytes);
                    var rc = ex.rx_init(ptr, bytes.length) | 0;
                    if (rc !== 0) throw new Error('RandomX seed init failed (rc ' + rc + ')');
                    engine.seed = key;
                    return true;
                } finally {
                    if (ptr) { try { ex.rx_free(ptr); } catch (e) {} }
                }
            },

            // RandomX(blob) -> 32 raw bytes.
            hash: function (blob) {
                var input = (blob instanceof Uint8Array) ? blob : hexToBytes(blob);
                if (typeof ex.rx_ready === 'function' && !ex.rx_ready()) {
                    throw new Error('RandomX has not been keyed with a seed yet');
                }
                var inPtr = 0, outPtr = 0;
                try {
                    inPtr = writeBytes(input);
                    outPtr = ex.rx_alloc(32) >>> 0;
                    if (!outPtr) throw new Error('randomx.wasm could not allocate the digest buffer');
                    var rc = ex.rx_hash(inPtr, input.length, outPtr) | 0;
                    if (rc !== 0) throw new Error('RandomX hash failed (rc ' + rc + ')');
                    return mem().slice(outPtr, outPtr + 32);
                } finally {
                    if (inPtr) { try { ex.rx_free(inPtr); } catch (e) {} }
                    if (outPtr) { try { ex.rx_free(outPtr); } catch (e) {} }
                }
            }
        };
        return engine;
    }

    function unavailableEngine(err) {
        var message = (err && err.message) ? err.message : String(err || 'RandomX is unavailable');
        return {
            ready: false,
            wasm: false,
            version: 0,
            seed: null,
            error: message,
            initSeed: function () { throw new Error(message); },
            hash: function () { throw new Error(message); }
        };
    }

    // ---- WebAssembly imports for the standalone Emscripten build ------------
    // The module has no JS glue, but it still declares a few host imports: the
    // WASI preview1 calls musl's stdio/exit paths compile to, and Emscripten's
    // own runtime callbacks. Emscripten's generated JS would supply these; since
    // the miner instantiates the .wasm itself it provides the minimum here. None
    // of them sit on the mining hot path - they only fire on an abort or a stray
    // print - so succeeding or discarding output is the honest answer, and
    // anything unexpected is reported with the exact import names instead
    // (describeImportFailure below), rather than a bare InstantiationError.
    function defaultImports() {
        // fd_write() and friends need the module's memory, which only exists
        // after instantiation, so the stubs read it through this box. They read
        // memory.buffer on every call because growing the memory detaches the
        // previous ArrayBuffer.
        var mem = { memory: null };

        function view() {
            return mem.memory ? new DataView(mem.memory.buffer) : null;
        }
        function zeroOut(ptr, bytes) {
            var dv = view();
            if (dv && ptr) for (var i = 0; i < bytes; i++) dv.setUint8(ptr + i, 0);
            return 0;
        }

        var imports = {
            wasi_snapshot_preview1: {
                // A reactor that calls exit() ends here; surfacing it as a throw
                // turns it into an engine.error instead of a silent no-op.
                proc_exit: function (code) { throw new Error('randomx.wasm exited with code ' + code); },
                fd_write: function (fd, iovs, iovsLen, nwritten) {
                    if (nwritten) zeroOut(nwritten, 4);      // report "0 bytes written"
                    return 0;                                 // and drop the output
                },
                fd_read: function (fd, iovs, iovsLen, nread) {
                    if (nread) zeroOut(nread, 4);             // EOF
                    return 0;
                },
                fd_close: function () { return 0; },
                fd_seek: function (fd, offset, whence, newOffset) {
                    if (newOffset) zeroOut(newOffset, 8);
                    return 0;
                },
                fd_fdstat_get: function (fd, statPtr) { return zeroOut(statPtr, 24); },
                fd_fdstat_set_flags: function () { return 0; },
                fd_filestat_get: function (fd, statPtr) { return zeroOut(statPtr, 64); },
                fd_prestat_get: function () { return 8; },    // EBADF: no preopens
                args_sizes_get: function (argcPtr, bufSizePtr) {
                    return zeroOut(argcPtr, 4) | zeroOut(bufSizePtr, 4);
                },
                args_get: function () { return 0; },
                environ_sizes_get: function (countPtr, bufSizePtr) {
                    return zeroOut(countPtr, 4) | zeroOut(bufSizePtr, 4);
                },
                environ_get: function () { return 0; },
                clock_res_get: function (id, resPtr) { return zeroOut(resPtr, 8); },
                clock_time_get: function (id, precision, timePtr) { return zeroOut(timePtr, 8); },
                random_get: function (buf, len) {
                    if (!mem.memory) return 0;
                    // RandomX does not need randomness on the hash path, but if
                    // libc asks for entropy, /dev/urandom-equivalent is right.
                    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
                        crypto.getRandomValues(new Uint8Array(mem.memory.buffer, buf, len));
                    } else {
                        zeroOut(buf, len);
                    }
                    return 0;
                },
                sched_yield: function () { return 0; },
                poll_oneoff: function () { return 0; }
            },
            env: {
                emscripten_notify_memory_growth: function () {},
                abort: function () { throw new Error('randomx.wasm aborted'); }
            }
        };
        imports._mem = mem;
        return imports;
    }

    // Instantiating without the right imports fails with a message that names
    // nothing, so recompile the module purely to list what it wants.
    function describeImportFailure(bytes, err) {
        var detail = (err && err.message) ? err.message : String(err);
        try {
            var mod = new WebAssembly.Module(bytes);
            var names = WebAssembly.Module.imports(mod).map(function (i) {
                return (i.module || 'env') + '.' + i.name;
            });
            if (names.length) {
                return new Error('randomx.wasm needs WebAssembly imports this page does not ' +
                    'provide: ' + names.join(', ') + ' (original error: ' + detail + ')');
            }
        } catch (e) {
            /* the module itself is malformed - the original error says more */
        }
        return new Error(detail);
    }

    // Fetch + instantiate randomx.wasm. Never throws: an unusable engine comes
    // back with .ready === false and .error set, so the caller can tell the user
    // exactly what is missing instead of mining nothing (or, worse, submitting
    // fabricated hashes a pool would only reject).
    function loadRandomX(opts) {
        opts = opts || {};
        // Already-instantiated module (Node tests, or a page that embedded it).
        if (opts.engine) return Promise.resolve(wrapWasm(opts.engine));

        var url = opts.wasmUrl || 'randomx.wasm';

        return Promise.resolve().then(function () {
            if (typeof WebAssembly === 'undefined') {
                throw new Error('WebAssembly is not available in this browser');
            }
            var fetcher = opts.fetch || (typeof fetch === 'function' ? fetch : null);
            if (!fetcher) throw new Error('fetch() is not available to load ' + url);

            return fetcher(url).then(function (res) {
                if (!res || res.ok === false) {
                    throw new Error('could not load ' + url + (res && res.status ? ' (HTTP ' + res.status + ')' : ''));
                }
                return res.arrayBuffer();
            }).then(function (bytes) {
                if (!bytes || !bytes.byteLength) {
                    throw new Error(url + ' is empty - build it with WebRandomX/build.sh');
                }
                // Standalone Emscripten modules still import a few WASI/env
                // symbols; opts.imports lets a caller replace the stubs wholesale.
                var imports = opts.imports || defaultImports();
                return WebAssembly.instantiate(bytes, imports).then(function (out) {
                    // Hand the stubs the live memory object (see defaultImports).
                    if (imports._mem) imports._mem.memory = (out.instance || out).exports.memory;
                    return out;
                }, function (e) {
                    throw describeImportFailure(bytes, e);
                });
            }).then(function (out) {
                return wrapWasm(out.instance || out);
            });
        }).catch(function (e) {
            return unavailableEngine(e);
        });
    }

    return {
        MAX64: MAX64,
        NONCE_OFFSET: NONCE_OFFSET,
        NONCE_SIZE: NONCE_SIZE,
        SUPPORTED_SEED: SUPPORTED_SEED,
        hexToBytes: hexToBytes,
        bytesToHex: bytesToHex,
        leU32: leU32,
        leU64: leU64,
        parseTarget: parseTarget,
        targetToDifficulty: targetToDifficulty,
        difficultyToTarget: difficultyToTarget,
        hashValue: hashValue,
        hashMeetsTarget: hashMeetsTarget,
        hashDifficulty: hashDifficulty,
        nonceToHex: nonceToHex,
        hexToNonce: hexToNonce,
        blobWithNonce: blobWithNonce,
        normalizeJob: normalizeJob,
        wrapWasm: wrapWasm,
        unavailableEngine: unavailableEngine,
        loadRandomX: loadRandomX,
        // The host imports the standalone module declares. Exposed so
        // WebRandomX/verify_wasm.js can instantiate it exactly as the workers
        // do - instantiation with no imports at all fails on
        // env.emscripten_notify_memory_growth, and a build check that cannot
        // instantiate the module would not be a build check.
        defaultImports: defaultImports
    };
});
