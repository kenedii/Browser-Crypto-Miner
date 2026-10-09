/*
 * Regression guard for the extranonce2 length bug.
 *
 * The pool advertises its extranonce2 size in BYTES (4 on btcpowlab, 8 on solo
 * ckpool). randHex() already turns a byte count into hex (it emits bytes*2
 * characters), so the page must call randHex(size) - NOT randHex(size * 2).
 * Passing size*2 sent a double-length extranonce2, which the pool rejects
 * outright (verified live against btcpowlab):
 *     [20, "extranonce2 must contain exactly 4 bytes"]
 *
 * This test (a) exercises the REAL randHex implementation pulled from the
 * sources and (b) fails if the doubled expression is ever reintroduced.
 *
 * Run: node test_en2_size.js
 */
const fs = require('fs');
const path = require('path');

let failures = 0;
const ok = (m) => console.log('PASS:', m);
const fail = (m) => { failures++; console.log('FAIL:', m); };

const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');

// Pull a simple top-level function straight out of a source file and compile it,
// so we assert on the code that actually ships (not a hand-copied clone).
function loadFunction(src, name) {
    const re = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\s*\\}');
    const m = src.match(re);
    if (!m) throw new Error('could not extract function ' + name);
    return new Function('return (' + m[0] + ')')();
}

const minerSrc = read('miner.js');
const workerSrc = read('miner-worker.js');

// (a) The real randHex(bytes) must return exactly bytes*2 lowercase hex chars.
const randHexMiner = loadFunction(minerSrc, 'randHex');
const randHexWorker = loadFunction(workerSrc, 'randHex');
let contractOk = true;
for (const impl of [['miner.js', randHexMiner], ['miner-worker.js', randHexWorker]]) {
    for (const n of [1, 2, 3, 4, 8, 16]) {
        const h = impl[1](n);
        if (h.length !== n * 2 || !/^[0-9a-f]+$/.test(h)) {
            contractOk = false;
            fail(`${impl[0]} randHex(${n}) -> "${h}" (len ${h.length}, expected ${n * 2})`);
        }
    }
}
if (contractOk) ok('randHex(bytes) yields bytes*2 lowercase hex chars in both miner.js and miner-worker.js');
if (randHexMiner(4).length === 8) ok('randHex(4) -> 8 hex chars = exactly 4 bytes (btcpowlab size)');
if (randHexMiner(8).length === 16) ok('randHex(8) -> 16 hex chars = exactly 8 bytes (solo ckpool size)');

// (b) The doubled form must not come back.
let doubled = false;
if (minerSrc.includes('stratumExtranonce2Size || 4) * 2')) { doubled = true; fail('miner.js still contains randHex((stratumExtranonce2Size || 4) * 2)'); }
if (/randHex\(\s*\(.*\)\s*\*\s*2\s*\)/.test(minerSrc)) { doubled = true; fail('miner.js calls randHex with a ")* 2" doubled byte count'); }
if (!doubled) ok('miner.js never doubles the extranonce2 byte count before randHex');

// (c) All five call sites use the byte count directly, and the worker rolls en2 the same way.
const callSites = minerSrc.match(/randHex\(window\.stratumExtranonce2Size \|\| 4\)/g) || [];
if (callSites.length === 5) ok('all 5 extranonce2 call sites use randHex(window.stratumExtranonce2Size || 4)');
else fail('expected 5 correct extranonce2 call sites, found ' + callSites.length);

const randHexCalls = minerSrc.match(/randHex\((?!bytes\b)/g) || [];
if (randHexCalls.length === callSites.length) ok('every randHex(...) call in miner.js is an extranonce2 (no other, doubled call sites)');
else fail('miner.js has ' + randHexCalls.length + ' randHex() calls but only ' + callSites.length + ' use the byte count');

if (/en2\s*=\s*randHex\(en2Size\)/.test(workerSrc)) ok('miner-worker.js rolls en2 with randHex(en2Size) (bytes as advertised)');
else fail('miner-worker.js does not roll en2 with randHex(en2Size)');

console.log(failures === 0 ? '\nALL TESTS PASSED' : '\n' + failures + ' CHECK(S) FAILED');
process.exit(failures ? 1 : 0);
