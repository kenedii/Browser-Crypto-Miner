// Local integration test: fake BTC stratum pool -> bridge -> WebSocket client.
// This stub is a local mock only; it performs no real network mining.
const net = require('net');
const WebSocket = require('ws');
const { spawn } = require('child_process');

const BRIDGE_DIR = __dirname;
const BRIDGE_PORT = 8090;
const FAKE_POOL_PORT = parseInt(process.env.FAKE_POOL_PORT || '3333', 10);

console.log('Starting local integration test: fake BTC pool -> bridge -> WebSocket client');

let receivedData = '';

const fakePool = net.createServer((socket) => {
    console.log('Fake BTC pool: client connected');
    socket.on('data', (data) => {
        const s = data.toString();
        console.log('Fake BTC pool received:', s.replace(/\n/g, '\\n'));
        receivedData += s;
        // Reply so the client observes traffic flowing both ways.
        socket.write(JSON.stringify({
            id: 1,
            result: [[["mining.notify", "1"]], "extranonce1", 4],
            error: null
        }) + '\n');
    });
    socket.on('error', (err) => {
        console.warn('Fake BTC pool socket error (ignored):', err && err.message);
    });
});

fakePool.listen(FAKE_POOL_PORT, '127.0.0.1', () => {
    console.log(`Fake BTC pool listening on 127.0.0.1:${FAKE_POOL_PORT}`);

    // Start the bridge as a child process with env overrides
    const bridgeProc = spawn(process.execPath, ['bridge.js'], {
        cwd: BRIDGE_DIR,
        env: Object.assign({}, process.env, {
            PORT: String(BRIDGE_PORT),
            BTC_POOL_HOST: '127.0.0.1',
            BTC_POOL_PORT: String(FAKE_POOL_PORT)
        }),
        stdio: ['ignore', 'pipe', 'pipe']
    });

    bridgeProc.stdout.on('data', (d) => process.stdout.write('[bridge stdout] ' + d.toString()));
    bridgeProc.stderr.on('data', (d) => process.stderr.write('[bridge stderr] ' + d.toString()));
    bridgeProc.on('exit', (code, sig) => console.log('Bridge exited', code, sig));

    // give bridge a moment to start
    setTimeout(() => {
        const wsUrl = `ws://127.0.0.1:${BRIDGE_PORT}/?coin=BTC`;
        console.log('Connecting WebSocket client to', wsUrl);
        const ws = new WebSocket(wsUrl);

        ws.on('open', () => {
            console.log('WebSocket client open, sending subscribe + authorize');
            ws.send(JSON.stringify({ id: 1, method: 'mining.subscribe', params: ['web-miner/1.0'] }) + '\n');
            ws.send(JSON.stringify({ id: 2, method: 'mining.authorize', params: ['1Datura3728Ch3cGDiSouKcDB7Cxf9vvb6', 'x'] }) + '\n');
        });

        ws.on('message', (msg) => {
            console.log('Client got message from bridge (forwarded from pool):', msg.toString());
        });

        // wait for fake pool to receive data
        const start = Date.now();
        const interval = setInterval(() => {
            if (receivedData.length > 0) {
                console.log('Test success: fake BTC pool received data.');
                clearInterval(interval);
                ws.close();
                bridgeProc.kill();
                fakePool.close(() => process.exit(0));
            } else if (Date.now() - start > 8000) {
                console.error('Test failed: timeout waiting for fake BTC pool data');
                clearInterval(interval);
                ws.close();
                bridgeProc.kill();
                fakePool.close(() => process.exit(2));
            }
        }, 200);
    }, 400);
});
