/*
 * scrypt.js - shared Scrypt / Litecoin + Dogecoin Stratum mining math.
 *
 * Loaded by the page (after sha256.js), imported by the CPU worker
 * (scrypt-worker.js via importScripts), and required directly by the Node tests.
 * Everything here is pure: no DOM, no network, no WebGPU.
 *
 * Litecoin and Dogecoin use the Scrypt proof-of-work (the "N=1024, r=1, p=1"
 * profile) over the exact same 80-byte block header Bitcoin uses. Stratum for
 * these coins is byte-for-byte identical to Bitcoin's (subscribe / authorize /
 * notify with a coinbase split + merkle branch), so all of the header, merkle
 * and target math is *reused* from sha256.js (SHA256Crypto) - only the final
 * proof-of-work hash differs: scrypt(header) instead of double-SHA256(header).
 *
 * scrypt(header) is a memory-hard KDF:
 *     B  = PBKDF2-HMAC-SHA256(P = header, S = header, c = 1, dkLen = 128)
 *     B' = ROMix(B, N)          (BlockMix + Salsa20/8, N = 1024)
 *     DK = PBKDF2-HMAC-SHA256(P = header, S = B', c = 1, dkLen = 32)
 * The two PBKDF2 calls are the "final" step; ROMix is the expensive middle. DK
 * is the 32-byte block hash the network target is compared against.
 *
 * `scryptRaw` (general N/r/p) is the obviously-correct reference used by the
 * tests; `scryptPow` is the fixed-parameter, reusable-scratch version used at
 * runtime. The unit test asserts scryptPow agrees with Node's own crypto.scrypt
 * and with the RFC 7914 test vector.
 */
