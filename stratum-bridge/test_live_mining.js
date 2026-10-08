/*
 * Live mining smoke test: connects to the real bridge, gets real jobs from the
 * real pools (solo = ckpool, pplns = btcpowlab), negotiates difficulty and runs
 * the actual CPU mining math for a bounded time. It performs real network work.
 * Run: node _live_mine.js
 */
const WebSocket = require('ws');
const SC = require('../sha256.js');

const ADDR = '1Datura3728Ch3cGDiSouKcDB7Cxf9vvb6';

function mineMode(mode, seconds, suggest) {
    return new Promise((resolve) => {
        const out = { mode, jobs: 0, diff: null, hashes: 0, shareFound: false, auth: null, err: null, close: null };
        const ws = new WebSocket(`wss://stratum.tensors.vip/?coin=BTC&mode=${mode}`);
        let en1 = '', en2Size = 4, ctx = null, nonce = 0, running = true;
        const s = SC.makeScratch();
        const t0 = Date.now();

        function finish() {
            if (!running) return;
            running = false;
            try { ws.close(); } catch (e) {}
            resolve(out);
        }

        function tick() {
            if (!running) return;
            if (!ctx) { setTimeout(tick, 200); return; }
            const BATCH = 100000;
            for (let i = 0; i < BATCH; i++) {
                nonce = (nonce + 1) >>> 0;
                out.hashes++;
                if (SC.wordsMeetTarget(SC.hashNonce(ctx, nonce, s), ctx.target)) { out.shareFound = true; finish(); return; }
            }
            if (Date.now() - t0 < seconds * 1000) setTimeout(tick, 0);
            else finish();
        }

        ws.on('open', () => ws.send(JSON.stringify({ id: 1, method: 'mining.subscribe', params: ['live-test'] }) + '\n'));
        ws.on('message', (m) => {
            let msg; try { msg = JSON.parse(m.toString()); } catch (e) { return; }
            if (msg.id === 1 && !msg.error) {
                en1 = msg.result[1]; en2Size = msg.result[2] || 4;
                const user = ADDR + (mode === 'pplns' ? '.browser' : '');
                ws.send(JSON.stringify({ id: 2, method: 'mining.authorize', params: [user, 'x'] }) + '\n');
            }
            if (msg.id === 2) {
                out.auth = msg.result;
                try { ws.send(JSON.stringify({ id: 3, method: 'mining.suggest_difficulty', params: [suggest] })); } catch (e) {}
                setTimeout(tick, 0);
            }
            if (msg.method === 'mining.set_difficulty') out.diff = msg.params[0];
            if (msg.method === 'mining.notify') {
                out.jobs++;
                const p = msg.params;
                const job = { job_id: p[0], prevhash: p[1], coinb1: p[2], coinb2: p[3], merkle_branch: p[4], version: p[5], nbits: p[6], ntime: p[7] };
                // Real network difficulty from the job's own block header nBits.
                out.netDiff = SC.nbitsToDifficulty(parseInt(p[6], 16) >>> 0);
                out.nbits = p[6];
                nonce = (Math.random() * 0xffffffff) >>> 0;
                ctx = SC.buildJobContext(job, en1, Math.floor(Math.random() * 0xffffffff).toString(16).padStart(en2Size * 2, '0'), out.diff || 1);
            }
        });
        ws.on('error', (e) => { out.err = e.message; finish(); });
        ws.on('close', (c, r) => { out.close = c; finish(); });
        setTimeout(finish, (seconds + 10) * 1000);
    });
}

(async () => {
    for (const mode of ['solo', 'pplns']) {
        const r = await mineMode(mode, 20, 1);
        const rate = r.hashes / 20;
        console.log(`[${mode}] auth=${r.auth} jobs=${r.jobs} poolDiff(share)=${r.diff} hashes=${r.hashes.toLocaleString()} (~${(rate / 1e6).toFixed(2)} MH/s) shareFound=${r.shareFound} err=${r.err || '-'}`);
        if (r.netDiff) console.log(`        real network difficulty (from live job nBits ${r.nbits}) = ${(r.netDiff / 1e12).toFixed(3)} T  <-- a block needs a hash this rare; a share does NOT`);
        if (r.diff) console.log(`        at share diff ${r.diff}: ~${Math.round((r.diff * Math.pow(2, 32)) / Math.max(rate, 1)).toLocaleString()}s per share (this machine)`);
    }
    process.exit(0);
})();
