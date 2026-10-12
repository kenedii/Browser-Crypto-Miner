/*
 * Offline unit test for randomx.js + xmr-worker.js (Monero / RandomX support).
 *
 * RandomX itself cannot be validated without the WASM build, so this test pins
 * everything *around* it - the parts where a mistake silently makes every share
 * invalid:
 *   - the constants taken straight from xmrig: the nonce lives at blob offset 39
 *     and is 4 bytes; the verdict is LE_u64(hash[24..31]) < target (strict).
 *   - target parsing for all three forms a pool can send (16-hex, 8-hex, and a
 *     plain "diff" number) plus the diff = 2^64 / target round-trip.
 *   - the share-check boundary (value == target must NOT be a share).
 *   - the submit payload shape (nonce = hex of its 4 little-endian bytes, result
 *     = raw digest bytes hex) and the blob mutation (only bytes 39..42 change).
 *   - the worker protocol, driven end to end with a STUB RandomX engine whose
 *     "hash" is SHA-256. That keeps the test honest: the expected share is
 *     recomputed independently with Node's crypto, so the nonce offset, the
 *     target check and the message shape all have to be right for it to pass.
 *   - the "no WASM build" path: loadRandomX() must report the failure instead of
 *     handing out an engine that fabricates hashes, including the WASI/env
 *     imports a standalone module declares (the page supplies stubs for those,
 *     and anything it cannot supply is named in the error).
 *
 * Run: node test_xmr_protocol.js
 */
const crypto = require('crypto');
const X = require('./randomx.js');

let failures = 0;
const ok = (m) => console.log('PASS:', m);
const fail = (m) => { failures++; console.log('FAIL:', m); };
const hex = (b) => Buffer.from(b).toString('hex');
const le64hex = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b.toString('hex'); };

// ---- 0. constants match xmrig ---------------------------------------------
{
    const good = X.NONCE_OFFSET === 39 && X.NONCE_SIZE === 4 && X.SUPPORTED_SEED === 'rx/0';
    good ? ok('nonce offset 39 / size 4 and seed "rx/0" match xmrig')
        : fail(`constants wrong: offset=${X.NONCE_OFFSET} size=${X.NONCE_SIZE} seed=${X.SUPPORTED_SEED}`);
    X.MAX64 === 0xffffffffffffffffn ? ok('MAX64 == 2^64 - 1') : fail('MAX64 is not 2^64-1');
}

// ---- 1. target parsing (16-hex, 8-hex, numeric diff) ----------------------
{
    // 16 hex chars are a full 64-bit target, little-endian, as xmrig reads it.
    X.parseTarget('ffffffffffffffff') === X.MAX64
        ? ok('16-hex "ffffffffffffffff" -> target 2^64-1 (difficulty 1)')
        : fail('16-hex max target mismatch: ' + X.parseTarget('ffffffffffffffff'));
    X.parseTarget('0100000000000000') === 1n
        ? ok('16-hex target is little-endian ("0100000000000000" -> 1)')
        : fail('16-hex LE mismatch: ' + X.parseTarget('0100000000000000'));

    // 8 hex chars are a 32-bit value on the same scale (xmrig: 0xFFFFFFFF/val).
    X.targetToDifficulty(X.parseTarget('40420f00')) === 4294
        ? ok('8-hex "40420f00" -> difficulty 4294 (= 0xFFFFFFFF/1000000)')
        : fail('8-hex difficulty mismatch: ' + X.targetToDifficulty(X.parseTarget('40420f00')));

    X.parseTarget(1000) === X.difficultyToTarget(1000)
        ? ok('numeric "diff": 1000 -> target = 2^64/1000 (xmrig scale)')
        : fail('numeric diff target mismatch: ' + X.parseTarget(1000));
    String(X.parseTarget({ diff: 1000 })) === String(X.parseTarget(1000))
        ? ok('objects with { diff } / { difficulty } are accepted too')
        : fail('{diff} object target mismatch');

    ['', '   ', 'zz', 'abc', 'gggggggggggggggg', '0', 0, -5, NaN, null, undefined].every((v) => X.parseTarget(v) === null)
        ? ok('malformed targets are rejected (never silently treated as difficulty 1)')
        : fail('a malformed target was accepted: ' + ['', 'zz', 0].map((v) => String(X.parseTarget(v))).join(','));
}

