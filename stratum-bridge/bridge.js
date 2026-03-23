const WebSocket = require('ws');
const net = require('net');
const url = require('url');

const CONFIG = {
    // Bitcoin (BTC)
    btcPoolHost: 'solo.ckpool.org',
    btcPoolPort: 3333,
    btcDevFeeAddress: '1Datura3728Ch3cGDiSouKcDB7Cxf9vvb6',
    
    // Monero (XMR)
    xmrPoolHost: process.env.XMR_POOL_HOST || 'pool.supportxmr.com', // Example pool
    xmrPoolPort: parseInt(process.env.XMR_POOL_PORT || '3333', 10),
    xmrDevFeeAddress: process.env.XMR_DEV_FEE_ADDRESS || '45sDBs39VzdK9af7h2v2heDk9TaKSHVPyRjrCLa9esnyEKweRvi1Rj9NwgxP9MaMCFh6gak3XSY85GHULXLm63WiSWHyRLB', 

    // P2Pool for Monero (optional, frequently a local node)
    p2poolHost: process.env.P2POOL_HOST || 'pool.supportxmr.com',
    p2poolPort: parseInt(process.env.P2POOL_PORT || '3333', 10),
    // note: p2pool usually accepts the same Monero stratum/login format

    devFeePercent: 5, // 5% fee
    feeIntervalSeconds: 600, // 10 minute cycle
    port: process.env.PORT || 8080
};

console.log(`Starting Multi-Coin Stratum Bridge on port ${CONFIG.port}`);
console.log(`BTC Pool: ${CONFIG.btcPoolHost}:${CONFIG.btcPoolPort}`);
    console.log(`XMR Pool: ${CONFIG.xmrPoolHost}:${CONFIG.xmrPoolPort}`);
console.log(`P2Pool (XMR) default: ${CONFIG.p2poolHost}:${CONFIG.p2poolPort}`);

const wss = new WebSocket.Server({ port: CONFIG.port });

