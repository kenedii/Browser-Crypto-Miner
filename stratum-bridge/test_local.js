const net = require('net');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const path = require('path');

const BRIDGE_DIR = __dirname;
const BRIDGE_PORT = 8090;
const FAKE_P2POOL_PORT = parseInt(process.env.P2POOL_PORT || '3335', 10);

console.log('Starting local integration test: fake p2pool -> bridge -> WebSocket client');

let receivedData = '';

const fakePool = net.createServer((socket) => {
    console.log('Fake P2Pool: client connected');
    socket.on('data', (data) => {
        const s = data.toString();
        console.log('Fake P2Pool received:', s.replace(/\n/g, '\\n'));
        receivedData += s;
    });
    socket.on('error', (err) => {
        console.warn('Fake P2Pool socket error (ignored):', err && err.message);
    });
});

fakePool.listen(FAKE_P2POOL_PORT, '127.0.0.1', () => {
    console.log(`Fake P2Pool listening on 127.0.0.1:${FAKE_P2POOL_PORT}`);

    // Start the bridge as a child process with env overrides
    const bridgeProc = spawn(process.execPath, ['bridge.js'], {
        cwd: BRIDGE_DIR,
        env: Object.assign({}, process.env, {
            PORT: String(BRIDGE_PORT),
            P2POOL_HOST: '127.0.0.1',
            P2POOL_PORT: String(FAKE_P2POOL_PORT)
        }),
        stdio: ['ignore', 'pipe', 'pipe']
    });

    bridgeProc.stdout.on('data', (d) => {
        process.stdout.write('[bridge stdout] ' + d.toString());
    });
    bridgeProc.stderr.on('data', (d) => {
        process.stderr.write('[bridge stderr] ' + d.toString());
    });

    bridgeProc.on('exit', (code, sig) => {
        console.log('Bridge exited', code, sig);
    });

    // give bridge a moment to start
    setTimeout(() => {
        const wsUrl = `ws://127.0.0.1:${BRIDGE_PORT}/?coin=XMR&pool=p2pool`;
        console.log('Connecting WebSocket client to', wsUrl);
        const ws = new WebSocket(wsUrl);

        ws.on('open', () => {
            console.log('WebSocket client open, sending login');
            const login = JSON.stringify({
                id: 1,
                jsonrpc: '2.0',
                method: 'login',
                params: { login: 'user_wallet', pass: 'x' }
            });
            ws.send(login);
        });

        ws.on('message', (msg) => {
            console.log('Client got message from bridge (forwarded from pool):', msg.toString());
        });

        // wait for fake pool to receive data
        const start = Date.now();
        const interval = setInterval(() => {
            if (receivedData.length > 0) {
                console.log('Test success: fake pool received data.');
                clearInterval(interval);
                ws.close();
                bridgeProc.kill();
                fakePool.close(() => process.exit(0));
            } else if (Date.now() - start > 8000) {
                console.error('Test failed: timeout waiting for fake pool data');
                clearInterval(interval);
                ws.close();
                bridgeProc.kill();
                fakePool.close(() => process.exit(2));
            }
        }, 200);

    }, 400);
});
