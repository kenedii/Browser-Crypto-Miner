/*
 * xmr-worker.js - CPU mining worker for Monero / RandomX (one per thread).
 *
 * Mirrors miner-worker.js and scrypt-worker.js - same start/stop/job/difficulty
 * commands, same { hashes } / { best } / { share } messages - so the page can
 * drive BTC, LTC/DOGE and XMR workers through one code path. Only the proof of
 * work differs: RandomX over the pool's block hashing blob (randomx.js) instead
 * of double-SHA-256 or scrypt.
 *
 * RandomX itself is a WebAssembly build (see WebRandomX/). The worker loads it
 * lazily and, importantly, *does not mine* until it is ready: hashing without
 * the real VM would produce garbage that no pool accepts. Until then it keeps
 * the page informed with { vm: 'loading' | 'ready' | 'unavailable' } messages.
 *
 * RandomX is memory-hard: one hash costs tens of milliseconds in WASM, so a
 * "batch" here is a wall-clock budget (~250 ms) rather than a fixed nonce count,
 * and the loop yields between batches so job updates and stop still land.
 */
// In a worker the RandomX math is pulled in with importScripts; under Node (the
// protocol tests) the caller installs a `self` shim carrying XmrCrypto first.
if (typeof importScripts === 'function' && !self.XmrCrypto) importScripts('randomx.js');
var X = self.XmrCrypto;

var isMining = false;
var running = false;
var job = null;
var vm = null;
var vmUrl = 'randomx.wasm';
var vmLoading = false;
var nonce = 0;
var hashesTotal = 0;

var budgetMs = 250;     // wall-clock budget per batch (RandomX is ~10-50 ms/hash)

var bestValue = null;   // rarest PoW value seen (drives the "Best Share" tile)
var bestHash = null;
var bestNonce = 0;
var bestDirty = false;

function now() { return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now(); }

self.onmessage = function (e) {
    var d = e.data;
    if (!d) return;

    if (d.cmd === 'start') {
        isMining = true;
        if (!running) { running = true; loop(); }
    } else if (d.cmd === 'stop') {
        isMining = false;
    } else if (d.cmd === 'config') {
        if (d.wasmUrl) vmUrl = d.wasmUrl;
        if (d.budgetMs) budgetMs = d.budgetMs;
    } else if (d.cmd === 'job') {
        acceptJob(d.job, d.wasmUrl);
    } else if (d.cmd === 'difficulty') {
        // Accepted for protocol parity with the other workers: Monero's target
        // already arrives inside the job, so there is nothing to recompute.
    }
};

// ---- RandomX VM lifecycle -------------------------------------------------
function ensureVm() {
    if (vm || vmLoading) return;
    vmLoading = true;
    self.postMessage({ vm: 'loading' });

    X.loadRandomX({ wasmUrl: vmUrl }).then(function (engine) {
        vmLoading = false;
        vm = engine;
        if (!engine.ready) {
            self.postMessage({ vm: 'unavailable', error: engine.error || 'RandomX WebAssembly module not found' });
            return;
        }
        self.postMessage({ vm: 'ready', version: engine.version });
        seedVm();
    }).catch(function (err) {
        vmLoading = false;
        self.postMessage({ vm: 'unavailable', error: String(err && err.message ? err.message : err) });
    });
}

// Keying the VM for the epoch is expensive (the dataset rebuild dominates), so
// it happens only when the seed hash actually changes - once per epoch.
function seedVm() {
    if (!vm || !vm.ready || !job) return false;
    if (!job.seed_hash) {
        self.postMessage({ vm: 'unavailable', error: 'the pool did not send a seed_hash for this job' });
        return false;
    }
    if (vm.seed === job.seed_hash) return true;
    try {
        vm.initSeed(job.seed_hash);
        self.postMessage({ vm: 'seeded', seed: job.seed_hash.slice(0, 16) });
        return true;
    } catch (err) {
        self.postMessage({ vm: 'unavailable', error: String(err && err.message ? err.message : err) });
        return false;
    }
}

function acceptJob(raw, wasmUrl) {
    if (wasmUrl) vmUrl = wasmUrl;
    var nj = X.normalizeJob(raw);
    if (!nj) {
        self.postMessage({ jobError: 'the pool job has no usable blob/target (expected blob + target hex)' });
        return;
    }
    job = nj;
    // Fresh nonce start every job; the pool re-issues jobs on every new block.
    nonce = (Math.random() * 0xffffffff) >>> 0;
    bestValue = null; bestHash = null; bestDirty = false;
    ensureVm();
    seedVm();
}

// ---- mining loop ----------------------------------------------------------
function loop() {
    if (!isMining) { running = false; return; }

    if (!vm || !vm.ready || !job || !vm.seed) {
        // Waiting on the WASM VM (or a job). Poll cheaply: the page's UI loop
        // keeps running and the VM state messages already told it what is up.
        setTimeout(loop, 200);
        return;
    }

    var started = now();
    var count = 0;
    var found = null;
    var currentJob = job;

    while (now() - started < budgetMs) {
        if (!isMining || job !== currentJob) break;

        nonce = (nonce + 1) >>> 0;
        // Only 4 nonce bytes exist in a Monero blob, so on wrap we simply pick a
        // new random starting point instead of rolling an extranonce2.
        if (nonce === 0) nonce = (Math.random() * 0xffffffff) >>> 0;

        var blob = X.blobWithNonce(currentJob.blob, nonce);
        var hash;
        try {
            hash = vm.hash(blob);
        } catch (err) {
            // A VM that cannot hash (bad build, OOM in WASM) must stop the loop
            // loudly rather than spin silently producing nothing.
            isMining = false;
            running = false;
            self.postMessage({ vm: 'unavailable', error: String(err && err.message ? err.message : err) });
            return;
        }

        count++;

        // Track the rarest hash seen so the page's "Best Share" tile stays live
        // even for hashes below the pool's target (which are never submitted).
        var value = X.hashValue(hash);
        if (bestValue === null || value < bestValue) {
            bestValue = value;
            bestHash = hash;
            bestNonce = nonce;
            bestDirty = true;
        }

        if (value < currentJob.target) { found = { hash: hash, nonce: nonce, value: value }; break; }
    }

    if (count > 0) {
        hashesTotal += count;
        var stats = { hashes: count };
        if (bestDirty && bestHash) {
            bestDirty = false;
            // Rarity on the pool's own scale (MAX64 / value), so it is directly
            // comparable with the job's advertised difficulty.
            stats.best = { difficulty: X.targetToDifficulty(bestValue), nonce: X.nonceToHex(bestNonce) };
        }
        self.postMessage(stats);
    }

    if (found) {
        self.postMessage({
            share: true,
            job_id: currentJob.job_id,
            // xmrig submits the nonce as the hex of its 4 little-endian bytes and
            // the raw digest bytes as-is; see Client::submit in xmrig.
            nonce: X.nonceToHex(found.nonce),
            result: X.bytesToHex(found.hash),
            difficulty: X.targetToDifficulty(found.value),
            height: currentJob.height || 0
        });
    }

    setTimeout(loop, 0);
}

