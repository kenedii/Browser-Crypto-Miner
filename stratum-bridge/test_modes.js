// Verifies the bridge's mode routing:
//  - mode=solo  and mode=pplns reach the configured upstream pool
//  - mode=custom rejects blocked hosts and disallowed ports
// Local mock only; it performs no real network mining.
const net = require('net');
const WebSocket = require('ws');
const { spawn } = require('child_process');

const BRIDGE_PORT = 8091;
const FAKE_POOL_PORT = 3334;

let poolHits = 0;
const ok = (m) => console.log('PASS:', m);
const fail = (m) => { console.log('FAIL:', m); process.exitCode = 1; };

const fakePool = net.createServer((socket) => {
    socket.on('data', () => {
        poolHits++;
        socket.write(JSON.stringify({
            id: 1,
            result: [[["mining.notify", "1"]], "en1", 4],
            error: null
        }) + '\n');
    });
    socket.on('error', () => {});
});

function connectMode(query) {
    return new Promise((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/?coin=BTC&${query}`);
        ws.on('open', () => {
            ws.send(JSON.stringify({ id: 1, method: 'mining.subscribe', params: ['t'] }) + '\n');
        });
        ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
        ws.on('error', () => {});
        setTimeout(() => { try { ws.close(); } catch (e) {} resolve({ code: null, reason: 'open' }); }, 1500);
    });
}

fakePool.listen(FAKE_POOL_PORT, '127.0.0.1', () => {
    const bridge = spawn(process.execPath, ['bridge.js'], {
        cwd: __dirname,
        env: Object.assign({}, process.env, {
            PORT: String(BRIDGE_PORT),
            BTC_POOL_HOST: '127.0.0.1', BTC_POOL_PORT: String(FAKE_POOL_PORT),
            PPLNS_POOL_HOST: '127.0.0.1', PPLNS_POOL_PORT: String(FAKE_POOL_PORT),
            ALLOW_CUSTOM_POOLS: '1',
            CUSTOM_POOL_PORTS: '3333',
            DISABLE_DEV_FEE: '1'
        }),
        stdio: ['ignore', 'ignore', 'ignore']
    });

    const cleanup = () => { try { bridge.kill(); } catch (e) {} fakePool.close(); };

    (async () => {
        await new Promise((r) => setTimeout(r, 500));

        poolHits = 0;
        await connectMode('mode=solo');
        poolHits > 0 ? ok('solo routed to upstream') : fail('solo did not reach upstream');

        poolHits = 0;
        await connectMode('mode=pplns');
        poolHits > 0 ? ok('pplns routed to upstream') : fail('pplns did not reach upstream');

        const blocked = await connectMode('mode=custom&host=127.0.0.1&port=3333');
        (blocked.reason || '').toLowerCase().includes('host')
            ? ok('custom blocked host rejected') : fail('custom blocked host not rejected: ' + JSON.stringify(blocked));

        const badPort = await connectMode('mode=custom&host=pool.example.com&port=1234');
        (badPort.reason || '').toLowerCase().includes('port')
            ? ok('custom disallowed port rejected') : fail('custom disallowed port not rejected: ' + JSON.stringify(badPort));

        const bridgeSrc = require('fs').readFileSync(require('path').join(__dirname, 'bridge.js'), 'utf8');
        bridgeSrc.includes("'stratum.btcpowlab-pool.com'")
            ? ok('default shared pool is btcpowlab') : fail('default shared pool is not btcpowlab');

        cleanup();
        process.exit(process.exitCode || 0);
    })();
});
