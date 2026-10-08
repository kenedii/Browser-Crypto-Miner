const WebSocket = require('ws');
const net = require('net');

const CONFIG = {
    // Bitcoin (BTC) upstream pools
    // Solo: the miner authorizes with their own address and keeps the full
    // block reward if one of their shares solves a block.
    soloPoolHost: process.env.BTC_POOL_HOST || 'solo.ckpool.org',
    soloPoolPort: parseInt(process.env.BTC_POOL_PORT || '3333', 10),

    // Tensors.vip shared pool (PPLNS - pay per last N shares). Point this at
    // the PPLNS pool backend you operate / have an account with.
    pplnsPoolHost: process.env.PPLNS_POOL_HOST || 'pool.ckpool.org',
    pplnsPoolPort: parseInt(process.env.PPLNS_POOL_PORT || '3333', 10),

    // Developer (dev-fee) Bitcoin address
    btcDevFeeAddress: process.env.BTC_DEV_FEE_ADDRESS || '1Datura3728Ch3cGDiSouKcDB7Cxf9vvb6',

    devFeePercent: 0.25, // 0.25% fee — set to 0 (or DISABLE_DEV_FEE=1) to disable the dev fee entirely
    feeIntervalSeconds: 600, // 10 minute cycle

    // Custom-pool routing: lets a client ask the bridge to dial its own pool.
    // Disable with ALLOW_CUSTOM_POOLS=0; ports must be listed in CUSTOM_POOL_PORTS.
    allowCustomPools: !(process.env.ALLOW_CUSTOM_POOLS === '0' || process.env.ALLOW_CUSTOM_POOLS === 'false'),
    customPoolPorts: (process.env.CUSTOM_POOL_PORTS ||
        '3333,3334,3335,3336,443,4443,4444,8332,8111,9332,9333,8888,14333')
        .split(',')
        .map((p) => parseInt(p.trim(), 10))
        .filter((p) => Number.isInteger(p) && p > 0),

    port: process.env.PORT || 8080
};

// Dev-fee opt-out: DISABLE_DEV_FEE=1 disables the dev-fee reauthorization cycle
// entirely — 100% of hashes credit the user's address.
if (process.env.DISABLE_DEV_FEE === '1' || process.env.DISABLE_DEV_FEE === 'true') {
    CONFIG.devFeePercent = 0;
}

console.log(`Starting BTC Stratum Bridge on port ${CONFIG.port}`);
console.log(`Solo pool:    ${CONFIG.soloPoolHost}:${CONFIG.soloPoolPort}`);
console.log(`PPLNS pool:   ${CONFIG.pplnsPoolHost}:${CONFIG.pplnsPoolPort}`);
console.log(`Custom pools: ${CONFIG.allowCustomPools ? 'ENABLED (ports ' + CONFIG.customPoolPorts.join(', ') + ')' : 'DISABLED'}`);
if (CONFIG.devFeePercent > 0) {
    console.log(`Dev fee: ${CONFIG.devFeePercent}% of every ${CONFIG.feeIntervalSeconds}s cycle -> ${CONFIG.btcDevFeeAddress}`);
} else {
    console.log('Dev fee DISABLED — 100% of mining credits the user address');
}

// Block hostnames/IPs that would turn the bridge into an SSRF proxy into
// private networks. Public hostnames and public IP literals are allowed.
function isBlockedHost(host) {
    const h = String(host || '').trim().toLowerCase();
    if (!h) return true;
    if (h === 'localhost' || h.endsWith('.localhost')) return true;

    const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (v4) {
        const a = parseInt(v4[1], 10);
        const b = parseInt(v4[2], 10);
        if (a === 0 || a === 10 || a === 127) return true;   // this-host / private / loopback
        if (a === 169 && b === 254) return true;             // link-local
        if (a === 172 && b >= 16 && b <= 31) return true;    // private
        if (a === 192 && b === 168) return true;             // private
        if (a === 100 && b >= 64 && b <= 127) return true;   // CGNAT
        if (a >= 224) return true;                           // multicast / reserved
    }

    if (h.includes(':')) {                                    // IPv6 literal
        if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return true;
    }
    return false;
}

// Choose the upstream pool for a client from its query string.
function resolveUpstream(params) {
    const mode = (params.get('mode') || 'solo').toLowerCase();

    if (mode === 'pplns' || mode === 'pool' || mode === 'tensors') {
        return { mode: 'pplns', host: CONFIG.pplnsPoolHost, port: CONFIG.pplnsPoolPort, devFee: CONFIG.devFeePercent > 0 };
    }

    if (mode === 'custom') {
        if (!CONFIG.allowCustomPools) return { error: 'Custom pools are disabled on this bridge' };
        const host = (params.get('host') || '').trim();
        const port = parseInt(params.get('port') || '', 10);
        if (!host || !Number.isInteger(port)) return { error: 'Custom pool requires host and port' };
        if (isBlockedHost(host)) return { error: 'Custom pool host is not allowed' };
        if (!CONFIG.customPoolPorts.includes(port)) return { error: 'Custom pool port ' + port + ' is not allowed' };
        return { mode: 'custom', host, port, devFee: false };
    }

    // Default: solo mining.
    return { mode: 'solo', host: CONFIG.soloPoolHost, port: CONFIG.soloPoolPort, devFee: CONFIG.devFeePercent > 0 };
}

