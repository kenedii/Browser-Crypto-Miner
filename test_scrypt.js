/*
 * Offline unit test for scrypt.js (the Litecoin/Dogecoin proof-of-work math).
 *
 * Anchors, strongest last:
 *   - RFC 7914 section 12 test vector (scrypt("", "", N=16, r=1, p=1, dkLen=64)).
 *   - scryptPow() vs Node's own crypto.scryptSync with the LTC/DOGE parameters
 *     (N=1024, r=1, p=1, dkLen=32) on random 80-byte headers.
 *   - A REAL mined Litecoin header (block 3193876): assembling the fields the way
 *     a block header is serialized must produce a digest that is actually BELOW
 *     that block's target. The odds of that happening by luck are ~2^-58, so it
 *     can only pass if the header layout, the scrypt parameters and the target
 *     math all match Litecoin consensus exactly.
 *   - The LTC genesis header (height 0), same below-target check.
 *   - scrypt.js buildJobContext()/hashNonce() agree with sha256.js on the header
 *     bytes and the digest-word layout, so the LTC/DOGE worker cannot drift from
 *     the (already anchored) Bitcoin job handling.
 *
 * Run: node test_scrypt.js
 */
const crypto = require('crypto');
const SC = require('./sha256.js');
const SCRYPT = require('./scrypt.js');

let failures = 0;
const ok = (m) => console.log('PASS:', m);
const fail = (m) => { failures++; console.log('FAIL:', m); };
const hex = (b) => Buffer.from(b).toString('hex');
const rev = (h) => Buffer.from(h, 'hex').reverse();
const le32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

// ---- 0. parameters match Litecoin/Dogecoin consensus -----------------------
(SCRYPT.SCRYPT_N === 1024 && SCRYPT.SCRYPT_R === 1 && SCRYPT.SCRYPT_P === 1)
    ? ok('scrypt parameters are N=1024, r=1, p=1')
    : fail(`scrypt parameters are N=${SCRYPT.SCRYPT_N}, r=${SCRYPT.SCRYPT_R}, p=${SCRYPT.SCRYPT_P}`);

// ---- 1. RFC 7914 section 12 vector ----------------------------------------
const EMPTY = new Uint8Array(0);
const RFC_VEC = '77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442' +
    'fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906';
hex(SCRYPT.scryptRaw(EMPTY, EMPTY, 16, 1, 1, 64)) === RFC_VEC
    ? ok('RFC 7914 vector: scrypt("", "", 16, 1, 1, 64) matches')
    : fail('RFC 7914 vector mismatch: ' + hex(SCRYPT.scryptRaw(EMPTY, EMPTY, 16, 1, 1, 64)));

// ---- 2. scryptPow() vs Node crypto.scryptSync (the LTC/DOGE oracle) --------
function nodeScrypt(h) {
    return Buffer.from(crypto.scryptSync(Buffer.from(h), Buffer.from(h), 32, { N: 1024, r: 1, p: 1 }));
}
let oracleOk = true;
for (let t = 0; t < 100; t++) {
    const h = crypto.randomBytes(80);
    if (hex(SCRYPT.scryptPow(h)) !== nodeScrypt(h).toString('hex')) {
        oracleOk = false; fail('scryptPow differs from Node crypto.scryptSync at t=' + t); break;
    }
}
oracleOk && ok('scryptPow matches Node crypto.scryptSync (N=1024,r=1,p=1) on 100 random headers');

// ---- 3. REAL mined Litecoin block (height 3193876) -------------------------
// Fields as reported by public explorers; a Bitcoin/Litecoin header stores each
// 32-bit integer little-endian and each hash as the byte-reverse of its display
// hex. That this header hashes BELOW the block's target is the real-chain anchor.
const LTC_BLOCK = {
    version: 536870932,                 // 0x20000014
    prevhash: '5ca346e77cbd0d64c35be1719c3d20a206f1c650c1d55040e891749bc2b9c936',
    merkleroot: 'c738df4cc782fb2859cf5a3ab34af25b39a4f06a2bb3000535d87fa02a9be405',
    ntime: 1791824766, nbits: 422634139, nonce: 1662628891
};
function headerFromBlock(b) {
    return Buffer.concat([
        le32(b.version), rev(b.prevhash), rev(b.merkleroot),
        le32(b.ntime), le32(b.nbits), le32(b.nonce)
    ]);
}
{
    const header = headerFromBlock(LTC_BLOCK);
    header.length === 80 ? ok('LTC block header is 80 bytes') : fail('LTC header length = ' + header.length);
    const digest = SCRYPT.scryptPow(header);
    hex(digest) === nodeScrypt(header).toString('hex')
        ? ok('LTC block 3193876 digest matches Node crypto.scryptSync') : fail('LTC block 3193876 digest mismatch');
    SC.bytesMeetTarget(digest, SC.nbitsToTargetWords(LTC_BLOCK.nbits))
        ? ok('LTC block 3193876 header hashes below its own network target (real-chain anchor)')
        : fail('LTC block 3193876 header did NOT meet its target');
    // The displayed hash is the byte-reverse of the digest (same rule as Bitcoin).
    hex(rev(hex(digest))) === '000000000000002de30821e3907c5bc64000ba393ec525f1bc92d4856f1381fe'
        ? ok('LTC block 3193876 displayed hash = reverse(scrypt(header))') : fail('LTC block 3193876 display hash wrong');
}

