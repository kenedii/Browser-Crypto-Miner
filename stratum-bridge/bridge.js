const WebSocket = require('ws');
const net = require('net');

const CONFIG = {
    // Bitcoin (BTC) upstream pools
    // Solo: the miner authorizes with their own address and keeps the full
    // block reward if one of their shares solves a block.
    soloPoolHost: process.env.BTC_POOL_HOST || 'solo.ckpool.org',
    soloPoolPort: parseInt(process.env.BTC_POOL_PORT || '3333', 10),

    // Shared pool (PPLNS / hybrid solo) - the default upstream for the
    // "shared pool" mode. btcpowlab is an open pool: no account is required
    // and the miner is credited as "<btc-address>.browser". Override with
    // PPLNS_POOL_HOST / PPLNS_POOL_PORT to point at your own pool backend.
    pplnsPoolHost: process.env.PPLNS_POOL_HOST || 'stratum.btcpowlab-pool.com',
    pplnsPoolPort: parseInt(process.env.PPLNS_POOL_PORT || '3333', 10),

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

console.log(`Starting BTC Stratum Bridge on port ${CONFIG.port}`);
console.log(`Solo pool:    ${CONFIG.soloPoolHost}:${CONFIG.soloPoolPort}`);
console.log(`PPLNS pool:   ${CONFIG.pplnsPoolHost}:${CONFIG.pplnsPoolPort}`);
console.log(`Custom pools: ${CONFIG.allowCustomPools ? 'ENABLED (ports ' + CONFIG.customPoolPorts.join(', ') + ')' : 'DISABLED'}`);
console.log('No dev fee: 100% of mining credits the user\'s own login.');

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
        return { mode: 'pplns', host: CONFIG.pplnsPoolHost, port: CONFIG.pplnsPoolPort };
    }

    if (mode === 'custom') {
        if (!CONFIG.allowCustomPools) return { error: 'Custom pools are disabled on this bridge' };
        const host = (params.get('host') || '').trim();
        const port = parseInt(params.get('port') || '', 10);
        if (!host || !Number.isInteger(port)) return { error: 'Custom pool requires host and port' };
        if (isBlockedHost(host)) return { error: 'Custom pool host is not allowed' };
        if (!CONFIG.customPoolPorts.includes(port)) return { error: 'Custom pool port ' + port + ' is not allowed' };
        return { mode: 'custom', host, port };
    }

    // Default: solo mining.
    return { mode: 'solo', host: CONFIG.soloPoolHost, port: CONFIG.soloPoolPort };
}

const wss = new WebSocket.Server({ port: CONFIG.port });

// Heartbeat: ping every client periodically. This reaps dead sockets and, more
// importantly, keeps traffic flowing through quiet periods (between jobs) so an
// intermediary proxy cannot silently idle-close a healthy pool session. Browsers
// answer WS pings automatically with a pong, which also refreshes the
// client -> server idle timer on such proxies.
const heartbeat = setInterval(() => {
    wss.clients.forEach((c) => {
        if (c.isAlive === false) { try { c.terminate(); } catch (e) {} return; }
        c.isAlive = false;
        try { c.ping(); } catch (e) {}
    });
}, 15000);
wss.on('close', () => clearInterval(heartbeat));

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

    console.log(`New client connected [${poolMode}], routing to ${poolHost}:${poolPort}`);

    // Protocol state for this specific client session
    let poolSocket = new net.Socket();
    let messageBuffer = '';

    // Client socket hygiene: an unhandled 'error' would otherwise crash the
    // whole bridge (dropping every client), and isAlive feeds the heartbeat.
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', (e) => { console.error('Client WS error:', e && e.message); });

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

    // Handle Client -> Pool
    ws.on('message', (message) => {
        try {
            const strMsg = message.toString().trim();
            if (!strMsg) return;
            const jsonMsg = JSON.parse(strMsg);

            // Client keepalive: answered locally and never forwarded to the pool,
            // so a quiet session still generates client -> server traffic.
            if (jsonMsg.method === 'mining.ping') {
                try { ws.send(JSON.stringify({ id: jsonMsg.id, result: 'pong', error: null })); } catch (e) {}
                return;
            }

            poolSocket.write(strMsg + "\n");

        } catch (e) {
            console.error('Error handling client message:', e);
        }
    });

    ws.on('close', () => {
        poolSocket.destroy();
    });
});
