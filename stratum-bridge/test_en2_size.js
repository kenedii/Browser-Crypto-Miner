/*
 * Wire-level regression test for the extranonce2 length bug.
 *
 *   strict mock pool  <->  bridge (real)  <->  client using real sha256.js math
 *
 * The mock behaves like btcpowlab: it advertises a 4-byte extranonce2 and, on
 * mining.submit, rejects any en2 that is not exactly 4 bytes with the real error
 *   [20, "extranonce2 must contain exactly 4 bytes"]
 * (that exact message was observed live against stratum.btcpowlab-pool.com).
 *
 * Two clients mine a genuine share at low difficulty with the real mining math
 * and submit it through the real bridge:
 *   - FIXED client: en2 = randHex(4)  ->  8 hex chars  ->  pool ACCEPTS.
 *   - BUGGY client: en2 = randHex(8)  -> 16 hex chars  ->  pool REJECTS by size.
 *
 * Run: node test_en2_size.js
 */
const net = require('net');
const crypto = require('crypto');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const SC = require('../sha256.js');

const BRIDGE_PORT = 8094;
const MOCK_PORT = 3400;
const DIFF = 0.000001;
const EN1 = '64581b6b';
const EN2SIZE = 4;                 // bytes, as btcpowlab advertises
const USER = '1Datura3728Ch3cGDiSouKcDB7Cxf9vvb6.browser';

const TIP_ID = '000000000000000000010b018f9af14fedf9c65900b18adc6c418d56aa1a9aee';
const JOB = {
    job_id: '6ac58e010000142b',
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
    version: '20000000', nbits: '17021ef0', ntime: '6ac7cd43'
};

let failures = 0;
const ok = (m) => console.log('PASS:', m);
const fail = (m) => { failures++; console.log('FAIL:', m); };

const internalPrevhash = Buffer.from(TIP_ID, 'hex').reverse().toString('hex');
const stratumPrevhash = (() => {
    const b = Buffer.from(internalPrevhash, 'hex');
    const o = Buffer.alloc(32);
    for (let i = 0; i < 32; i += 4) { o[i] = b[i + 3]; o[i + 1] = b[i + 2]; o[i + 2] = b[i + 1]; o[i + 3] = b[i]; }
    return o.toString('hex');
})();

const MAX_TARGET = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
const targetFor = (d) => (MAX_TARGET * 1000000000n) / BigInt(Math.max(1, Math.round(d * 1e9)));
const dsha = (buf) => crypto.createHash('sha256').update(crypto.createHash('sha256').update(buf).digest()).digest();

// Independent share verification (Node crypto + real header byte order).
function verifyShare(en2, ntime, nonceHex) {
    const coinbase = Buffer.from(JOB.coinb1 + EN1 + en2 + JOB.coinb2, 'hex');
    let merkle = dsha(coinbase);
    for (const br of JOB.merkle_branch) merkle = dsha(Buffer.concat([merkle, Buffer.from(br, 'hex')]));
    const header = Buffer.alloc(80);
    header.write(JOB.version, 0, 'hex');
    Buffer.from(internalPrevhash, 'hex').copy(header, 4);
    merkle.copy(header, 36);
    header.write(ntime, 68, 'hex');
    header.write(JOB.nbits, 72, 'hex');
    header.write(nonceHex, 76, 'hex');
    const displayed = Buffer.from(dsha(header)).reverse();
    return BigInt('0x' + displayed.toString('hex')) <= targetFor(DIFF);
}

const stats = { connects: 0, submits: 0, sizeRejected: 0, accepted: 0 };

// --- Strict mock pool: enforces the advertised extranonce2 length ------------
const mock = net.createServer((sock) => {
    stats.connects++;
    let buf = '';
    sock.on('data', (d) => {
        buf += d.toString();
        let i;
        while ((i = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line) continue;
            let msg; try { msg = JSON.parse(line); } catch (e) { continue; }
            if (msg.method === 'mining.subscribe') {
                sock.write(JSON.stringify({ id: msg.id, result: [[['mining.notify', 'mock']], EN1, EN2SIZE], error: null }) + '\n');
            } else if (msg.method === 'mining.authorize') {
                sock.write(JSON.stringify({ id: msg.id, result: true, error: null }) + '\n');
                sock.write(JSON.stringify({ id: null, method: 'mining.set_difficulty', params: [DIFF] }) + '\n');
                sock.write(JSON.stringify({ id: null, method: 'mining.notify', params: [
                    JOB.job_id, stratumPrevhash, JOB.coinb1, JOB.coinb2, JOB.merkle_branch,
                    JOB.version, JOB.nbits, JOB.ntime, true
                ] }) + '\n');
            } else if (msg.method === 'mining.submit') {
                stats.submits++;
                const p = msg.params; // [user, jobId, en2, ntime, nonce]
                if (typeof p[2] !== 'string' || p[2].length !== EN2SIZE * 2) {
                    stats.sizeRejected++;
                    sock.write(JSON.stringify({ id: msg.id, result: false,
                        error: [20, 'extranonce2 must contain exactly ' + EN2SIZE + ' bytes', null] }) + '\n');
                } else {
                    const good = verifyShare(p[2], p[3], p[4]);
                    if (good) stats.accepted++;
                    sock.write(JSON.stringify({ id: msg.id, result: good,
                        error: good ? null : [23, 'Low difficulty share', null] }) + '\n');
                }
            }
        }
    });
    sock.on('error', () => {});
});