// ---- 4. REAL Litecoin genesis header (height 0) ----------------------------
{
    const genesis = {
        version: 1, prevhash: '00'.repeat(32),
        merkleroot: '97ddfbbae6be97fd6cdf3e7ca13232a3afff2353e29badfab7f73011edd4ced9',
        ntime: 1317972665, nbits: 504365040, nonce: 2084524493
    };
    const header = headerFromBlock(genesis);
    const digest = SCRYPT.scryptPow(header);
    hex(digest) === nodeScrypt(header).toString('hex')
        ? ok('LTC genesis digest matches Node crypto.scryptSync') : fail('LTC genesis digest mismatch');
    SC.bytesMeetTarget(digest, SC.nbitsToTargetWords(genesis.nbits))
        ? ok('LTC genesis header hashes below the genesis target (real-chain anchor)')
        : fail('LTC genesis header did NOT meet its target');
}

// ---- 5. job context / nonce hashing agrees with sha256.js ------------------
// A synthetic-but-valid Stratum job (same wire shape LTC/DOGE pools send). The
// header bytes and digest layout must be identical to what sha256.js produces, so
// only the PoW function differs.
const JOB = {
    job_id: 'ltc-test',
    prevhash: 'f0e1d2c3b4a5968778695a4b3c2d1e0f112233445566778899aabbccddeeff00',
    coinb1: '0100000001' + '11'.repeat(32) + 'ffffffff20',
    coinb2: '0a' + 'aa'.repeat(32),
    merkle_branch: ['ab'.repeat(32), 'cd'.repeat(32)],
    version: '20000000', nbits: '1a01ffff', ntime: '65a00000'
};
const EN1 = 'aabbccdd', EN2 = '00000000';
{
    const base = SC.buildJobContext(JOB, EN1, EN2, 1);
    const ctx = SCRYPT.buildJobContext(JOB, EN1, EN2, 1);

    SCRYPT.buildJobContext(JOB, EN1, EN2, 1).header.length === 80
        ? ok('buildJobContext returns an 80-byte header template') : fail('LTC header template length wrong');

    const zeroHeader = SC.headerForNonce(base, 0);
    Buffer.from(ctx.header).equals(zeroHeader)
        ? ok('scrypt header template == sha256.headerForNonce(..., 0)') : fail('scrypt header template differs from sha256');

    // Scrypt stratum difficulty 1 = 0x0000ffff<<224 (65536x easier than SHA-256d's diff 1).
    const poolT1 = 0xffffn << 224n;
    const wordsToBig = (w) => Array.from(w).reduce((a, x) => (a << 32n) | BigInt(x), 0n);
    wordsToBig(SCRYPT.buildJobContext(JOB, EN1, EN2, 1).target) === poolT1
        ? ok('scrypt share target at pool difficulty 1 == 0x0000ffff<<224 (pool convention)') : fail('scrypt diff-1 target is not the scrypt-pool convention');
    wordsToBig(SCRYPT.buildJobContext(JOB, EN1, EN2, 256).target) === poolT1 / 256n
        ? ok('scrypt share target scales as 1/difficulty') : fail('scrypt target does not scale with difficulty');
    wordsToBig(ctx.target) === wordsToBig(base.target) * 65536n
        ? ok('scrypt target == sha256 target x 65536 for the same stratum difficulty') : fail('scrypt/sha256 target ratio is not 65536');

    const s = SCRYPT.makeScratch();
    let jm = 0;
    for (let i = 0; i < 25; i++) {
        const nonce = (Math.random() * 0xffffffff) >>> 0;
        const hdr = SC.headerForNonce(base, nonce);
        const words = SCRYPT.hashNonce(ctx, nonce, s).slice();
        const got = Buffer.alloc(32);
        for (let k = 0; k < 8; k++) got.writeUInt32BE(words[k] >>> 0, k * 4);
        if (!got.equals(nodeScrypt(hdr))) { jm++; if (jm < 3) fail('hashNonce digest != Node scrypt at i=' + i); }
    }
    jm === 0 ? ok('hashNonce == Node scrypt(header) on 25 random nonces') : fail(jm + ' hashNonce digest mismatches');

    // nonceIsValid must agree with an independent bytesMeetTarget over the digest.
    let vm = 0;
    for (let i = 0; i < 50; i++) {
        const nonce = (Math.random() * 0xffffffff) >>> 0;
        const want = SC.bytesMeetTarget(nodeScrypt(SC.headerForNonce(base, nonce)), base.target);
        if (SCRYPT.nonceIsValid(ctx, nonce) !== want) vm++;
    }
    vm === 0 ? ok('nonceIsValid agrees with the independent scrypt verdict on 50 nonces') : fail(vm + ' nonceIsValid mismatches');
}

console.log(failures === 0 ? '\nALL TESTS PASSED' : '\n' + failures + ' TEST(S) FAILED');
process.exit(failures ? 1 : 0);