// ---- 2. difficulty <-> target round-trip ----------------------------------
{
    // Both directions divide on the full 64-bit scale, so the round-trip is exact
    // for every realistic pool difficulty. Above ~1e9 the double rounding shows up
    // (error grows ~diff^2 / 2^64 in *relative* terms), which is far below any
    // observable difference for real pools (Monero pools ask for ~1e4..1e6, where
    // the round-trip is exact).
    let bad = 0, drifted = 0;
    [1, 2, 100, 4294, 1000, 100000, 1e6, 1e9].forEach((d) => {
        const back = X.targetToDifficulty(X.difficultyToTarget(d));
        if (back !== d) { bad++; fail('difficulty round-trip broke at ' + d + ' (got ' + back + ')'); }
    });
    [[5e9, 1e-6], [1e12, 1e-6], [1e15, 1e-3]].forEach(([d, tol]) => {
        const back = X.targetToDifficulty(X.difficultyToTarget(d));
        const rel = Math.abs(back - d) / d;
        if (rel < tol && back >= d) drifted++;
        else { bad++; fail('extreme difficulty ' + d + ' drifted too far (got ' + back + ')'); }
    });
    bad === 0 ? ok('difficulty round-trip exact to 1e9, within tolerance beyond (' + drifted + ' extremes checked)')
        : fail(bad + ' difficulty round-trips failed');
    X.targetToDifficulty(X.MAX64) === 1 ? ok('difficulty of the max target is 1') : fail('difficulty(MAX64) != 1');
}

// ---- 3. the share verdict is LE_u64(hash[24..31]) < target, strict --------
{
    const mk = (v) => {
        const h = Buffer.alloc(32);
        Buffer.from(le64hex(v), 'hex').copy(h, 24);
        return new Uint8Array(h);
    };
    const t = 12345n;
    X.hashValue(mk(t)) === t ? ok('hashValue reads hash[24..31] little-endian') : fail('hashValue byte order wrong');
    X.hashMeetsTarget(mk(t - 1n), t) === true ? ok('value < target is a share') : fail('value < target was rejected');
    X.hashMeetsTarget(mk(t), t) === false
        ? ok('value == target is NOT a share (strict <, like xmrig)') : fail('the strict-< boundary is broken');

    // Independent check of the same rule on 200 random hashes.
    let bad = 0;
    for (let i = 0; i < 200; i++) {
        const h = crypto.randomBytes(32);
        const v = h.readBigUInt64LE(24);
        const target = BigInt('0x' + crypto.randomBytes(8).toString('hex'));
        if (X.hashMeetsTarget(new Uint8Array(h), target) !== (v < target)) bad++;
    }
    bad === 0 ? ok('hashMeetsTarget agrees with readBigUInt64LE(h,24) < target on 200 hashes')
        : fail(bad + ' verdict mismatches');
}


