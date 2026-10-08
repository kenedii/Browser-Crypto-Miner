/*
 * miner-worker.js - CPU mining worker (one per thread).
 *
 * Imports the shared mining math (sha256.js) and searches 32-bit nonce ranges
 * for the current stratum job, reporting completed hashes and any found shares
 * back to the page. When the nonce space is exhausted a fresh extranonce2 is
 * rolled (which changes the coinbase/merkle root and therefore the midstate).
 */
importScripts('sha256.js');
var SC = self.SHA256Crypto;

var isMining = false;
var running = false;
var job = null;
var en1 = '';
var en2 = '';
var en2Size = 4;      // bytes
var difficulty = 1;
var ctx = null;
var nonce = 0;
var scratch = SC.makeScratch();

var BATCH = 40000;

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
    ctx = SC.buildJobContext(job, en1, en2, difficulty);
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
        var words = SC.hashNonce(ctx, nonce, scratch);
        if (SC.wordsMeetTarget(words, ctx.target)) {
            // Re-verify on the obvious path so a bug can never submit junk.
            if (SC.nonceIsValid(ctx, nonce)) { found = nonce; break; }
        }
    }

    self.postMessage({ hashes: i });
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
