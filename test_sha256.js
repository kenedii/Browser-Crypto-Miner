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

// ---- 5. wordsMeetTarget agrees with nonceIsValid --------------------------
let agree = true;
for (let i = 0; i < 3000; i++) {
    const nonce = (Math.random() * 0xffffffff) >>> 0;
    if (SC.wordsMeetTarget(SC.hashNonce(ctx, nonce, s), ctx.target) !== SC.nonceIsValid(ctx, nonce)) { agree = false; break; }
}
agree ? ok('wordsMeetTarget agrees with nonceIsValid') : fail('target check disagreement');

console.log(failures === 0 ? '\nALL TESTS PASSED' : '\n' + failures + ' TEST(S) FAILED');
process.exit(failures ? 1 : 0);