// ---- 4. nonce placement, digest hex and submit payload shape --------------
{
    const blob = crypto.randomBytes(76);                 // a real Monero block blob is 76-80 bytes
    const original = Buffer.from(blob);
    const nonce = 0xdeadbeef;
    const patched = X.blobWithNonce(new Uint8Array(blob), nonce);
    patched.length === blob.length ? ok('blobWithNonce keeps the blob length') : fail('blob length changed');
    hex(patched.slice(39, 43)) === 'efbeadde'
        ? ok('nonce lands at offset 39 as 4 little-endian bytes (xmrig nonceOffset 39)')
        : fail('nonce bytes wrong at 39: ' + hex(patched.slice(39, 43)));
    Buffer.from(patched).equals(
        Buffer.concat([original.slice(0, 39), Buffer.from('efbeadde', 'hex'), original.slice(43)])
    ) ? ok('only bytes 39..42 of the blob are touched') : fail('blobWithNonce changed bytes outside the nonce');
    blob.equals(original)
        ? ok("blobWithNonce does not mutate the caller's blob") : fail('the input blob was mutated');

    X.nonceToHex(nonce) === 'efbeadde'
        ? ok('nonceToHex emits the little-endian byte hex xmrig submits') : fail('nonceToHex = ' + X.nonceToHex(nonce));
    X.hexToNonce('efbeadde') === nonce ? ok('hexToNonce reverses nonceToHex') : fail('hexToNonce mismatch');
    let rt = 0;
    for (let i = 0; i < 500; i++) {
        const n = (Math.random() * 0x100000000) >>> 0;
        if (X.hexToNonce(X.nonceToHex(n)) !== n) rt++;
    }
    rt === 0 ? ok('nonceToHex/hexToNonce round-trip on 500 random nonces') : fail(rt + ' nonce round-trips failed');

    // A digest hex string is the raw 32 bytes (NOT reversed, unlike Bitcoin).
    const digest = X.bytesToHex(crypto.randomBytes(32));
    digest.length === 64 && /^[0-9a-f]+$/.test(digest) && hex(X.hexToBytes(digest)) === digest
        ? ok('bytesToHex/hexToBytes round-trip a 32-byte RandomX digest') : fail('digest hex round-trip failed');
}

// ---- 5. job normalization (the wire shape xmrig pools send) ---------------
{
    const BLOB = '0f' + '11'.repeat(75);                  // 76 bytes, nonce at 39..42
    const nj = X.normalizeJob({ job_id: 'xmr-job-1', blob: BLOB, target: 'ffffffffffffffff', height: 3123456, seed_hash: 'aa'.repeat(32) });
    nj && nj.job_id === 'xmr-job-1' && nj.blob.length === 76 && nj.target === X.MAX64 && nj.difficulty === 1
        ? ok('normalizeJob maps a pool job (blob/target/height/seed_hash)') : fail('normalizeJob produced ' + JSON.stringify(nj && nj.job_id));
    nj && nj.seed_hash === 'aa'.repeat(32) && nj.algorithm === 'rx/0'
        ? ok('normalizeJob carries the epoch seed_hash and the rx/0 algorithm') : fail('seed_hash/algorithm missing');
    nj && nj.height === 3123456 ? ok('normalizeJob carries the block height') : fail('height lost');

    const viaAlias = X.normalizeJob({ job_id: 'j', blocktemplate_blob: BLOB, diff: 1000 });
    viaAlias && String(viaAlias.target) === String(X.difficultyToTarget(1000))
        ? ok('normalizeJob accepts blocktemplate_blob + "diff" as well as blob + "target"')
        : fail('blocktemplate_blob/diff job was not normalized');

    X.normalizeJob({ job_id: 'j', target: 'ffffffffffffffff' }) === null
        ? ok('normalizeJob rejects a job with no blob') : fail('a blob-less job was accepted');
    X.normalizeJob({ job_id: 'j', blob: 'aabb' }) === null
        ? ok('normalizeJob rejects a blob too short to hold the nonce') : fail('a short blob was accepted');
    X.normalizeJob({ job_id: 'j', blob: BLOB }) === null
        ? ok('normalizeJob rejects a job with no target/diff (never defaults to difficulty 1)')
        : fail('a target-less job was accepted');
    X.normalizeJob(null) === null ? ok('normalizeJob(null) is null') : fail('normalizeJob(null) did not return null');

    // An explicit target always wins over a diff, the way pools intend.
    const both = X.normalizeJob({ blob: BLOB, target: 'ffffffffffffffff', diff: 99999 });
    both && both.target === X.MAX64 ? ok('an explicit "target" overrides "diff"') : fail('target/diff precedence wrong');
}


