const WebSocket = require('ws');
const net = require('net');

const CONFIG = {
    // Bitcoin (BTC) upstream pool
    btcPoolHost: process.env.BTC_POOL_HOST || 'solo.ckpool.org',
    btcPoolPort: parseInt(process.env.BTC_POOL_PORT || '3333', 10),

    // Developer (dev-fee) Bitcoin address
    btcDevFeeAddress: process.env.BTC_DEV_FEE_ADDRESS || '1Datura3728Ch3cGDiSouKcDB7Cxf9vvb6',

    devFeePercent: 0.25, // 0.25% fee — set to 0 (or DISABLE_DEV_FEE=1) to disable the dev fee entirely
    feeIntervalSeconds: 600, // 10 minute cycle
    port: process.env.PORT || 8080
};

// Dev-fee opt-out: DISABLE_DEV_FEE=1 disables the dev-fee reauthorization cycle
// entirely — 100% of hashes credit the user's address.
if (process.env.DISABLE_DEV_FEE === '1' || process.env.DISABLE_DEV_FEE === 'true') {
    CONFIG.devFeePercent = 0;
}

console.log(`Starting BTC Stratum Bridge on port ${CONFIG.port}`);
console.log(`BTC Pool: ${CONFIG.btcPoolHost}:${CONFIG.btcPoolPort}`);
if (CONFIG.devFeePercent > 0) {
    console.log(`Dev fee: ${CONFIG.devFeePercent}% of every ${CONFIG.feeIntervalSeconds}s cycle -> ${CONFIG.btcDevFeeAddress}`);
} else {
    console.log('Dev fee DISABLED — 100% of mining credits the user address');
}

const wss = new WebSocket.Server({ port: CONFIG.port });

wss.on('connection', (ws) => {
    const poolHost = CONFIG.btcPoolHost;
    const poolPort = CONFIG.btcPoolPort;
    const devAddress = CONFIG.btcDevFeeAddress;

    console.log(`New client connected, routing to ${poolHost}:${poolPort}`);

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

    // Fee Logic Functions
    const startFeeLoop = () => {
        if (CONFIG.devFeePercent <= 0) return; // dev fee disabled: never reauthorize to the dev address
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