const wss = new WebSocket.Server({ port: CONFIG.port });

wss.on('connection', (ws, req) => {
    let upstream;
    try {
        const url = new URL(req.url || '/', 'http://bridge.local');
        upstream = resolveUpstream(url.searchParams);
    } catch (e) {
        upstream = { error: 'Bad request URL' };
    }

    if (upstream.error) {
        console.warn(`Rejecting client: ${upstream.error}`);
        try { ws.close(1008, upstream.error); } catch (e) {}
        return;
    }

    const poolHost = upstream.host;
    const poolPort = upstream.port;
    const poolMode = upstream.mode;
    const devFeeEnabled = upstream.devFee;
    const devAddress = CONFIG.btcDevFeeAddress;

    console.log(`New client connected [${poolMode}], routing to ${poolHost}:${poolPort}${devFeeEnabled ? ' (dev fee on)' : ''}`);

    // Protocol state for this specific client session
    let poolSocket = new net.Socket();
    let userAuthParams = null; // BTC: [addr, pass]
    let isDevMining = false;
    let feeTimer = null;
    let messageBuffer = '';

    // Connect to upstream pool
    poolSocket.connect(poolPort, poolHost, () => {});

    // Handle Pool -> Client
    poolSocket.on('data', (data) => {
        const chunk = data.toString();
        messageBuffer += chunk;

        let boundary = messageBuffer.indexOf('\n');
        while (boundary !== -1) {
            const message = messageBuffer.substring(0, boundary).trim();
            messageBuffer = messageBuffer.substring(boundary + 1);

            if (message.length > 0) {
                try {
                    // Forward directly to the WS client
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(message);
                    }
                } catch (e) {
                    console.error('Error forwarding to client:', e);
                }
            }
            boundary = messageBuffer.indexOf('\n');
        }
    });

    poolSocket.on('error', () => { ws.close(); });
    poolSocket.on('close', () => { ws.close(); });

    // Fee Logic Functions (only for pools that credit the authorized address)
    const startFeeLoop = () => {
        if (!devFeeEnabled || CONFIG.devFeePercent <= 0) return; // dev fee disabled: never reauthorize to the dev address
        const totalCycleMs = CONFIG.feeIntervalSeconds * 1000;
        const devTimeMs = totalCycleMs * (CONFIG.devFeePercent / 100);
        const userTimeMs = totalCycleMs - devTimeMs;

        const runDevCycle = () => {
            if (ws.readyState !== WebSocket.OPEN || !userAuthParams) return;

            isDevMining = true;

            // Re-authorize with Dev Address
            poolSocket.write(JSON.stringify({
                id: 9999,
                method: "mining.authorize",
                params: [devAddress, "devfee"]
            }) + "\n");

            // Schedule switch back
            feeTimer = setTimeout(() => {
                runUserCycle();
            }, devTimeMs);
        };

        const runUserCycle = () => {
            if (ws.readyState !== WebSocket.OPEN || !userAuthParams) return;

            // Switch back to User
            if (isDevMining) {
                 isDevMining = false;
                 poolSocket.write(JSON.stringify({
                     id: 9998,
                     method: "mining.authorize",
                     params: userAuthParams
                 }) + "\n");
            }

            // Schedule next dev cycle
            feeTimer = setTimeout(() => {
                runDevCycle();
            }, userTimeMs);
        };

        // Start with User Cycle
        feeTimer = setTimeout(runDevCycle, userTimeMs);
    };

    // Handle Client -> Pool
    ws.on('message', (message) => {
        try {
            const strMsg = message.toString().trim();
            if (!strMsg) return;
            const jsonMsg = JSON.parse(strMsg);

            // BTC Auth Interception
            if (jsonMsg.method === 'mining.authorize') {
                userAuthParams = jsonMsg.params;
                if (!feeTimer) startFeeLoop();
            }

            // If we are currently in DevFee mode, a user 'mining.submit' is validated
            // by the pool against the current (dev) auth; nothing extra to do here.

            poolSocket.write(strMsg + "\n");

        } catch (e) {
            console.error('Error handling client message:', e);
        }
    });

    ws.on('close', () => {
        if (feeTimer) clearTimeout(feeTimer);
        poolSocket.destroy();
    });
});
