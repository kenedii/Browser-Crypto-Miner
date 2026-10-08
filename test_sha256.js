/*
 * Offline unit test for sha256.js (the runtime mining math).
 * Anchors:
 *   - SHA-256 / double-SHA-256 against Node's crypto.
 *   - The stratum prevhash transform against a real captured pool job
 *     (bswap-per-word(prevhash) must equal the internal byte order of the tip).
 *   - The optimized midstate hashing path against the obvious doubleSha256 path.
 * Run: node test_sha256.js
 */
const crypto = require('crypto');
const SC = require('./sha256.js');

let failures = 0;
const ok = (m) => console.log('PASS:', m);
const fail = (m) => { failures++; console.log('FAIL:', m); };
const wordsToBytes = (words) => { const b = new Uint8Array(32); for (let k = 0; k < 8; k++) SC.putU32(b, k * 4, words[k]); return Buffer.from(b); };

// ---- 1. SHA-256 vs Node crypto ------------------------------------------
for (let t = 0; t < 200; t++) {
    const buf = crypto.randomBytes(Math.floor(Math.random() * 200));
    if (!Buffer.from(SC.sha256(new Uint8Array(buf))).equals(crypto.createHash('sha256').update(buf).digest())) { fail('sha256 mismatch'); break; }
}
if (failures === 0) ok('sha256 matches Node crypto on 200 random inputs');

for (let t = 0; t < 200; t++) {
    const buf = crypto.randomBytes(Math.floor(Math.random() * 300));
    const ref = crypto.createHash('sha256').update(crypto.createHash('sha256').update(buf).digest()).digest();
    if (!Buffer.from(SC.doubleSha256(new Uint8Array(buf))).equals(ref)) { fail('doubleSha256 mismatch'); break; }
}
if (failures === 0) ok('doubleSha256 matches Node crypto on 200 random inputs');

// ---- 2. A real captured solo job (block 970513, parent = tip 970512) -----
const TIP_ID = '000000000000000000010b018f9af14fedf9c65900b18adc6c418d56aa1a9aee';
const JOB = {
    job_id: '6ac58e010000142b',
    prevhash: 'aa1a9aee6c418d5600b18adcedf9c6598f9af14f00010b010000000000000000',
    coinb1: '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff370311cf0e000443cdc76a049a5a4b010c',
    coinb2: '0a636b706f6f6c1375772f736f6c6f2e636b706f6f6c2e6f72672ffffffffe03d7e58712000000001976a9148a0a91cb0cb9d5acf6e81af6c7b671f848d6a76988ac72d060000000000016001451ed61d2f6aa260cc72cdf743e4e436a82c010270000000000000000266a24aa21a9ed4b63e7be3ec4a8f5cacd543e9ed3e6ec5c4a9d0800bf59f89a7cd54fd1fadbdb10cf0e00',
    merkle_branch: [
        '9131b14511f527f2a8ba43d8d7d562664a10fd3e148435facaf17f1c0a8f8c65',
        '015323ad3d7b38bceae2349f315d6b8587c3fcffcaed24fbfc856ea7cbfecaca',
        'ef9e6cf4594c8b7c4eaf46bedfa35d1ee88398a914c0d1f98934bc93f91c2817',
        '4eaab4c46416936408ac6772792dc074a46e8342c8b3e193b4fe5b098686437a',
        'ed467ba960470e6a6e2ca15594642ba59a7a8d0ac4098fdb6742996d6c8daf69',
        '6e9357d7a97a7cda36db947ad90a92b6542b4be2a6e4792699bd09d0917c06d4',
        'aa83cd2b253dc3dbc69d422d269772c8edefd3e9c2db333cde8cbb4e7dcc1a1d',
        '93910375f1b9b84e17cff6c0a3684e44bee1eb234deda1c1aaafbdf6999ede28',
        'e462fde2a4ee17b1e72875826690e0c5e85f863617414e15cb67296692bb5179',
        '8ee2f31bae310fc5fdc26a05a9394e22d4758a03d17e55451c2e7bd912112d4a',
        'dd6c9d781bd6f68117ae1c0660c4dad086ddfd6d835d583eb7b5864f95731483',
        '116fcb7a866a4ad102d3e2c3008a9993f4be9038e19669ab389fd555cdc51525',
        '8dc278209e1165cc5fc0d039782e6ad17c22fb3ed4ae042164af6fc79abbb628'
    ],
    version: '20000000',
    nbits: '17021ef0',
    ntime: '6ac7cd43',
    clean_jobs: true
};
const EN1 = '64581b6b';