// ---- 6. the WASM seam (wrapWasm) against a stub engine --------------------
// The stub implements the same C ABI randomx.wasm must export, but "hashes" with
// SHA-256. Every expected value below is recomputed with Node's crypto, so a
// wrong pointer, a stale memory view or a bad byte order cannot slip through.
const STUB_HASH = (bytes) => crypto.createHash('sha256').update(Buffer.from(bytes)).digest();
function makeStubEngine() {
    const SIZE = 1 << 16;
    const buf = new ArrayBuffer(SIZE);
    const u8 = new Uint8Array(buf);
    let heap = 4096;
    let seeded = false;
    const seen = [];                                        // seeds passed to rx_init
    return {
        seen: seen,
        exports: {
            memory: { buffer: buf },
            // Bump allocator with a wrap-around: the worker only ever holds one
            // blob plus the digest buffer at a time, and the stub never really
            // frees, so recycling from the start keeps a fast loop from running
            // off the end of this deliberately tiny memory.
            rx_alloc: (n) => { if (heap + n > SIZE) heap = 4096; const p = heap; heap = (heap + n + 7) & ~7; return p; },
            rx_free: () => {},
            rx_version: () => 0x00010000,
            rx_ready: () => (seeded ? 1 : 0),
            rx_init: (ptr, len) => {
                if (!len) return 1;
                seen.push(Buffer.from(u8.slice(ptr, ptr + len)).toString('hex'));
                seeded = true;
                return 0;
            },
            rx_hash: (inPtr, len, outPtr) => { u8.set(STUB_HASH(u8.slice(inPtr, inPtr + len)), outPtr); return 0; }
        }
    };
}

{
    const stub = makeStubEngine();
    const engine = X.wrapWasm(stub);
    engine.ready === true && engine.version === 0x00010000
        ? ok('wrapWasm() accepts a module exporting the rx_* C ABI') : fail('wrapWasm rejected a valid module');

    let threw = false;
    try { engine.hash(new Uint8Array(80)); } catch (e) { threw = /seed/i.test(e.message); }
    threw ? ok('hashing before the VM is seeded throws (no silent garbage)') : fail('hash() ran unseeded');

    const seed = 'aa'.repeat(32);
    engine.initSeed(seed) && stub.seen[0] === seed && engine.seed === seed
        ? ok('initSeed() keys the VM with the pool seed_hash bytes') : fail('initSeed did not pass the seed through');

    const blob = crypto.randomBytes(76);
    Buffer.from(engine.hash(new Uint8Array(blob))).equals(STUB_HASH(blob))
        ? ok('engine.hash() returns the 32-byte digest the VM wrote') : fail('engine.hash() returned the wrong bytes');

    const before = stub.seen.length;
    engine.initSeed(seed);
    stub.seen.length === before
        ? ok('re-seeding with the same epoch seed is a no-op (no dataset rebuild)') : fail('initSeed re-keyed the same seed');
    engine.initSeed('bb'.repeat(32));
    stub.seen.length === before + 1
        ? ok('a new epoch seed does re-key the VM') : fail('a new seed was ignored');

    const bad = X.wrapWasm({});
    bad.ready === false && /exports/i.test(bad.error)
        ? ok('wrapWasm() reports a module missing rx_hash/rx_alloc/memory instead of pretending to work')
        : fail('wrapWasm accepted an empty module');
    let badThrew = false;
    try { bad.hash(new Uint8Array(1)); } catch (e) { badThrew = true; }
    badThrew ? ok('an unusable engine throws on hash() rather than returning a fake digest') : fail('bad engine hashed anyway');
}

// ---- 7. the worker protocol, driven with the stub engine -------------------
// xmr-worker.js is loaded for real (twice, with a fresh module cache) behind a
// `self` shim, so what is exercised is the actual message protocol the page
// speaks: start/stop/job in, { vm }, { hashes }, { best }, { share } out.
const WORKER_PATH = require.resolve('./xmr-worker.js');
const REAL_LOAD_RANDOMX = X.loadRandomX;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadWorker(engineFactory, loadImpl) {
    const messages = [];
    // By default the worker's loadRandomX() is short-circuited to wrap the stub
    // WASM instance, exactly as the real loader would after fetching randomx.wasm.
    X.loadRandomX = loadImpl || (() => Promise.resolve(X.wrapWasm(engineFactory())));
    global.self = { postMessage: (m) => messages.push(m), XmrCrypto: X };
    delete require.cache[WORKER_PATH];
    require(WORKER_PATH);                       // installs self.onmessage
    return {
        messages: messages,
        send: (msg) => global.self.onmessage({ data: msg }),
        // A stopped loop can still have one tick in flight, so leave a dead shim
        // behind: the late post must land nowhere instead of throwing a
        // ReferenceError (or worse, leaking into the next worker's message list).
        restore: () => {
            delete require.cache[WORKER_PATH];
            global.self = { postMessage: () => {}, XmrCrypto: X };
        }
    };
}

