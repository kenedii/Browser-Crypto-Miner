/*
 * sha256.js - shared SHA-256 / Bitcoin Stratum mining math.
 *
 * Loaded by the page (before miner.js), imported by the CPU worker
 * (miner-worker.js via importScripts) and required directly by the Node tests.
 * Everything here is pure: no DOM, no network, no WebGPU.
 *
 * The double-SHA256 proof-of-work path is written twice on purpose:
 *   - `doubleSha256(bytes)`  : the straightforward, obviously-correct version.
 *   - `buildJobContext` + `hashNonce` : the optimized version used at runtime.
 *     It precomputes the SHA-256 midstate of the first 64 bytes of the 80-byte
 *     block header (constant for a given job) so each nonce only pays for the
 *     second header block plus the second SHA-256 application.
 * The unit test asserts the two agree for random nonces on a real job.
 */
(function (root, factory) {
    var api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (root) root.SHA256Crypto = api;
})(typeof self !== 'undefined' ? self : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
    'use strict';

    var K = new Uint32Array([
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
    ]);

    var IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

    // diff-1 target: the Bitcoin "pool difficulty 1" share target.
    var MAX_TARGET = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');

    function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

    // One SHA-256 compression. `w` is a Uint32Array(64) whose first 16 words the
    // caller has filled; words 16..63 are expanded in place. `h` (Uint32Array(8))
    // is updated in place. No allocation -> safe for the hot mining loop.
    function compress(h, w) {
        var i, x, y, s0, s1;
        for (i = 16; i < 64; i++) {
            x = w[i - 15]; y = w[i - 2];
            s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
            s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }
        var a = h[0], b = h[1], c = h[2], d = h[3], e = h[4], f = h[5], g = h[6], hh = h[7];
        for (i = 0; i < 64; i++) {
            var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            var ch = (e & f) ^ (~e & g);
            var t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
            var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            var maj = (a & b) ^ (a & c) ^ (b & c);
            var t2 = (S0 + maj) | 0;
            hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
        }
        h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
        h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
    }

    // Straightforward SHA-256. Returns a fresh Uint8Array(32).
    function sha256(bytes) {
        var len = bytes.length;
        var total = (((len + 8) >> 6) + 1) << 6;      // padded length, multiple of 64
        var msg = new Uint8Array(total);
        msg.set(bytes);
        msg[len] = 0x80;
        var bitLenLo = (len << 3) >>> 0;
        var bitLenHi = Math.floor(len / 536870912);   // (len*8) >>> 32
        msg[total - 8] = (bitLenHi >>> 24) & 0xff; msg[total - 7] = (bitLenHi >>> 16) & 0xff;
        msg[total - 6] = (bitLenHi >>> 8) & 0xff; msg[total - 5] = bitLenHi & 0xff;
        msg[total - 4] = (bitLenLo >>> 24) & 0xff; msg[total - 3] = (bitLenLo >>> 16) & 0xff;
        msg[total - 2] = (bitLenLo >>> 8) & 0xff; msg[total - 1] = bitLenLo & 0xff;

        var h = new Uint32Array(IV);
        var w = new Uint32Array(64);
        for (var off = 0; off < total; off += 64) {
            for (var i = 0; i < 16; i++) {
                var j = off + i * 4;
                w[i] = (msg[j] << 24) | (msg[j + 1] << 16) | (msg[j + 2] << 8) | msg[j + 3];
            }
            compress(h, w);
        }
        var out = new Uint8Array(32);
        for (i = 0; i < 8; i++) {
            out[i * 4] = (h[i] >>> 24) & 0xff; out[i * 4 + 1] = (h[i] >>> 16) & 0xff;
            out[i * 4 + 2] = (h[i] >>> 8) & 0xff; out[i * 4 + 3] = h[i] & 0xff;
        }
        return out;
    }

    function doubleSha256(bytes) { return sha256(sha256(bytes)); }

    // ---- small byte helpers -------------------------------------------------

    function hexToBytes(hex) {
        if (!hex) return new Uint8Array(0);
        var n = (hex.length / 2) | 0;
        var out = new Uint8Array(n);
        for (var i = 0; i < n; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
        return out;
    }

    function bytesToHex(bytes) {
        var s = '';
        for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
        return s;
    }

    // Big-endian 32-bit word at byte offset `o`.
    function beWord(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }

    function bswap32(x) { return (((x & 0xff) << 24) | ((x & 0xff00) << 8) | ((x >>> 8) & 0xff00) | (x >>> 24)) >>> 0; }

    function putU32(b, o, v) { b[o] = (v >>> 24) & 0xff; b[o + 1] = (v >>> 16) & 0xff; b[o + 2] = (v >>> 8) & 0xff; b[o + 3] = v & 0xff; }

    // Stratum sends `prevhash` as eight little-endian 32-bit words. The block
    // header wants the previous block hash in internal (LE) byte order, i.e. the
    // bytes of each 4-byte word reversed. Verified against the live tip (see
    // test_sha256.js).
    function stratumPrevhash(hex) {
        var b = hexToBytes(hex);
        var out = new Uint8Array(32);
        for (var i = 0; i < 32; i += 4) {
            out[i] = b[i + 3]; out[i + 1] = b[i + 2]; out[i + 2] = b[i + 1]; out[i + 3] = b[i];
        }
        return out;
    }

    // Eight big-endian words (most-significant word first) for a 256-bit target.
    function targetToWords(t) {
        var hex = t.toString(16);
        while (hex.length < 64) hex = '0' + hex;
        var out = new Uint32Array(8);
        for (var i = 0; i < 8; i++) out[i] = parseInt(hex.substr(i * 8, 8), 16) >>> 0;
        return out;
    }

    // Convert a (possibly fractional) pool difficulty to eight big-endian target
    // words, most-significant word first.
    function computeTargetWords(difficulty) {
        var d = difficulty || 1;
        if (d < 0) d = 1;
        var scaled = BigInt(Math.max(1, Math.round(d * 1e9)));
        return targetToWords((MAX_TARGET * 1000000000n) / scaled);
    }

    // ---- real network difficulty (from a block header's compact "nBits") -----

    // Decode a compact nBits value into the full 256-bit target as a BigInt: the
    // top byte is the length in bytes, the low 3 bytes are the mantissa, and
    // target = mantissa * 2^(8 * (exponent - 3)).
    function compactToTarget(bits) {
        var b = BigInt(bits >>> 0);
        var exponent = Number((b >> 24n) & 0xffn);
        var mantissa = b & 0x007fffffn;
        if (exponent <= 3) return mantissa >> BigInt(8 * (3 - exponent));
        return mantissa << BigInt(8 * (exponent - 3));
    }

    // Real Bitcoin network difficulty encoded by a compact nBits value:
    // network difficulty = (difficulty-1 target) / target. This is the difficulty
    // a hash must reach to actually solve AND broadcast a block. Share difficulty
    // (what a pool asks for) is deliberately lower and does NOT change this.
    function nbitsToDifficulty(bits) {
        var t = compactToTarget(bits);
        if (t <= 0n) return 0;
        return Number((MAX_TARGET * 1000000n) / t) / 1000000;
    }

    // Eight big-endian target words for the real network target of a nBits value.
    function nbitsToTargetWords(bits) {
        return targetToWords(compactToTarget(bits));
    }

    // Numeric value of the displayed block hash: the digest words reversed to
    // big-endian display order, as one 256-bit BigInt (most-significant first).
    function wordsToValue(words) {
        var v = 0n;
        for (var i = 0; i < 8; i++) v = (v << 32n) | BigInt(bswap32(words[7 - i]));
        return v;
    }

    // Difficulty of a found hash (how rare it is) = difficulty-1 target / value.
    // A hash that can solve a block has hashDifficulty >= the network difficulty.
    function hashDifficulty(words) {
        var v = wordsToValue(words);
        if (v <= 0n) return Infinity;
        return Number((MAX_TARGET * 1000000n) / v) / 1000000;
    }

    // ---- optimized per-job hashing -----------------------------------------

    // Precompute everything that is constant for a (job, extranonce1, extranonce2)
    // triple: the merkle root, the SHA-256 midstate after the first header block,
    // the fixed second-block words and the share target.
    function buildJobContext(job, en1, en2, difficulty) {
        var coinbase = hexToBytes(job.coinb1 + en1 + en2 + job.coinb2);
        var merkle = doubleSha256(coinbase);
        var branch = job.merkle_branch || [];
        for (var i = 0; i < branch.length; i++) {
            var combined = new Uint8Array(64);
            combined.set(merkle, 0);
            combined.set(hexToBytes(branch[i]), 32);
            merkle = doubleSha256(combined);
        }

        var prevhash = stratumPrevhash(job.prevhash);
        var version = parseInt(job.version, 16) >>> 0;

        // First 64 header bytes: version(4) + prevhash(32) + merkle[0..27]
        var w = new Uint32Array(64);
        w[0] = version;
        for (i = 0; i < 8; i++) w[1 + i] = beWord(prevhash, i * 4);
        for (i = 0; i < 7; i++) w[9 + i] = beWord(merkle, i * 4);
        var h = new Uint32Array(IV);
        compress(h, w);

        return {
            midstate: h,
            merkleRoot: merkle,
            prevhash: prevhash,
            version: version,
            w0: beWord(merkle, 28),                 // header bytes 64..67
            ntime: parseInt(job.ntime, 16) >>> 0,
            nbits: parseInt(job.nbits, 16) >>> 0,
            target: computeTargetWords(difficulty),
            difficulty: difficulty
        };
    }

    function makeScratch() {
        return { w: new Uint32Array(64), h: new Uint32Array(8), out: new Uint32Array(8) };
    }

    // Hash one nonce with the optimized path. Fills and returns scratch.out
    // (the eight big-endian words of the final double-SHA256 digest).
    function hashNonce(ctx, nonce, s) {
        s = s || makeScratch();
        var w = s.w, h = s.h, out = s.out, i;
        var ms = ctx.midstate;

        // Second header block: merkle tail | ntime | nbits | nonce | 0x80 .. | len
        w[0] = ctx.w0; w[1] = ctx.ntime; w[2] = ctx.nbits; w[3] = nonce >>> 0;
        w[4] = 0x80000000;
        for (i = 5; i < 15; i++) w[i] = 0;
        w[15] = 640; // 80 bytes * 8 bits

        h[0] = ms[0]; h[1] = ms[1]; h[2] = ms[2]; h[3] = ms[3];
        h[4] = ms[4]; h[5] = ms[5]; h[6] = ms[6]; h[7] = ms[7];
        compress(h, w);

        // Second SHA-256 over the 32-byte intermediate digest.
        for (i = 0; i < 8; i++) w[i] = h[i];
        w[8] = 0x80000000;
        for (i = 9; i < 15; i++) w[i] = 0;
        w[15] = 256; // 32 bytes * 8 bits

        h[0] = IV[0]; h[1] = IV[1]; h[2] = IV[2]; h[3] = IV[3];
        h[4] = IV[4]; h[5] = IV[5]; h[6] = IV[6]; h[7] = IV[7];
        compress(h, w);

        out[0] = h[0]; out[1] = h[1]; out[2] = h[2]; out[3] = h[3];
        out[4] = h[4]; out[5] = h[5]; out[6] = h[6]; out[7] = h[7];
        return out;
    }

    // The displayed block hash reverses both the byte order and the word order of
    // the digest; compare that big-endian value against the target words.
    function wordsMeetTarget(digestWords, targetWords) {
        for (var i = 0; i < 8; i++) {
            var rv = bswap32(digestWords[7 - i]);
            var tv = targetWords[i];
            if (rv < tv) return true;
            if (rv > tv) return false;
        }
        return true;
    }

    function bytesMeetTarget(hash32, targetWords) {
        for (var i = 0; i < 8; i++) {
            // The displayed hash reverses the digest bytes; byte-swap so the
            // comparison uses the same value as wordsMeetTarget / wordsToValue.
            var rv = bswap32(beWord(hash32, (7 - i) * 4));
            var tv = targetWords[i];
            if (rv < tv) return true;
            if (rv > tv) return false;
        }
        return true;
    }

    // Rebuild the full 80-byte header for a nonce (independent checks / CPU
    // share verifier).
    function headerForNonce(ctx, nonce) {
        var header = new Uint8Array(80);
        putU32(header, 0, ctx.version);
        header.set(ctx.prevhash, 4);
        header.set(ctx.merkleRoot, 36);
        putU32(header, 68, ctx.ntime);
        putU32(header, 72, ctx.nbits);
        putU32(header, 76, nonce >>> 0);
        return header;
    }

    // Full-path share check for a nonce (no midstate shortcut).
    function nonceIsValid(ctx, nonce) {
        return bytesMeetTarget(doubleSha256(headerForNonce(ctx, nonce)), ctx.target);
    }

    return {
        sha256: sha256,
        doubleSha256: doubleSha256,
        compress: compress,
        hexToBytes: hexToBytes,
        bytesToHex: bytesToHex,
        beWord: beWord,
        bswap32: bswap32,
        putU32: putU32,
        stratumPrevhash: stratumPrevhash,
        computeTargetWords: computeTargetWords,
        targetToWords: targetToWords,
        compactToTarget: compactToTarget,
        nbitsToDifficulty: nbitsToDifficulty,
        nbitsToTargetWords: nbitsToTargetWords,
        wordsToValue: wordsToValue,
        hashDifficulty: hashDifficulty,
        buildJobContext: buildJobContext,
        makeScratch: makeScratch,
        hashNonce: hashNonce,
        wordsMeetTarget: wordsMeetTarget,
        bytesMeetTarget: bytesMeetTarget,
        headerForNonce: headerForNonce,
        nonceIsValid: nonceIsValid,
        MAX_TARGET: MAX_TARGET
    };
});