// prevhash transform: header field == internal byte order of the tip hash.
const internalTip = Buffer.from(TIP_ID, 'hex').reverse().toString('hex');
const got = SC.bytesToHex(SC.stratumPrevhash(JOB.prevhash));
got === internalTip
    ? ok('stratum prevhash transform -> internal tip byte order')
    : fail('prevhash transform wrong: got ' + got + ' want ' + internalTip);

// ---- 3. Optimized midstate path == obvious doubleSha256 path -------------
const ctx = SC.buildJobContext(JOB, EN1, '00000000', 1);
const s = SC.makeScratch();
let mismatches = 0;
for (let i = 0; i < 5000; i++) {
    const nonce = (Math.random() * 0xffffffff) >>> 0;
    const mine = wordsToBytes(SC.hashNonce(ctx, nonce, s));
    const ref = Buffer.from(SC.doubleSha256(SC.headerForNonce(ctx, nonce)));
    if (!mine.equals(ref)) { mismatches++; if (mismatches < 3) fail('hashNonce mismatch nonce=' + nonce.toString(16)); }
}
mismatches === 0
    ? ok('optimized hashNonce == doubleSha256(header) on 5000 random nonces')
    : fail(mismatches + ' hashNonce mismatches');

SC.bytesToHex(SC.headerForNonce(ctx, 0).slice(4, 36)) === internalTip
    ? ok('built header embeds internal (transformed) prevhash')
    : fail('built header prevhash wrong');

// ---- 4. target words ------------------------------------------------------
const t1 = Array.from(SC.computeTargetWords(1), (x) => x >>> 0);
const want1 = [0x00000000, 0xFFFF0000, 0, 0, 0, 0, 0, 0];
JSON.stringify(t1) === JSON.stringify(want1)
    ? ok('difficulty 1 target = 0x00000000FFFF0000...')
    : fail('diff1 target ' + JSON.stringify(t1.map((x) => x.toString(16))));

const easy = SC.computeTargetWords(0.001);
SC.bytesMeetTarget(SC.hexToBytes('00000000FFFF0000' + '0'.repeat(48)), easy) === true
    ? ok('sub-1 difficulty widens the target (browser-usable shares)')
    : fail('sub-1 difficulty did not widen target');

// ---- 5. Share gating: bytes/words target checks vs a BigInt reference ------
// A hash is a share when its byte-reversed ("displayed") value is below the
// target. The real network target is far too strict to ever be met by a random
// nonce, so the previous wordsMeetTarget-vs-nonceIsValid loop passed vacuously
// (both always said "no"). Use a low difficulty so genuine shares actually
// occur and exercise the comparison end to end. This is the regression guard
// for a missing bswap32 in bytesMeetTarget (which silently vetoed real shares).
const lowDiff = 1e-6;
const lowTarget = SC.computeTargetWords(lowDiff);
const lowCtx = SC.buildJobContext(JOB, EN1, '00000000', lowDiff);
let lowTargetVal = 0n;
for (let i = 0; i < 8; i++) lowTargetVal = (lowTargetVal << 32n) | BigInt(lowTarget[i] >>> 0);

let sharesSeen = 0, bytesAccepted = 0, disagree = 0;
for (let i = 0; i < 400000; i++) {
    const nonce = (Math.random() * 0xffffffff) >>> 0;
    const digest = SC.doubleSha256(SC.headerForNonce(ctx, nonce));
    const words = SC.hashNonce(ctx, nonce, s);
    let val = 0n;
    for (let k = 0; k < 8; k++) val = (val << 32n) | BigInt(SC.bswap32(words[7 - k]) >>> 0);
    const ref = val < lowTargetVal;

    const wOk = SC.wordsMeetTarget(words, lowTarget);
    const bOk = SC.bytesMeetTarget(digest, lowTarget);
    const vOk = SC.nonceIsValid(lowCtx, nonce);

    if (ref) { sharesSeen++; if (bOk) bytesAccepted++; }
    if (wOk !== ref || bOk !== ref || vOk !== ref) {
        disagree++;
        if (disagree < 3) fail('target-check disagreement nonce=' + nonce.toString(16) +
            ' ref=' + ref + ' words=' + wOk + ' bytes=' + bOk + ' nonceIsValid=' + vOk);
    }
}
sharesSeen > 0
    ? ok('low-diff scan produced ' + sharesSeen + ' genuine shares (real coverage)')
    : fail('low-diff scan produced no shares (cannot exercise the target check)');