async function waitFor(pred, ms, what) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
        if (pred()) return true;
        await sleep(5);
    }
    fail('timed out waiting for ' + what);
    return false;
}

const BLOB76 = '0f' + '11'.repeat(75);          // 76 bytes, nonce at 39..42
const SEED = 'cc'.repeat(32);

async function runWorkerTests() {
    // --- a) an easy job must produce a submit-ready share -------------------
    {
        const w = loadWorker(makeStubEngine);
        try {
            w.send({ cmd: 'config', budgetMs: 50 });
            w.send({ cmd: 'start' });

            await sleep(40);
            w.messages.some((m) => m.hashes)
                ? fail('the worker hashed before it had a job') : ok('the worker mines nothing until a job arrives');

            w.send({ cmd: 'job', job: { job_id: 'w1', blob: BLOB76, target: 'ffffffffffffffff', height: 42, seed_hash: SEED } });

            await waitFor(() => w.messages.some((m) => m.share), 8000, 'a difficulty-1 share');

            const states = w.messages.map((m) => m.vm).filter(Boolean);
            states[0] === 'loading' && states.includes('ready') && states.includes('seeded')
                ? ok('worker reports the VM lifecycle loading -> ready -> seeded')
                : fail('vm state messages were ' + JSON.stringify(states));

            const share = w.messages.find((m) => m.share);
            if (!share) return;                 // waitFor already failed loudly
            share.job_id === 'w1' ? ok('the share carries the pool job id') : fail('share job_id = ' + share.job_id);
            share.height === 42 ? ok('the share carries the block height') : fail('share height = ' + share.height);
            /^[0-9a-f]{8}$/.test(String(share.nonce))
                ? ok('the share nonce is 8 hex chars (4 little-endian bytes)') : fail('share nonce = ' + share.nonce);
            /^[0-9a-f]{64}$/.test(String(share.result))
                ? ok('the share result is a 64-hex-char digest') : fail('share result = ' + share.result);

            // Independent verification: a pool rebuilds the blob at the submitted
            // nonce and recomputes the PoW. Do exactly that here.
            const rebuilt = X.blobWithNonce(X.hexToBytes(BLOB76), X.hexToNonce(share.nonce));
            hex(rebuilt.slice(39, 43)) === share.nonce
                ? ok('the submitted nonce really is at blob offset 39') : fail('nonce is not at offset 39');
            const want = STUB_HASH(Buffer.from(rebuilt)).toString('hex');
            want === share.result
                ? ok('the submitted digest is the digest of the blob at the submitted nonce (pool would accept the bytes)')
                : fail('share digest mismatch: ' + share.result + ' != ' + want);
            X.hashMeetsTarget(X.hexToBytes(share.result), X.normalizeJob({ blob: BLOB76, target: 'ffffffffffffffff' }).target)
                ? ok('the submitted digest meets the job target') : fail('the submitted digest misses the target');

            const total = w.messages.filter((m) => m.hashes).reduce((a, m) => a + m.hashes, 0);
            total > 0 ? ok('the worker reports hashes (' + total + ' counted in the batch)') : fail('no hashes reported');
            const bestMsg = w.messages.filter((m) => m.best).pop();
            bestMsg && bestMsg.best.difficulty >= 1 && /^[0-9a-f]{8}$/.test(bestMsg.best.nonce)
                ? ok('the worker reports a live best share (difficulty ' + bestMsg.best.difficulty + ')')
                : fail('no best share was reported');

            w.send({ cmd: 'stop' });
            await sleep(150);
            const settled = w.messages.length;
            await sleep(200);
            w.messages.length === settled
                ? ok('stop halts the loop (no further messages)') : fail('the worker kept mining after stop');
        } finally {
            w.restore();
        }
    }

    // --- b) a hard target: keep hashing, submit nothing, best only improves --
    {
        const w = loadWorker(makeStubEngine);
        try {
            w.send({ cmd: 'config', budgetMs: 40 });
            w.send({ cmd: 'start' });
            // Only a "diff" (no target) -> the 8/16-hex-free path: target = 2^64/1e9.
            w.send({ cmd: 'job', job: { job_id: 'w2', blob: BLOB76, diff: 1e9, height: 99, seed_hash: SEED } });

            await waitFor(() => w.messages.filter((m) => m.hashes).length >= 3, 8000, 'three hashing batches');

            w.messages.some((m) => m.share)
                ? fail('a hash above the pool target was submitted as a share')
                : ok('hashes above the pool target are never submitted');
            const counted = w.messages.filter((m) => m.hashes).reduce((a, m) => a + m.hashes, 0);
            counted > 100 ? ok('the loop keeps hashing under a hard target (' + counted + ' hashes so far)')
                : fail('only ' + counted + ' hashes under a hard target');

            const diffs = w.messages.filter((m) => m.best).map((m) => m.best.difficulty);
            diffs.every((d, i) => i === 0 || d > diffs[i - 1])
                ? ok('the reported best-share difficulty only ever improves (' + diffs.length + ' updates)')
                : fail('best-share difficulty went backwards: ' + diffs.join(','));

            // Drain the loop before the harness is torn down, so no in-flight tick
            // can post into the next test's message list.
            w.send({ cmd: 'stop' });
            await sleep(150);
        } finally {
            w.restore();
        }
    }

    // --- c) no WASM build available: refuse to mine, and say why -------------
    {
        const w = loadWorker(null, (opts) => REAL_LOAD_RANDOMX(
            Object.assign({}, opts, { wasmUrl: 'randomx.wasm', fetch: () => Promise.resolve({ ok: false, status: 404 }) })
        ));
        try {
            w.send({ cmd: 'config', budgetMs: 40 });
            w.send({ cmd: 'job', job: { job_id: 'w3', blob: BLOB76, target: 'ffffffffffffffff', height: 1, seed_hash: SEED } });
            w.send({ cmd: 'start' });

            await waitFor(() => w.messages.some((m) => m.vm === 'unavailable'), 4000, 'the vm:unavailable message');
            const un = w.messages.find((m) => m.vm === 'unavailable');
            un && /randomx\.wasm/.test(un.error)
                ? ok('a missing randomx.wasm is reported to the page ("' + un.error + '")')
                : fail('the unavailable message did not name randomx.wasm: ' + JSON.stringify(un));

            await sleep(200);
            w.messages.some((m) => m.hashes)
                ? fail('the worker mined without a RandomX VM') : ok('the worker refuses to hash without a RandomX VM');
            w.messages.some((m) => m.share)
                ? fail('the worker fabricated a share without a VM') : ok('no fabricated shares when RandomX is unavailable');

            w.send({ cmd: 'stop' });
            await sleep(250);           // one poll interval, so the loop has exited
        } finally {
            w.restore();
        }
    }

    // --- d) loadRandomX() itself: every failure mode is an engine, not a throw
    {
        const eng = await REAL_LOAD_RANDOMX({ wasmUrl: 'missing.wasm', fetch: () => Promise.resolve({ ok: false, status: 404 }) });
        eng.ready === false && /missing\.wasm/.test(eng.error) && /404/.test(eng.error)
            ? ok('loadRandomX reports an HTTP failure ("' + eng.error + '")') : fail('HTTP failure not reported: ' + JSON.stringify(eng));

        const eng2 = await REAL_LOAD_RANDOMX({
            wasmUrl: 'empty.wasm',
            fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) })
        });
        eng2.ready === false && /build it with WebRandomX/.test(eng2.error)
            ? ok('an empty randomx.wasm is reported (with the build hint) instead of instantiated')
            : fail('empty wasm not reported: ' + JSON.stringify(eng2.error));

        const eng3 = await REAL_LOAD_RANDOMX({ wasmUrl: 'x.wasm', fetch: () => Promise.reject(new Error('offline')) });
        eng3.ready === false && /offline/.test(eng3.error)
            ? ok('a network error is surfaced as engine.error instead of an exception') : fail('network error lost');

        // A real (empty) WebAssembly module: instantiation works, the exports are
        // missing, and that must come back as an unusable engine.
        const EMPTY_WASM = Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
        const eng4 = await REAL_LOAD_RANDOMX({
            wasmUrl: 'tiny.wasm',
            fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(EMPTY_WASM.buffer) })
        });
        eng4.ready === false && /exports/.test(eng4.error)
            ? ok('a real but rx_*-less wasm module instantiates and is then rejected with a clear error')
            : fail('an rx_*-less module was accepted: ' + JSON.stringify(eng4.error));

        const eng5 = await REAL_LOAD_RANDOMX({ engine: makeStubEngine() });
        eng5.ready === true ? ok('loadRandomX({ engine }) adopts an already-instantiated module') : fail('pre-built module not adopted');

        const eng6 = await REAL_LOAD_RANDOMX({ wasmUrl: 'not a url' });
        eng6.ready === false ? ok('loadRandomX never throws, even when the fetch itself cannot start') : fail('loadRandomX threw');

        // A hand-built module that imports one WASI function and exports a
        // memory plus a function: enough to prove that the stub set randomx.js
        // passes to WebAssembly.instantiate() really satisfies a standalone
        // module's imports, and that an import it cannot satisfy is named in the
        // error instead of vanishing into a bare InstantiationError.
        const wasiProbe = (importName) => {
            const u = (n) => { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; };
            const name = (s) => { const b = Array.from(Buffer.from(s, 'utf8')); return u(b.length).concat(b); };
            const sec = (id, body) => [id].concat(u(body.length), body);
            const types = [0x60, 0x00, 0x00,                                       // () -> ()
                           0x60, 0x04, 0x7f, 0x7f, 0x7f, 0x7f, 0x01, 0x7f];        // (i32 x4) -> i32
            const body = [0x00, 0x41, 0x00, 0x41, 0x00, 0x41, 0x00, 0x41, 0x00, 0x10, 0x00, 0x1a, 0x0b];
            return Uint8Array.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
                .concat(sec(1, u(2).concat(types)))
                .concat(sec(2, u(1).concat(name('wasi_snapshot_preview1'), name(importName), [0x00], u(1))))
                .concat(sec(3, u(1).concat(u(0))))                  // func 1 is local, type 0
                .concat(sec(5, u(1).concat([0x00], u(1))))          // memory 0, min 1 page
                .concat(sec(7, u(2).concat(name('memory'), [0x02], u(0), name('rx_probe'), [0x00], u(1))))
                .concat(sec(10, u(1).concat(u(body.length), body))));
        };

        const eng7 = await REAL_LOAD_RANDOMX({
            wasmUrl: 'wasi.wasm',
            fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(wasiProbe('fd_write').buffer) })
        });
        (eng7.ready === false && /exports/.test(eng7.error) && !/imports this page/.test(eng7.error))
            ? ok('a module importing wasi_snapshot_preview1.fd_write instantiates through the miner\'s stubs')
            : fail('the stub set did not satisfy a real WASI import: ' + JSON.stringify(eng7.error));

        const eng8 = await REAL_LOAD_RANDOMX({
            wasmUrl: 'wasi2.wasm',
            fetch: () => Promise.resolve({ ok: true, arrayBuffer: () => Promise.resolve(wasiProbe('no_such_function').buffer) })
        });
        (eng8.ready === false && /wasi_snapshot_preview1\.no_such_function/.test(eng8.error))
            ? ok('an import the page cannot satisfy is named in the error ("' + eng8.error.slice(0, 70) + '...")')
            : fail('the missing-import diagnostic lost the import name: ' + JSON.stringify(eng8.error));
    }
}

runWorkerTests().then(() => {
    console.log(failures === 0 ? '\nALL TESTS PASSED' : '\n' + failures + ' TEST(S) FAILED');
    process.exit(failures ? 1 : 0);
});
