/*
 * verify_wasm.js - post-build check that randomx.wasm is what randomx.js needs.
 *
 * Run it from WebRandomX/ (`node verify_wasm.js`) after build.sh: it
 * instantiates the module exactly the way either browser worker does - straight
 * from the .wasm bytes, with no emscripten JS glue and with the same host
 * imports randomx.js stubs - and fails loudly instead of letting a subtly wrong
 * build (missing export, missing _initialize, no exported memory, an import the
 * page cannot satisfy) reach a user who then mines nothing.
 *
 * It is a structural + smoke test, not a proof of RandomX correctness. Keying
 * the VM with a real 32-byte Monero epoch seed takes seconds in light mode and
 * tens of milliseconds per hash, so it checks the rc contract (unkeyed -> 1,
 * junk args -> 2) and determinism, plus that the nonce at byte offset 39 really
 * changes the digest and that the raw C ABI and loadRandomX() agree.
 * Reproducing RandomX's published test vectors needs a
 * native `randomx-tests` binary; see README.md.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const WASM = process.argv[2] ? path.resolve(process.argv[2]) : path.join(__dirname, 'randomx.wasm');
const X = require('../randomx.js');

// RandomX's own hash test vectors live in the source tree the build compiled:
// each `calcHexHash(key, hexBlob, &hash)` / `calcStringHash(key, text, &hash)`
// is followed by an assert against the digest the reference implementation
// produced. They are parsed from there rather than copied into this file, so
// they cannot drift away from the source a build was made from.
const VECTORS_CPP = path.join(__dirname, 'randomx', 'src', 'tests', 'tests.cpp');
const VECTOR_RE = /calc(String|Hex)Hash\(\s*"([^"]+)"\s*,\s*"([^"]*)"\s*,\s*&hash\s*\)\s*;[\s\S]{0,400}?assert\(equalsHex\(hash,\s*"([0-9a-fA-F]{64})"\)\)/g;

function readVectors() {
    if (!fs.existsSync(VECTORS_CPP)) return [];
    const src = fs.readFileSync(VECTORS_CPP, 'utf8');
    const out = [];
    let m;
    VECTOR_RE.lastIndex = 0;
    while ((m = VECTOR_RE.exec(src)) !== null) {
        // calcHexHash() hex-decodes its argument (char input[H / 2]);
        // calcStringHash() hashes the literal bytes (H - 1 of them).
        out.push({
            key: m[2],
            kind: m[1].toLowerCase(),
            input: m[1] === 'Hex' ? Buffer.from(m[3], 'hex') : Buffer.from(m[3], 'utf8'),
            expected: m[4].toLowerCase()
        });
    }
    return out;
}

const REQUIRED = ['rx_init', 'rx_ready', 'rx_version', 'rx_alloc', 'rx_free',
                  'rx_cache_size', 'rx_vm_size', 'rx_hash'];
const RC_NAMES = ['ok', 'no VM yet', 'bad argument', 'cache allocation failed',
                  'VM/dataset allocation failed', 'RandomX threw'];

let failures = 0;
const ok = (m) => console.log('PASS:', m);
const fail = (m) => { console.log('FAIL:', m); failures++; };

if (!fs.existsSync(WASM)) {
    console.log('SKIP: ' + WASM + ' does not exist yet - run build.sh (or build.ps1) first.');
    process.exit(2);
}

(async () => {
    const bytes = fs.readFileSync(WASM);
    console.log('Loaded ' + path.basename(WASM) + ' (' + (bytes.length / 1024).toFixed(1) + ' KiB)');

    // The module is a standalone WASI reactor, but "standalone" does not mean
    // "imports nothing": the linker still declares
    // env.emscripten_notify_memory_growth (Emscripten's "your memory grew"
    // callback). Instantiating with an empty import object therefore fails, and
    // a check that cannot instantiate the module proves nothing. So instantiate
    // with the very stubs the workers get from randomx.js - and require that
    // every declared import is covered by them, which is what turns "a newer
    // Emscripten added an import" into a build failure here instead of a
    // "RandomX is unavailable" in the browser.
    const imports = X.defaultImports();
    const declared = WebAssembly.Module.imports(new WebAssembly.Module(bytes));
    const unstubbed = declared.filter((i) => !(imports[i.module] && typeof imports[i.module][i.name] === 'function'));
    unstubbed.length === 0
        ? ok('every host import is stubbed by randomx.js (' +
             (declared.length ? declared.map((i) => i.module + '.' + i.name).join(', ') : 'none') + ')')
        : fail('randomx.js has no stub for: ' + unstubbed.map((i) => i.module + '.' + i.name).join(', ') +
               ' - add one to defaultImports() or the page cannot start the VM');

    const out = await WebAssembly.instantiate(bytes, imports);
    const instance = out.instance || out;
    const ex = instance.exports;
    // The WASI stubs read the module's memory lazily (growing it detaches the
    // previous ArrayBuffer), so hand them the live object - loadRandomX() does
    // exactly this right after instantiating.
    if (imports._mem) imports._mem.memory = ex.memory;

    const missing = REQUIRED.filter((n) => typeof ex[n] !== 'function');
    if (missing.length) {
        fail('missing exports: ' + missing.join(', '));
        process.exit(1);
    }
    ok('exports the rx_* C ABI randomx.js calls');

    ex.memory ? ok('exports its linear memory (randomx.js reads digests through it)')
              : fail('does not export `memory` - drop -sIMPORTED_MEMORY / keep standalone mode');

    // C++ static constructors (RandomX has a global Cpu object) only run when
    // the reactor module's initialiser is called. wasm-ld names it _initialize
    // (the WASI reactor convention) or, on some toolchains, __wasm_call_ctors;
    // randomx.js calls whichever is exported, so check that one of them made it
    // into the module - without it the VM has no constructors and cannot hash.
    const initFn = (typeof ex._initialize === 'function' && '_initialize') ||
                   (typeof ex.__wasm_call_ctors === 'function' && '__wasm_call_ctors');
    initFn ? ok('exports ' + initFn + '() - randomx.js runs the C++ static constructors through it')
           : fail('exports neither _initialize() nor __wasm_call_ctors(): the static constructors ' +
                  'never run, so the VM cannot hash (see the CMakeLists.txt link options)');

    const ver = ex.rx_version() >>> 0;
    ver > 0
        ? ok('reports RandomX ' + ((ver >> 16) & 0xff) + '.' + ((ver >> 8) & 0xff) + '.' + (ver & 0xff) +
             ' (0x' + ver.toString(16) + ')')
        : fail('rx_version() returned 0');

    // wrapWasm() is the seam the workers use, and it performs that initialiser
    // call itself; if it rejects the module the page reports "RandomX is
    // unavailable" and refuses to mine.
    const engine = X.wrapWasm(instance);
    (engine.ready === true && engine.wasm === true && engine.version === ver)
        ? ok('randomx.js wrapWasm() accepts the module')
        : fail('wrapWasm() rejected the module: ' + engine.error);

    ex.rx_ready() === 0
        ? ok('starts unkeyed (rx_ready() = 0, so no hash can run before a seed)')
        : fail('rx_ready() is already 1 before any seed');

    const blobPtr = ex.rx_alloc(76) >>> 0;
    const outPtr = ex.rx_alloc(32) >>> 0;
    (blobPtr !== 0 && outPtr !== 0)
        ? ok('rx_alloc() hands out wasm-memory buffers (' + blobPtr + ', ' + outPtr + ')')
        : fail('rx_alloc() returned a null pointer');

    ex.rx_hash(blobPtr, 76, outPtr) === 1
        ? ok('rx_hash() before rx_init() returns rc 1 instead of hashing with no VM')
        : fail('rx_hash() did not refuse to run before rx_init()');

    ex.rx_init(blobPtr, 0) === 2
        ? ok('rx_init() with a zero-length seed returns rc 2')
        : fail('rx_init() accepted a zero-length seed');

    const cacheBytes = ex.rx_cache_size();
    const vmBytes = ex.rx_vm_size();
    ok('reports a ' + (cacheBytes / 1048576).toFixed(0) + ' MiB cache + ' +
       (vmBytes / 1048576).toFixed(0) + ' MiB ' +
       (vmBytes > cacheBytes ? 'dataset (full-memory build)' : 'scratchpad (light mode)') +
       ' - that is roughly what one tab will need');

    // Key the VM with a 32-byte seed, the shape a pool sends as seed_hash. This
    // is the slow step: seconds in light mode, minutes in a full-memory build.
    const seedHex = 'd7a9c1e0f7d0b0c1a0e0d0c0b0a09080706050403020100f1e2d3c4b5a697886';
    const seed = Buffer.from(seedHex, 'hex');
    const seedPtr = ex.rx_alloc(seed.length) >>> 0;
    new Uint8Array(ex.memory.buffer).set(seed, seedPtr);

    const t0 = Date.now();
    const rc = ex.rx_init(seedPtr, seed.length) | 0;
    let rawDigest = null;
    if (rc !== 0) {
        fail('rx_init() failed with rc ' + rc + ' (' + (RC_NAMES[rc] || 'unknown') +
             ') - a full-memory build needs a bigger -sMAXIMUM_MEMORY');
    } else {
        ok('rx_init() keyed the VM in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');
        ex.rx_ready() === 1 ? ok('rx_ready() is 1 after rx_init()')
                            : fail('rx_ready() is still 0 after rx_init()');
        ex.rx_init(seedPtr, seed.length) === 0
            ? ok('re-keying with the same seed is cheap (rc 0, no cache rebuild)')
            : fail('re-keying with the same seed failed');

        // A real block hashing blob is 76 bytes (the Monero block header) with
        // the nonce at offset 39 - exactly where randomx.js writes xmrig's
        // nonceOffset().
        const blob = Buffer.alloc(76, 0x11);
        new Uint8Array(ex.memory.buffer).set(blob, blobPtr);

        // Hash it through the raw C ABI first: a broken wrapWasm() must not be
        // able to hide a working module (or the other way round).
        const t1 = Date.now();
        const rc2 = ex.rx_hash(blobPtr, 76, outPtr) | 0;
        const perHash = Date.now() - t1;
        rawDigest = Buffer.from(new Uint8Array(ex.memory.buffer, outPtr, 32)).toString('hex');
        (rc2 === 0 && rawDigest.length === 64)
            ? ok('rx_hash() through the raw C ABI returns a 32-byte digest: ' + rawDigest)
            : fail('rx_hash() failed with rc ' + rc2);

        ex.rx_hash(blobPtr, 76, outPtr);
        const repeat = Buffer.from(new Uint8Array(ex.memory.buffer, outPtr, 32)).toString('hex');
        repeat === rawDigest
            ? ok('the digest is stable across calls (RandomX is deterministic per seed)')
            : fail('two hashes of the same blob differ (' + rawDigest + ' vs ' + repeat + ')');

        // ... then through the seam the page really uses: loadRandomX() with a
        // stand-in for the HTTP request xmr-worker.js makes, so this exercises
        // fetch -> instantiate -> wrapWasm -> initSeed -> hash end to end.
        const seam = await X.loadRandomX({
            wasmUrl: 'randomx.wasm',
            fetch: () => Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(bytes) })
        });
        if (seam.ready !== true) {
            fail('loadRandomX() could not instantiate the served bytes: ' + seam.error);
        } else {
            const t2 = Date.now();
            seam.initSeed(seedHex);
            ok('loadRandomX() fetched, instantiated and keyed the module through the worker path (' +
               ((Date.now() - t2) / 1000).toFixed(1) + ' s)');
            const seamHex = Buffer.from(seam.hash(new Uint8Array(blob))).toString('hex');
            seamHex === rawDigest
                ? ok('the worker path agrees with the raw C ABI (both entry points, one digest)')
                : fail('loadRandomX() produced a different digest (' + seamHex + ' vs ' + rawDigest + ')');
        }

        blob[39] ^= 0xff;   /* nudge the nonce the miner varies */
        const h3 = engine.hash(new Uint8Array(blob));
        !Buffer.from(rawDigest, 'hex').equals(Buffer.from(h3))
            ? ok('changing the nonce at offset 39 changes the digest (the blob is really hashed)')
            : fail('the digest ignored the nonce');

        ok('~' + perHash + ' ms per hash here; a browser tab is several times slower, ' +
           'which is why xmr-worker.js budgets by wall clock');

        // ---- Known-answer vectors from the vendored RandomX sources ---------
        // This is the difference between "the VM returns 32 bytes" and "the VM
        // computes RandomX": a wrong superscalar program, a broken AES path or
        // a mis-salted cache all return plausible-looking digests that no pool
        // would ever accept.
        const vectors = readVectors();
        if (!vectors.length) {
            console.log('SKIP: no hash vectors found in ' + VECTORS_CPP +
                ' - build from a randomx/ checkout to run the known-answer test');
        } else {
            const keyPtr = ex.rx_alloc(64) >>> 0;
            const vecPtr = ex.rx_alloc(4096) >>> 0;
            let keyed = null;
            let passed = 0;
            for (const v of vectors) {
                const keyBytes = Buffer.from(v.key, 'utf8');
                const input = v.input;
                if (keyBytes.length > 64 || input.length > 4096) {
                    fail('vector for "' + v.key + '" does not fit the scratch buffers');
                    break;
                }
                if (keyed !== v.key) {
                    new Uint8Array(ex.memory.buffer).set(keyBytes, keyPtr);
                    const rck = ex.rx_init(keyPtr, keyBytes.length) | 0;
                    if (rck !== 0) { fail('rx_init("' + v.key + '") failed with rc ' + rck); break; }
                    keyed = v.key;
                }
                new Uint8Array(ex.memory.buffer).set(input, vecPtr);
                const rc3 = ex.rx_hash(vecPtr, input.length, outPtr) | 0;
                const got = rc3 === 0
                    ? Buffer.from(new Uint8Array(ex.memory.buffer, outPtr, 32)).toString('hex')
                    : 'rc ' + rc3;
                got === v.expected
                    ? passed++
                    : fail('RandomX("' + v.key + '", ' + input.length + ' bytes) = ' + got +
                           ', expected ' + v.expected + ' - this module is not computing RandomX');
            }
            if (passed === vectors.length) {
                ok('all ' + passed + ' RandomX known-answer vector(s) from src/tests/tests.cpp match exactly');
            }
        }
    }

    console.log(failures === 0 ? '\nAll checks passed.' : '\n' + failures + ' check(s) failed.');
    process.exit(failures === 0 ? 0 : 1);
})().catch((e) => {
    console.error('FAIL: ' + (e && e.stack ? e.stack : e));
    process.exit(1);
});
