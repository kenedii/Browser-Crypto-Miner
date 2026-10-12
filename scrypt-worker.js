/*
 * scrypt-worker.js - CPU mining worker for Litecoin / Dogecoin (one per thread).
 *
 * Mirrors miner-worker.js exactly - same start/stop/job/difficulty commands, same
 * { hashes } / { best } / { share } messages - so the page can drive either worker
 * through one code path. The only difference is the proof-of-work: it imports the
 * shared Scrypt math (scrypt.js) instead of double-SHA-256.
 *
 * Scrypt is deliberately memory-hard and roughly 4-5 orders of magnitude slower
 * than SHA-256 in JS, so there is no GPU path and the batch size is small: the
 * worker must return to the event loop often enough to stay responsive.
 */
importScripts('sha256.js', 'scrypt.js');
var SC = self.SHA256Crypto;
var SCRYPT = self.ScryptCrypto;

var isMining = false;
var running = false;
var job = null;
var en1 = '';
var en2 = '';
var en2Size = 4;      // bytes
var difficulty = 1;
var ctx = null;
var nonce = 0;
var scratch = SCRYPT.makeScratch();
var bestWords = null;   // rarest digest seen (drives the page's "Best Share" tile)
var bestNonce = 0;
var bestDirty = false;

// Small on purpose: one scrypt is ~1ms, so ~64 hashes keeps a batch near 60ms and
// leaves the thread responsive to job updates / stop.
var BATCH = 64;

self.onmessage = function (e) {
    var d = e.data;
    if (d.cmd === 'start') {
        isMining = true;
        if (!running) { running = true; loop(); }
    } else if (d.cmd === 'stop') {
        isMining = false;
    } else if (d.cmd === 'job') {
        job = d.job;
        en1 = d.extranonce1 || '';
        en2 = d.en2 || '';
        en2Size = d.extranonce2Size || 4;
        nonce = (Math.random() * 0xffffffff) >>> 0;
        buildCtx();
    } else if (d.cmd === 'difficulty') {
        difficulty = d.difficulty;
        buildCtx();
    }
};

function randHex(bytes) {
    var s = '';
    for (var i = 0; i < bytes * 2; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
}

function buildCtx() {
    if (!job) return;
    ctx = SCRYPT.buildJobContext(job, en1, en2, difficulty);
}

function rollExtranonce2() {
    en2 = randHex(en2Size);
    nonce = 0;
    buildCtx();
}

function loop() {
    if (!isMining) { running = false; return; }
    if (!ctx) { self.postMessage({ hashes: 0 }); setTimeout(loop, 300); return; }

    var found = -1;
    var i;
    for (i = 0; i < BATCH; i++) {
        nonce = (nonce + 1) >>> 0;
        if (nonce === 0) rollExtranonce2();
        var words = SCRYPT.hashNonce(ctx, nonce, scratch);
        // Track the rarest hash seen so the page's "Best Share" tile reflects the
        // best hash found so far, including sub-difficulty-1 hashes (this is the
        // value the pool would compare; it is only a *share* if it also meets
        // ctx.target, which is handled below). Difficulty is measured on the same
        // scale as the pool's (diff-1 target / value), identical to Bitcoin's.
        if (!bestWords) {
            bestWords = new Uint32Array(8);
            bestWords.set(words);
            bestNonce = nonce;
            bestDirty = true;
        } else if (SC.wordsLessThan(words, bestWords)) {
            bestWords.set(words);
            bestNonce = nonce;
            bestDirty = true;
        }
        if (SC.wordsMeetTarget(words, ctx.target)) {
            // Re-verify via the header path: a bug in the word layout could never
            // then submit junk. Cheap because a share is (by design) rare.
            if (SCRYPT.nonceIsValid(ctx, nonce)) { found = nonce; break; }
        }
    }

    var stats = { hashes: i };
    if (bestDirty) {
        bestDirty = false;
        stats.best = {
            difficulty: SC.hashDifficulty(bestWords),
            nonce: (bestNonce >>> 0).toString(16).padStart(8, '0')
        };
    }
    self.postMessage(stats);
    if (found >= 0) {
        self.postMessage({
            share: true,
            job_id: job.job_id,
            en2: en2,
            ntime: job.ntime,
            nonce: (found >>> 0).toString(16).padStart(8, '0'),
            // Rarity of the found hash (diff-1 target / value). Reported so the
            // page can show the best share against the real network difficulty.
            difficulty: SC.hashDifficulty(words)
        });
    }
    setTimeout(loop, 0);
}