(function (root, factory) {
    var SHA = (root && root.SHA256Crypto) ||
        (typeof require === 'function' ? require('./sha256.js') : null);
    var api = factory(SHA);
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.ScryptCrypto = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function (SHA) {
    'use strict';

    if (!SHA) throw new Error('scrypt.js requires sha256.js (SHA256Crypto) to be loaded first');

    // Litecoin / Dogecoin proof-of-work parameters.
    var SCRYPT_N = 1024;   // CPU/memory cost
    var SCRYPT_R = 1;      // block size (only r = 1 is used by LTC/DOGE)
    var SCRYPT_P = 1;      // parallelisation
    var BLOCK_BYTES = 128; // 128 * r

    function rotl(x, n) { return ((x << n) | (x >>> (32 - n))) >>> 0; }

    // Salsa20/8 core, operating in place on 16 little-endian 32-bit words (64
    // bytes). Eight rounds = four column/row round pairs.
    function salsa20_8(B) {
        var x0 = B[0], x1 = B[1], x2 = B[2], x3 = B[3], x4 = B[4], x5 = B[5], x6 = B[6], x7 = B[7],
            x8 = B[8], x9 = B[9], x10 = B[10], x11 = B[11], x12 = B[12], x13 = B[13], x14 = B[14], x15 = B[15];
        for (var i = 0; i < 8; i += 2) {
            x4 ^= rotl((x0 + x12) | 0, 7); x8 ^= rotl((x4 + x0) | 0, 9);
            x12 ^= rotl((x8 + x4) | 0, 13); x0 ^= rotl((x12 + x8) | 0, 18);
            x9 ^= rotl((x5 + x1) | 0, 7); x13 ^= rotl((x9 + x5) | 0, 9);
            x1 ^= rotl((x13 + x9) | 0, 13); x5 ^= rotl((x1 + x13) | 0, 18);
            x14 ^= rotl((x10 + x6) | 0, 7); x2 ^= rotl((x14 + x10) | 0, 9);
            x6 ^= rotl((x2 + x14) | 0, 13); x10 ^= rotl((x6 + x2) | 0, 18);
            x3 ^= rotl((x15 + x11) | 0, 7); x7 ^= rotl((x3 + x15) | 0, 9);
            x11 ^= rotl((x7 + x3) | 0, 13); x15 ^= rotl((x11 + x7) | 0, 18);

            x1 ^= rotl((x0 + x3) | 0, 7); x2 ^= rotl((x1 + x0) | 0, 9);
            x3 ^= rotl((x2 + x1) | 0, 13); x0 ^= rotl((x3 + x2) | 0, 18);
            x6 ^= rotl((x5 + x4) | 0, 7); x7 ^= rotl((x6 + x5) | 0, 9);
            x4 ^= rotl((x7 + x6) | 0, 13); x5 ^= rotl((x4 + x7) | 0, 18);
            x11 ^= rotl((x10 + x9) | 0, 7); x8 ^= rotl((x11 + x10) | 0, 9);
            x9 ^= rotl((x8 + x11) | 0, 13); x10 ^= rotl((x9 + x8) | 0, 18);
            x12 ^= rotl((x15 + x14) | 0, 7); x13 ^= rotl((x12 + x15) | 0, 9);
            x14 ^= rotl((x13 + x12) | 0, 13); x15 ^= rotl((x14 + x13) | 0, 18);
        }
        B[0] = (B[0] + x0) | 0; B[1] = (B[1] + x1) | 0; B[2] = (B[2] + x2) | 0; B[3] = (B[3] + x3) | 0;
        B[4] = (B[4] + x4) | 0; B[5] = (B[5] + x5) | 0; B[6] = (B[6] + x6) | 0; B[7] = (B[7] + x7) | 0;
        B[8] = (B[8] + x8) | 0; B[9] = (B[9] + x9) | 0; B[10] = (B[10] + x10) | 0; B[11] = (B[11] + x11) | 0;
        B[12] = (B[12] + x12) | 0; B[13] = (B[13] + x13) | 0; B[14] = (B[14] + x14) | 0; B[15] = (B[15] + x15) | 0;
    }

    // ---- HMAC-SHA256 / PBKDF2 (c = 1) ---------------------------------------

    function hmacSha256(key, msg) {
        var k = (key.length > 64) ? SHA.sha256(key) : key;
        var ipad = new Uint8Array(64 + msg.length);
        var opad = new Uint8Array(64 + 32);
        for (var i = 0; i < 64; i++) {
            var kb = i < k.length ? k[i] : 0;
            ipad[i] = kb ^ 0x36;
            opad[i] = kb ^ 0x5c;
        }
        ipad.set(msg, 64);
        opad.set(SHA.sha256(ipad), 64);
        return SHA.sha256(opad);
    }

    // PBKDF2-HMAC-SHA256 with iteration count 1 (what scrypt uses for both the
    // expansion and the final derivation). `password` may be any length.
    function pbkdf2Sha256(password, salt, dkLen) {
        var out = new Uint8Array(dkLen);
        var block = new Uint8Array(salt.length + 4);
        block.set(salt, 0);
        var nBlocks = Math.ceil(dkLen / 32);
        for (var b = 1; b <= nBlocks; b++) {
            block[salt.length] = (b >>> 24) & 0xff;
            block[salt.length + 1] = (b >>> 16) & 0xff;
            block[salt.length + 2] = (b >>> 8) & 0xff;
            block[salt.length + 3] = b & 0xff;
            var u = hmacSha256(password, block); // U1 (c = 1)
            out.set(u.subarray(0, Math.min(32, dkLen - (b - 1) * 32)), (b - 1) * 32);
        }
        return out;
    }

    // ---- ROMix (r = 1) -------------------------------------------------------

    // Reusable V + BlockMix temporaries. One worker/thread calls these
    // sequentially, so shared module-level scratch is safe and keeps the hot
    // loop allocation-free.
    var Vcache = null;
    var bmT = new Uint32Array(16);
    var bmY0 = new Uint32Array(16);
    var bmY1 = new Uint32Array(16);

    function getV(N) {
        if (!Vcache || Vcache.length < N * 32) Vcache = new Uint32Array(N * 32);
        return Vcache;
    }

    // BlockMix over one 128-byte (32-word) block, in place. r = 1: two 64-byte
    // sub-blocks; output order is Y0 || Y1.
    function blockMix(X) {
        var k;
        bmT.set(X.subarray(16, 32));            // start from the last sub-block
        for (k = 0; k < 16; k++) bmT[k] ^= X[k];
        salsa20_8(bmT);
        bmY0.set(bmT);
        for (k = 0; k < 16; k++) bmT[k] ^= X[16 + k];
        salsa20_8(bmT);
        bmY1.set(bmT);
        X.set(bmY0, 0);
        X.set(bmY1, 16);
    }

    // ROMix: fill V, then random-access XOR against it. X is Uint32Array(32)
    // (128 bytes of little-endian words) and is mixed in place.
    function romix(X, N) {
        var V = getV(N);
        var i, k, off;
        for (i = 0; i < N; i++) {
            V.set(X, i * 32);
            blockMix(X);
        }
        for (i = 0; i < N; i++) {
            var j = X[16] & (N - 1);           // Integerify(X) mod N, N a power of two
            off = j * 32;
            for (k = 0; k < 32; k++) X[k] ^= V[off + k];
            blockMix(X);
        }
        return X;
    }

    function bytesToWordsLE(bytes, words) {
        for (var i = 0; i < words.length; i++) {
            var o = i * 4;
            words[i] = (bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24)) | 0;
        }
        return words;
    }

    function wordsToBytesLE(words, bytes) {
        for (var i = 0; i < words.length; i++) {
            var w = words[i], o = i * 4;
            bytes[o] = w & 0xff;
            bytes[o + 1] = (w >>> 8) & 0xff;
            bytes[o + 2] = (w >>> 16) & 0xff;
            bytes[o + 3] = (w >>> 24) & 0xff;
        }
        return bytes;
    }

    // General scrypt (r = 1). Reference implementation used by the tests;
    // `password` / `salt` are Uint8Arrays. Returns a fresh Uint8Array(dkLen).
    function scryptRaw(password, salt, N, r, p, dkLen) {
        if (r !== 1) throw new Error('scrypt: only r = 1 is supported');
        var B = pbkdf2Sha256(password, salt, p * BLOCK_BYTES);
        var X = new Uint32Array(32);
        for (var i = 0; i < p; i++) {
            bytesToWordsLE(B.subarray(i * BLOCK_BYTES, (i + 1) * BLOCK_BYTES), X);
            romix(X, N);
            wordsToBytesLE(X, B.subarray(i * BLOCK_BYTES, (i + 1) * BLOCK_BYTES));
        }
        return pbkdf2Sha256(password, B, dkLen);
    }

    // The scrypt block hash of an 80-byte header (N=1024, r=1, p=1, dkLen=32).
    // Both the PBKDF2 password and salt are the header itself.
    function scryptPow(header) {
        return scryptRaw(header, header, SCRYPT_N, SCRYPT_R, SCRYPT_P, 32);
    }

    // ---- Stratum job context (header + target) ------------------------------

    // Everything constant for a (job, extranonce1, extranonce2) triple: the
    // 80-byte header template (nonce left zero) and the share target. The merkle
    // root, prevhash transform and target words come straight from SHA256Crypto,
    // so the LTC/DOGE job handling can never drift from the (tested) BTC one.
    //
    // Scrypt stratum difficulty is NOT on Bitcoin's scale: pools (cpuminer,
    // ckpool-scrypt, viabtc, zpool, f2pool ...) define scrypt difficulty 1 as the
    // target 0x0000ffff<<224, which is 65536x easier than SHA-256d's difficulty 1
    // (0x00000000ffff<<208). cpuminer does `diff_to_target(target, diff / 65536)`.
    // So the share target for pool difficulty D is the SHA target for D / 65536.
    // Without this the miner demanded a hash 65536x rarer than the pool asked for
    // and effectively never found a share.
    var STRATUM_DIFF_SCALE = 65536;
    var SCRYPT_MAX_TARGET = 0xffffn << 224n;   // scrypt stratum difficulty 1

    // Eight big-endian words of SCRYPT_MAX_TARGET / difficulty, computed exactly
    // in BigInt (dividing the difficulty by 65536 first would round it).
    function scryptTargetWords(difficulty) {
        var d = (difficulty > 0) ? difficulty : 1;
        var scaled = BigInt(Math.max(1, Math.round(d * 1e9)));
        var hex = ((SCRYPT_MAX_TARGET * 1000000000n) / scaled).toString(16);
        while (hex.length < 64) hex = '0' + hex;
        var out = new Uint32Array(8);
        for (var i = 0; i < 8; i++) out[i] = parseInt(hex.substr(i * 8, 8), 16) >>> 0;
        return out;
    }

    function buildJobContext(job, en1, en2, difficulty) {
        var base = SHA.buildJobContext(job, en1, en2, 1);
        base.target = scryptTargetWords(difficulty);
        var header = new Uint8Array(80);
        SHA.putU32(header, 0, SHA.bswap32(base.version));
        header.set(base.prevhash, 4);
        header.set(base.merkleRoot, 36);
        SHA.putU32(header, 68, base.ntime);
        SHA.putU32(header, 72, base.nbits);
        return {
            header: header,          // bytes 0..75 fixed, 76..79 = nonce
            target: base.target,
            difficulty: difficulty,
            version: base.version,
            nbits: base.nbits,
            merkleRoot: base.merkleRoot
        };
    }

    function makeScratch() {
        return { out: new Uint32Array(8) };
    }

    var sharedOut = new Uint32Array(8);

    // Hash one nonce: write it little-endian into the header, scrypt the header
    // and return the eight big-endian words of the digest (same layout as
    // SHA256Crypto.hashNonce, so wordsMeetTarget / wordsLessThan / hashDifficulty
    // all apply unchanged).
    function hashNonce(ctx, nonce, s) {
        var header = ctx.header;
        SHA.putU32(header, 76, SHA.bswap32(nonce >>> 0));
        var digest = scryptPow(header);
        var out = (s && s.out) || sharedOut;
        for (var i = 0; i < 8; i++) out[i] = SHA.beWord(digest, i * 4);
        return out;
    }

    // Full-path share check for a nonce (rebuilds the header, scrypts it). Unlike
    // the BTC worker this is not a separate "obvious path": scrypt has no faster
    // shortcut, so hashNonce already went through this exact code.
    function nonceIsValid(ctx, nonce) {
        var header = ctx.header;
        var saved = SHA.beWord(header, 76);
        SHA.putU32(header, 76, SHA.bswap32(nonce >>> 0));
        var ok = SHA.bytesMeetTarget(scryptPow(header), ctx.target);
        SHA.putU32(header, 76, saved);
        return ok;
    }

    return {
        scryptRaw: scryptRaw,
        scryptPow: scryptPow,
        salsa20_8: salsa20_8,
        hmacSha256: hmacSha256,
        pbkdf2Sha256: pbkdf2Sha256,
        buildJobContext: buildJobContext,
        makeScratch: makeScratch,
        hashNonce: hashNonce,
        nonceIsValid: nonceIsValid,
        STRATUM_DIFF_SCALE: STRATUM_DIFF_SCALE,
        scryptTargetWords: scryptTargetWords,
        SCRYPT_N: SCRYPT_N,
        SCRYPT_R: SCRYPT_R,
        SCRYPT_P: SCRYPT_P
    };
});
