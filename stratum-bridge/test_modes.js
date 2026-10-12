// Verifies the bridge's multi-coin mode routing:
//  - every coin (BTC / LTC / DOGE / XMR) in both real modes (solo, pplns)
//    reaches the upstream that belongs to it. Each coin+mode gets its own mock
//    pool, so a copy-paste slip in the COINS table (two coins pointed at the
//    same upstream) cannot hide behind a shared connection counter.
//  - mode=merged routes both scrypt coins to the one LTC-parented merged pool
//    (Litecoin is the parent chain there) and refuses the coins it cannot apply
//    to, with a reason that says why.
//  - the XMR (xmrig-style "login / job / submit") dialect is relayed both ways,
//    not just the Bitcoin-style "subscribe / notify" one.
//  - mode=custom rejects blocked hosts and disallowed ports; an unknown coin is
//    rejected outright.
// Local mocks only; it performs no real network mining.
const net = require('net');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BRIDGE_PORT = 8091;

// One mock pool per coin and mode, on its own port. Merged mining dials a
// single LTC-parented upstream for both scrypt coins, so it gets one mock of its
// own rather than a per-coin pair.
const PORTS = {
    BTC: { solo: 3341, pplns: 3342 },
    LTC: { solo: 3343, pplns: 3344 },
    DOGE: { solo: 3345, pplns: 3346 },
    XMR: { solo: 3347, pplns: 3348 }
};
const MERGED_PORT = 3349;

const pools = {};       // "BTC:solo" -> { port, hits, lastMsg }
const servers = [];

const ok = (m) => console.log('PASS:', m);
const fail = (m) => { console.log('FAIL:', m); process.exitCode = 1; };

// A pool that answers whichever dialect the client speaks: the xmrig login is
// answered with a job, anything Bitcoin-style with a subscribe result.
function poolReply(msg) {
    let parsed = {};
    try { parsed = JSON.parse(msg); } catch (e) {}
    const id = parsed.id === undefined ? 1 : parsed.id;
    if (parsed.method === 'login') {
        return JSON.stringify({
            id,
            result: {
                id: 'client-1',
                job: {
                    blob: '00'.repeat(76),
                    job_id: 'job-1',
                    target: 'ffffffffffffffff',
                    height: 2000000,
                    seed_hash: '11'.repeat(32)
                },
                status: 'OK'
            },
            error: null
        });
    }
    return JSON.stringify({ id, result: [[['mining.notify', '1']], 'en1', 4], error: null });
}

function mockPool(key, port) {
    const rec = { port, hits: 0, lastMsg: null };
    const srv = net.createServer((socket) => {
        socket.on('data', (d) => {
            rec.hits++;
            rec.lastMsg = d.toString().trim().split('\n')[0];
            socket.write(poolReply(rec.lastMsg) + '\n');
        });
        socket.on('error', () => {});
    });
    srv.listen(port, '127.0.0.1');
    servers.push(srv);
    pools[key] = rec;
}

for (const coin of Object.keys(PORTS)) {
    mockPool(`${coin}:solo`, PORTS[coin].solo);
    mockPool(`${coin}:pplns`, PORTS[coin].pplns);
}
mockPool('merged', MERGED_PORT);