sharesSeen > 0 && bytesAccepted === sharesSeen
    ? ok('bytesMeetTarget accepts every genuine share (' + bytesAccepted + '/' + sharesSeen + ')')
    : fail('bytesMeetTarget rejected genuine shares (' + bytesAccepted + '/' + sharesSeen + ')');
disagree === 0
    ? ok('wordsMeetTarget / bytesMeetTarget / nonceIsValid all match the BigInt reference')
    : fail(disagree + ' target-check disagreements vs reference');

// Deterministic boundary check: build the digest whose displayed value is a
// chosen number and confirm bytesMeetTarget compares that value, not the raw
// digest. One below the diff-1 target passes; one above fails.
const t1Words = SC.computeTargetWords(1);
let t1Val = 0n;
for (let i = 0; i < 8; i++) t1Val = (t1Val << 32n) | BigInt(t1Words[i] >>> 0);
const digestForValue = (v) => {
    const be = new Uint8Array(32);
    for (let i = 31; i >= 0; i--) { be[i] = Number(v & 0xffn); v >>= 8n; }
    return be.reverse();
};
SC.bytesMeetTarget(digestForValue(t1Val - 1n), t1Words) === true
    ? ok('bytesMeetTarget accepts a digest one below the diff-1 target')
    : fail('bytesMeetTarget rejected a digest just below the diff-1 target');
SC.bytesMeetTarget(digestForValue(t1Val + 1n), t1Words) === false
    ? ok('bytesMeetTarget rejects a digest one above the diff-1 target')
    : fail('bytesMeetTarget accepted a digest just above the diff-1 target');

// ---- 6. real network difficulty from nBits -------------------------------
const MAXT = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');

const d1 = SC.nbitsToDifficulty(0x1d00ffff);
Math.abs(d1 - 1) < 1e-9 ? ok('nBits 0x1d00ffff -> network difficulty 1') : fail('nBits 0x1d00ffff -> ' + d1);

const d16307 = SC.nbitsToDifficulty(0x1b0404cb);
Math.abs(d16307 - 16307.420938523983) < 0.01
    ? ok('nBits 0x1b0404cb -> network difficulty ~16307.42')
    : fail('nBits 0x1b0404cb -> ' + d16307);

JSON.stringify(Array.from(SC.nbitsToTargetWords(0x1d00ffff), (x) => x >>> 0)) === JSON.stringify(want1)
    ? ok('nBits 0x1d00ffff target words == difficulty-1 target words')
    : fail('nBits target words wrong');

// hashDifficulty is measured on the same scale as the network difficulty, so a
// found hash can be compared directly against it. Validate the ordering/value
// against the raw digest bytes (independent of the wordsToValue path).
let hdOk = true;
for (let i = 0; i < 500; i++) {
    const nonce = (Math.random() * 0xffffffff) >>> 0;
    const words = SC.hashNonce(ctx, nonce, s);
    const dispHex = Buffer.from(wordsToBytes(words)).reverse().toString('hex');
    const expect = Number((MAXT * 1000000n) / BigInt('0x' + dispHex)) / 1000000;
    if (Math.abs(SC.hashDifficulty(words) - expect) > 1e-6) { hdOk = false; fail('hashDifficulty mismatch nonce=' + nonce.toString(16)); break; }
}
hdOk ? ok('hashDifficulty == diff-1 target / displayed-hash value') : null;

// A share target is a low bar; the real network target is far stricter. Random
// hashes should fail the network target (i.e. share != block).
const netWords = SC.nbitsToTargetWords(0x17021ef0);
let met = false;
for (let i = 0; i < 200; i++) {
    if (SC.wordsMeetTarget(SC.hashNonce(ctx, (Math.random() * 0xffffffff) >>> 0, s), netWords)) { met = true; break; }
}
!met ? ok('200 random hashes all fail the real network target (share != block)') : fail('a random hash met the network target (?!)');

console.log(failures === 0 ? '\nALL TESTS PASSED' : '\n' + failures + ' TEST(S) FAILED');
process.exit(failures ? 1 : 0);