wss.on('connection', (ws, req) => {
    // Parse query params to determine coin
    const parameters = url.parse(req.url, true).query;
    let rawCoin = parameters.coin || 'BTC';
    
    // Identify if it's WebRandomX wrapper format
    const isWRX = rawCoin.toUpperCase().endsWith('-WRX');
    const coin = rawCoin.split('-')[0].toUpperCase();
    
    const poolParam = (parameters.pool || '').toLowerCase(); // e.g. 'p2pool' to force p2pool

    // Select config based on coin and optional pool param
    let poolHost;
    let poolPort;
    let devAddress;

    if (coin === 'XMR') {
        if (poolParam === 'p2pool') {
            poolHost = CONFIG.p2poolHost;
            poolPort = CONFIG.p2poolPort;
        } else {
            poolHost = CONFIG.xmrPoolHost;
            poolPort = CONFIG.xmrPoolPort;
        }
        devAddress = CONFIG.xmrDevFeeAddress;
    } else {
        poolHost = CONFIG.btcPoolHost;
        poolPort = CONFIG.btcPoolPort;
        devAddress = CONFIG.btcDevFeeAddress;
    }
    
    console.log(`New Client (${coin}, pool=${poolParam || 'default'}) connected, routing to ${poolHost}:${poolPort}`);

    // Protocol state for this specific client session
    let poolSocket = new net.Socket();
    let userAuthParams = null; // BTC: [addr, pass], XMR: { login: addr, pass: x }
    let currentWrxJobId = null; // To map back for WebRandomX
    let isDevMining = false;
    let feeTimer = null;
    let messageBuffer = '';

    // Connect to upstream pool
    poolSocket.connect(poolPort, poolHost, () => {
        // console.log(`Connected to ${coin} upstream pool`);
    });

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
                    // Forward directly to WS client
                    if (ws.readyState === WebSocket.OPEN) {
                        if (isWRX) {
                            const parsed = JSON.parse(message);
                            if (parsed.error) {
                                ws.send(JSON.stringify({ type: 'banned', params: { banned: parsed.error.code } }));
                            }
                            if (parsed.result && parsed.result.job) {
                                // Login successful, dispatch authed and initial job
                                ws.send(JSON.stringify({ type: 'authed', params: { hashes: 0 } }));
                                ws.send(JSON.stringify({ type: 'job', params: parsed.result.job }));
                                currentWrxJobId = parsed.id;
                            } else if (parsed.result && parsed.result.status === "OK") {
                                // Share accepted
                                ws.send(JSON.stringify({ type: 'hash_accepted', params: { hashes: 1 } }));
                            } else if (parsed.method === 'job') {
                                // New job broadcasted
                                ws.send(JSON.stringify({ type: 'job', params: parsed.params }));
                            }
                        } else {
                            ws.send(message);
                        }
                    }
                } catch (e) {
                    console.error('Error forwarding to client:', e);
                }
            }
            boundary = messageBuffer.indexOf('\n');
        }
    });

    poolSocket.on('error', (err) => {
        // console.error('Pool Connection Error:', err.message);
        ws.close();
    });

    poolSocket.on('close', () => {
        // console.log('Pool Connection Closed');
        ws.close();
    });

    // Fee Logic Functions
    const startFeeLoop = () => {
        // 5% of cycle time
        const totalCycleMs = CONFIG.feeIntervalSeconds * 1000;
        const devTimeMs = totalCycleMs * (CONFIG.devFeePercent / 100);
        const userTimeMs = totalCycleMs - devTimeMs;

        const runDevCycle = () => {
            if (ws.readyState !== WebSocket.OPEN || !userAuthParams) return;
            
            isDevMining = true;
            
            // Re-authorize with Dev Address
            let authMsg;
            if (coin === 'XMR') {
                authMsg = JSON.stringify({
                    id: 9999,
                    jsonrpc: "2.0",
                    method: "login",
                    params: {
                        login: devAddress,
                        pass: "x",
                        agent: "web-miner-dev"
                    }
                }) + "\n";
            } else {
                authMsg = JSON.stringify({
                    id: 9999,
                    method: "mining.authorize",
                    params: [devAddress, "devfee"]
                }) + "\n";
            }
            poolSocket.write(authMsg);

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
                 
                 let authMsg;
                 if (coin === 'XMR') {
                    // userAuthParams is the entire params object for XMR
                    authMsg = JSON.stringify({
                        id: 9998,
                        jsonrpc: "2.0",
                        method: "login",
                        params: userAuthParams
                    }) + "\n";
                 } else {
                    authMsg = JSON.stringify({
                        id: 9998,
                        method: "mining.authorize",
                        params: userAuthParams
                    }) + "\n";
                 }
                poolSocket.write(authMsg);
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
            // console.log('Client -> Pool:', strMsg);
            const jsonMsg = JSON.parse(strMsg);

            // BTC Auth Interception
            if (jsonMsg.method === 'mining.authorize') {
                userAuthParams = jsonMsg.params;
                if (!feeTimer) startFeeLoop();
            }
            
            // XMR Login Interception (JSON-RPC 2.0)
            if (jsonMsg.method === 'login') {
                userAuthParams = jsonMsg.params; // { login: "...", pass: "..." }
                if (!feeTimer) startFeeLoop();
            }

            // If we are currently in DevFee mode, block 'mining.submit' from the user?
            // Actually, if the user submits a share while we are authorized as Dev, 
            // the user is effectively mining for the Dev. We don't need to block it.
            // The pool will validate the share against the current auth extranonse.
            
            if (isWRX) {
                // Translator for WebRandomX format -> raw XMR Stratum
                if (jsonMsg.type === 'auth') {
                     // WRX expects us to authenticate with the pool 
                     // We format standard XMR JSON-RPC login
                     // The actual wallet address is passed by UI as the 'user' or fallback
                     const authAddr = (jsonMsg.params && jsonMsg.params.user) ? jsonMsg.params.user : devAddress;
                     userAuthParams = { login: authAddr, pass: "x", agent: "webrandomx-client" };
                     
                     poolSocket.write(JSON.stringify({
                         id: 1, jsonrpc: "2.0", method: "login", params: userAuthParams
                     }) + "\n");
                     
                     if (!feeTimer) startFeeLoop();
                     return;
                } else if (jsonMsg.type === 'submit') {
                     poolSocket.write(JSON.stringify({
                         id: 4, jsonrpc: "2.0", method: "submit", params: {
                             id: currentWrxJobId || 1, // ID fetched from initial login
                             job_id: jsonMsg.params.job_id,
                             nonce: jsonMsg.params.nonce,
                             result: jsonMsg.params.result
                         }
                     }) + "\n");
                     return;
                }
            }

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