// --- Browser client: real mining math, en2 exactly as miner.js generates it ---
function randHex(bytes) {
    let s = '';
    for (let i = 0; i < bytes * 2; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
}

function runClient(buggy) {
    return new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/?coin=BTC&mode=solo`);
        let diff = DIFF, done = false, en2Len = 0, reply = null, foundNonce = null;
        const finish = () => { if (done) return; done = true; try { ws.close(); } catch (e) {} resolve({ buggy, en2Len, reply, foundNonce }); };

        ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'mining.subscribe', params: ['en2-size'] }) + '\n'));
        ws.on('message', (raw) => {
            let msg; try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
            if (msg.id === 1 && !msg.error) ws.send(JSON.stringify({ id: 2, method: 'mining.authorize', params: [USER, 'x'] }) + '\n');
            if (msg.method === 'mining.set_difficulty') diff = msg.params[0];
            if (msg.method === 'mining.notify') handleJob(msg.params, diff);
            if (msg.id === 4) { reply = msg; setTimeout(finish, 150); }
        });
        ws.on('error', () => finish());

        function handleJob(p, d) {
            const job = { job_id: p[0], prevhash: p[1], coinb1: p[2], coinb2: p[3], merkle_branch: p[4], version: p[5], nbits: p[6], ntime: p[7] };
            // The whole point: fixed passes the byte count, buggy doubles it.
            const en2 = buggy ? randHex(EN2SIZE * 2) : randHex(EN2SIZE);
            en2Len = en2.length;
            const ctx = SC.buildJobContext(job, EN1, en2, d);
            const s = SC.makeScratch();
            let found = -1;
            for (let n = 1; n <= 5000000; n++) {
                const nonce = n >>> 0;
                if (SC.wordsMeetTarget(SC.hashNonce(ctx, nonce, s), ctx.target)) { found = nonce; break; }
            }
            if (found >= 0) {
                foundNonce = '0x' + (found >>> 0).toString(16);
                ws.send(JSON.stringify({ id: 4, method: 'mining.submit',
                    params: [USER, job.job_id, en2, job.ntime, (found >>> 0).toString(16).padStart(8, '0')] }) + '\n');
            } else {
                setTimeout(finish, 50);
            }
        }
        setTimeout(() => finish(), 20000);
    });
}

mock.listen(MOCK_PORT, '127.0.0.1', () => {
    const bridge = spawn(process.execPath, ['bridge.js'], {
        cwd: __dirname,
        env: Object.assign({}, process.env, {
            PORT: String(BRIDGE_PORT),
            BTC_POOL_HOST: '127.0.0.1', BTC_POOL_PORT: String(MOCK_PORT),
            DISABLE_DEV_FEE: '1'
        }),
        stdio: ['ignore', 'ignore', 'ignore']
    });
    const cleanup = () => { try { bridge.kill(); } catch (e) {} mock.close(); };

    (async () => {
        await new Promise((r) => setTimeout(r, 600));

        const fixed = await runClient(false);
        console.log(`   FIXED en2 len=${fixed.en2Len} nonce=${fixed.foundNonce} error=${JSON.stringify(fixed.reply && fixed.reply.error)}`);
        const buggy = await runClient(true);
        console.log(`   BUGGY en2 len=${buggy.en2Len} nonce=${buggy.foundNonce} error=${JSON.stringify(buggy.reply && buggy.reply.error)}`);
        console.log(`   pool: connects=${stats.connects} submits=${stats.submits} accepted=${stats.accepted} sizeRejected=${stats.sizeRejected}`);

        fixed.en2Len === 8 ? ok('fixed client sent an 8-hex-char en2 (exactly 4 bytes)') : fail('fixed client en2 length was ' + fixed.en2Len + ', expected 8');
        fixed.reply && fixed.reply.result === true ? ok('FIXED share (4-byte en2) ACCEPTED by the pool') : fail('fixed share was not accepted: ' + JSON.stringify(fixed.reply));
        fixed.foundNonce ? ok('fixed client found a target-meeting share with the real math') : fail('fixed client found no share');

        buggy.en2Len === 16 ? ok('buggy client sent a 16-hex-char en2 (the old doubled bug)') : fail('buggy client en2 length was ' + buggy.en2Len + ', expected 16');
        buggy.reply && buggy.reply.error && buggy.reply.error[0] === 20 ? ok('BUGGY share (doubled en2) rejected by the pool for size - the bug the fix removes') : fail('buggy share was not rejected for size: ' + JSON.stringify(buggy.reply));

        stats.accepted === 1 ? ok('exactly one share reached verification/acceptance (the fixed one)') : fail('accepted count was ' + stats.accepted + ', expected 1');
        stats.sizeRejected === 1 ? ok('the pool rejected exactly one submit for a wrong-sized extranonce2') : fail('size-reject count was ' + stats.sizeRejected + ', expected 1');

        cleanup();
        console.log(failures === 0 ? '\nEN2 SIZE TEST PASSED' : '\n' + failures + ' CHECK(S) FAILED');
        process.exit(failures ? 1 : 0);
    })();
});



