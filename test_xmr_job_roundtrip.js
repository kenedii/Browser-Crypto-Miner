/*
 * Regression: the page normalizes the pool's Monero job once and posts the result
 * to the worker, which normalizes it again. normalizeJob must be idempotent - it
 * used to re-parse the BigInt target as a string, returned null for real pool
 * targets and the worker logged "the pool job has no usable blob/target", so XMR
 * showed 0 H/s on the live site. Run: node test_xmr_job_roundtrip.js
 */
const X = require('./randomx.js');
let failed = 0;
const ok = (m) => console.log('PASS:', m);
const fail = (m) => { console.log('FAIL:', m); failed++; };

const raw = {
    algo: 'rx/0',
    blob: '1010bbb6b5d60613a7baa1fc37036bcb45796ef4f6ff48103cab0958d42dc49a25a33ffce2519d0000000006e1060851d8ee4c4b03de091c9e9338d0ff52d716ac5f60f6e5ba63f5f1b3372e',
    height: 3782728, job_id: '7826ddc5d7ae3eda', target: 'b2df0000', seed_hash: 'ab'.repeat(32)
};
const once = X.normalizeJob(raw);
once ? ok('real supportxmr-shaped job normalizes') : fail('raw job did not normalize');

const twice = X.normalizeJob(once);
(twice && twice.target === once.target && twice.difficulty === once.difficulty)
    ? ok('normalizing an already-normalized job keeps target and difficulty')
    : fail('normalizing twice broke the job: ' + JSON.stringify(twice && String(twice.target)));

const cloned = X.normalizeJob(structuredClone(once));
(cloned && cloned.target === once.target && cloned.blob.length === once.blob.length && cloned.seed_hash === once.seed_hash)
    ? ok('a job that crossed postMessage (structured clone) is accepted unchanged')
    : fail('structured-cloned job rejected or altered');

// Targets whose decimal form is 8 or 16 digits used to be silently re-read as a hex
// target (wrong difficulty, no error). Check a spread of difficulties.
for (const t of ['ffff0000', 'b88d0600', '7e6b0100', 'f3220000', '3333d303']) {
    const a = X.normalizeJob(Object.assign({}, raw, { target: t }));
    const b = a && X.normalizeJob(structuredClone(a));
    (a && b && a.target === b.target) ? ok('target ' + t + ' survives the page -> worker hand-off')
                                       : fail('target ' + t + ' changed in the hand-off');
}
if (failed) { console.log('\n' + failed + ' TEST(S) FAILED'); process.exit(1); }
console.log('\nALL TESTS PASSED');