// Connect, send one request, and resolve as soon as the pool's reply comes back
// (or the bridge closes the socket, for the rejection cases).
function connect(query, request) {
    return new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/?${query}`);
        let first = null;
        let done = false;
        const finish = (extra) => {
            if (done) return;
            done = true;
            try { ws.close(); } catch (e) {}
            resolve(Object.assign({ first }, extra));
        };
        ws.on('open', () => { if (request) ws.send(JSON.stringify(request) + '\n'); });
        ws.on('message', (m) => { first = m.toString(); finish({ code: null, reason: 'reply' }); });
        ws.on('close', (code, reason) => finish({ code, reason: reason.toString() }));
        ws.on('error', () => finish({ code: null, reason: 'error' }));
        setTimeout(() => finish({ code: null, reason: 'timeout' }), 1500);
    });
}

// Point every coin's upstream at its own mock pool: the bridge must use exactly
// the pair that belongs to the requested coin and mode.
const coinEnv = {
    BTC: ['BTC_POOL_HOST', 'BTC_POOL_PORT', 'PPLNS_POOL_HOST', 'PPLNS_POOL_PORT'],
    LTC: ['LTC_POOL_HOST', 'LTC_POOL_PORT', 'LTC_PPLNS_POOL_HOST', 'LTC_PPLNS_POOL_PORT'],
    DOGE: ['DOGE_POOL_HOST', 'DOGE_POOL_PORT', 'DOGE_PPLNS_POOL_HOST', 'DOGE_PPLNS_POOL_PORT'],
    XMR: ['XMR_POOL_HOST', 'XMR_POOL_PORT', 'XMR_PPLNS_POOL_HOST', 'XMR_PPLNS_POOL_PORT']
};

setTimeout(() => {
    const env = Object.assign({}, process.env, {
        PORT: String(BRIDGE_PORT),
        ALLOW_CUSTOM_POOLS: '1',
        CUSTOM_POOL_PORTS: '3333'
    });
    for (const [coin, names] of Object.entries(coinEnv)) {
        env[names[0]] = '127.0.0.1';
        env[names[1]] = String(PORTS[coin].solo);
        env[names[2]] = '127.0.0.1';
        env[names[3]] = String(PORTS[coin].pplns);
    }
    env.MERGED_POOL_HOST = '127.0.0.1';
    env.MERGED_POOL_PORT = String(MERGED_PORT);

    const bridge = spawn(process.execPath, ['bridge.js'], {
        cwd: __dirname,
        env,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    // The bridge logs the pool it dials for each client: that line is the
    // routing decision under test, independent of the mock that saw the bytes.
    let bridgeLog = '';
    bridge.stdout.on('data', (d) => { bridgeLog += d.toString(); });
    bridge.stderr.on('data', (d) => { bridgeLog += d.toString(); });

    const cleanup = () => {
        try { bridge.kill(); } catch (e) {}
        servers.forEach((s) => { try { s.close(); } catch (e) {} });
    };

    (async () => {
        // Wait for the bridge's startup banner instead of guessing a fixed delay:
        // 'Stratum Bridge on port' is printed just before it starts listening.
        for (let i = 0; i < 30 && !bridgeLog.includes('Stratum Bridge on port'); i++) {
            await new Promise((r) => setTimeout(r, 100));
        }
        await new Promise((r) => setTimeout(r, 150));

        for (const coin of Object.keys(PORTS)) {
            for (const mode of ['solo', 'pplns']) {
                const rec = pools[`${coin}:${mode}`];
                const before = rec.hits;
                const request = coin === 'XMR'
                    ? { id: 1, method: 'login', params: { login: 'test', agent: 'browser' } }
                    : { id: 1, method: 'mining.subscribe', params: ['t'] };

                const r = await connect(`coin=${coin}&mode=${mode}`, request);
                const routed = bridgeLog.includes(`[${coin}/${mode}], routing to 127.0.0.1:${rec.port}`);

                (rec.hits > before && routed)
                    ? ok(`${coin}/${mode} dialed its own upstream (127.0.0.1:${rec.port})`)
                    : fail(`${coin}/${mode} did not reach 127.0.0.1:${rec.port} (hits=${rec.hits - before}, routed=${routed})`);

                r.first
                    ? ok(`${coin}/${mode} relayed the pool's ${coin === 'XMR' ? 'login' : 'subscribe'} reply back to the client`)
                    : fail(`${coin}/${mode} got no reply from the pool (${r.reason})`);
            }
        }

        // Merged mining: both scrypt coins must dial the same LTC-parented
        // upstream (Litecoin is the parent chain, the pool embeds the DOGE
        // block), and the coins that cannot be merged must be refused with a
        // message that explains why.
        for (const coin of ['LTC', 'DOGE']) {
            const mergedRec = pools['merged'];
            const before = mergedRec.hits;
            const r = await connect(`coin=${coin}&mode=merged`, { id: 1, method: 'mining.subscribe', params: ['t'] });
            const routed = bridgeLog.includes(`[${coin}/merged], routing to 127.0.0.1:${MERGED_PORT}`);
            (mergedRec.hits > before && routed)
                ? ok(`${coin}/merged dialed the merged upstream (127.0.0.1:${MERGED_PORT})`)
                : fail(`${coin}/merged did not reach the merged pool (hits=${mergedRec.hits - before}, routed=${routed})`);
            r.first
                ? ok(`${coin}/merged relayed the pool's reply back to the client`)
                : fail(`${coin}/merged got no reply from the pool (${r.reason})`);
        }

        for (const coin of ['BTC', 'XMR']) {
            const r = await connect(`coin=${coin}&mode=merged`);
            /merged/i.test(r.reason || '')
                ? ok(`${coin}/merged refused (merged mining is parented on Litecoin)`)
                : fail(`${coin}/merged was not refused: ${JSON.stringify(r)}`);
        }

        // A bare ?coin=BTC (no mode) is solo - the frontend's default.
        const bare = await connect('coin=BTC', { id: 1, method: 'mining.subscribe', params: ['t'] });
        (bare.first && bridgeLog.includes(`[BTC/solo], routing to 127.0.0.1:${pools['BTC:solo'].port}`))
            ? ok('bare ?coin=BTC defaults to solo')
            : fail('bare ?coin=BTC did not default to solo');

        const unsupported = await connect('coin=ETH&mode=solo');
        (unsupported.reason || '').toLowerCase().includes('unsupported')
            ? ok('unsupported coin rejected')
            : fail('unsupported coin not rejected: ' + JSON.stringify(unsupported));

        const blocked = await connect('coin=BTC&mode=custom&host=127.0.0.1&port=3333');
        (blocked.reason || '').toLowerCase().includes('host')
            ? ok('custom blocked host rejected') : fail('custom blocked host not rejected: ' + JSON.stringify(blocked));

        const badPort = await connect('coin=BTC&mode=custom&host=pool.example.com&port=1234');
        (badPort.reason || '').toLowerCase().includes('port')
            ? ok('custom disallowed port rejected') : fail('custom disallowed port not rejected: ' + JSON.stringify(badPort));

        // The shipped defaults (used when no env override is set) must stay real
        // pools, per coin: a typo here would only show up in production.
        const src = fs.readFileSync(path.join(__dirname, 'bridge.js'), 'utf8');
        const defaults = ['stratum.btcpowlab-pool.com', 'ltc.viabtc.io', 'doge.mine.zpool.ca', 'pool.supportxmr.com', 'ltc.f2pool.com'];
        const missing = defaults.filter((h) => !src.includes(`'${h}'`) && !src.includes(`"${h}"`));
        missing.length === 0
            ? ok('default upstreams are set for all four coins (' + defaults.join(', ') + ')')
            : fail('missing default upstream(s): ' + missing.join(', '));

        cleanup();
        process.exit(process.exitCode || 0);
    })();
}, 100);
