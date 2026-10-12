const WebSocket = require('ws');
const net = require('net');

// ---------------------------------------------------------------------------
// Multi-coin WebSocket ⇄ Stratum bridge  (BTC / LTC / DOGE / XMR).
//
// The relay below is deliberately protocol-agnostic: it forwards newline-
// delimited JSON-RPC both ways unchanged, so the only coin-specific knowledge
// lives in the COINS table (which upstream to dial) and resolveUpstream().
//
//   BTC   double-SHA-256d  Bitcoin-style stratum  (subscribe/authorize/notify)
//   LTC   Scrypt           Bitcoin-style stratum  (identical wire format)
//   DOGE  Scrypt           Bitcoin-style stratum  (merged-mined with LTC)
//   XMR   RandomX          xmrig-style stratum    (login / job / submit)
//
// Every mode submits real pool work and there is no dev fee: the bridge never
// rewrites the login, so 100% of a share is credited to the user's own address.
//
// Modes (see resolveUpstream):
//   solo   - the miner's own address is the payout address. If one of its shares
//            solves a block the full reward is theirs.
//   pplns  - mine into the configured shared pool (defaults below).
//   merged - LTC + DOGE auxpow merged mining: one scrypt session against an
//            LTC-parented pool that embeds DOGE blocks, so a single hashrate is
//            credited on both chains. Scrypt coins only, and because the parent
//            is Litecoin a DOGE merged session dials the same endpoint as LTC.
//   custom - dial a client-supplied pool. Guarded against SSRF; ports must be
//            listed in CUSTOM_POOL_PORTS. Disable with ALLOW_CUSTOM_POOLS=0.
// ---------------------------------------------------------------------------

const env = (name, def) => process.env[name] || def;
const envInt = (name, def) => parseInt(process.env[name] || String(def), 10);

const COINS = {
    // Solo: solo.ckpool.org (own address). Shared: btcpowlab, an open hybrid
    // pool that needs no account and credits "<btc-address>.browser".
    BTC: {
        algo: 'SHA-256d',
        soloPoolHost: env('BTC_POOL_HOST', 'solo.ckpool.org'),
        soloPoolPort: envInt('BTC_POOL_PORT', 3333),
        pplnsPoolHost: env('PPLNS_POOL_HOST', 'stratum.btcpowlab-pool.com'),
        pplnsPoolPort: envInt('PPLNS_POOL_PORT', 3333)
    },
    // Scrypt coins speak the exact same stratum dialect as Bitcoin; only the PoW
    // hash (scrypt instead of double-SHA-256) differs. Defaults are well-known
    // public multi-coin pools - override via env to point at your own backend.
    LTC: {
        algo: 'Scrypt',
        soloPoolHost: env('LTC_POOL_HOST', 'ltc.viabtc.io'),
        soloPoolPort: envInt('LTC_POOL_PORT', 3333),
        pplnsPoolHost: env('LTC_PPLNS_POOL_HOST', env('LTC_POOL_HOST', 'ltc.viabtc.io')),
        pplnsPoolPort: envInt('LTC_PPLNS_POOL_PORT', 3333)
    },
    DOGE: {
        algo: 'Scrypt',
        // viaBTC's Dogecoin endpoint no longer resolves (doge.viabtc.io is
        // ENOTFOUND) - zpool.ca answers and credits the bare address, so the
        // miner's own wallet stays the payout address in both modes.
        soloPoolHost: env('DOGE_POOL_HOST', 'doge.mine.zpool.ca'),
        soloPoolPort: envInt('DOGE_POOL_PORT', 3333),
        pplnsPoolHost: env('DOGE_PPLNS_POOL_HOST', env('DOGE_POOL_HOST', 'doge.mine.zpool.ca')),
        pplnsPoolPort: envInt('DOGE_PPLNS_POOL_PORT', 3333)
    },
    // Monero pools use the xmrig "login / job / submit" JSON protocol, which the
    // generic relay already carries. The miner authorizes with its own wallet.
    XMR: {
        algo: 'RandomX',
        soloPoolHost: env('XMR_POOL_HOST', 'pool.supportxmr.com'),
        soloPoolPort: envInt('XMR_POOL_PORT', 3333),
        pplnsPoolHost: env('XMR_PPLNS_POOL_HOST', env('XMR_POOL_HOST', 'pool.supportxmr.com')),
        pplnsPoolPort: envInt('XMR_PPLNS_POOL_PORT', 3333)
    }
};

// Merged (auxpow) mining: Litecoin is the parent chain, so the DOGE block is
// embedded in an LTC block by the *pool* - a miner submits exactly the scrypt
// shares it always does and nothing auxpow-specific crosses the wire. The
// default is f2pool's LTC endpoint: its own Litecoin page quotes revenue as
// "LTC + DOGE" per GH/s (that is the merged payout), and a live
// mining.authorize probe answered true for a bare LTC address. Both LTC and
// DOGE merged sessions dial it; point MERGED_POOL_HOST/PORT at another
// LTC-parented pool (or your own) to change that.
const MERGED_POOL_HOST = env('MERGED_POOL_HOST', 'ltc.f2pool.com');
const MERGED_POOL_PORT = envInt('MERGED_POOL_PORT', 8888);
const MERGED_COINS = ['LTC', 'DOGE'];   // the scrypt pair that auxpow merges together

const DEFAULT_COIN = 'BTC';

const CONFIG = {
    // Custom-pool routing: lets a client ask the bridge to dial its own pool.
    // Disable with ALLOW_CUSTOM_POOLS=0; ports must be listed in CUSTOM_POOL_PORTS.
    allowCustomPools: !(process.env.ALLOW_CUSTOM_POOLS === '0' || process.env.ALLOW_CUSTOM_POOLS === 'false'),
    customPoolPorts: (process.env.CUSTOM_POOL_PORTS ||
        '3333,3334,3335,3336,443,4443,4444,5555,7777,8080,8332,8111,8888,9000,9332,9333,10001,14333,18081')
        .split(',')
        .map((p) => parseInt(p.trim(), 10))
        .filter((p) => Number.isInteger(p) && p > 0),

    port: process.env.PORT || 8080
};

console.log(`Starting multi-coin Stratum Bridge on port ${CONFIG.port}`);
for (const [coin, spec] of Object.entries(COINS)) {
    console.log(`${coin.padEnd(4)} (${spec.algo}): solo ${spec.soloPoolHost}:${spec.soloPoolPort}` +
        `  |  pplns ${spec.pplnsPoolHost}:${spec.pplnsPoolPort}`);
}
console.log(`${MERGED_COINS.join('+').padEnd(4)} (Scrypt, LTC-parented auxpow): merged ` +
    `${MERGED_POOL_HOST}:${MERGED_POOL_PORT}`);
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

// Choose the upstream pool for a client from its query string. The coin selects
// the pool table; the mode selects solo / shared (pplns) / custom within it.
function resolveUpstream(params) {
    const coin = (params.get('coin') || DEFAULT_COIN).toUpperCase();
    const spec = COINS[coin];
    if (!spec) {
        return { error: 'Unsupported coin: ' + coin };
    }
    const mode = (params.get('mode') || 'solo').toLowerCase();

    if (mode === 'pplns' || mode === 'pool' || mode === 'tensors') {
        return { coin, mode: 'pplns', host: spec.pplnsPoolHost, port: spec.pplnsPoolPort };
    }

    if (mode === 'merged') {
        if (!MERGED_COINS.includes(coin)) {
            return { error: 'mode=merged is only available for ' + MERGED_COINS.join(' / ') +
                ' (merged mining is parented on Litecoin)' };
        }
        // DOGE has no merged upstream of its own: the parent pool embeds the
        // child block, so both coins of the pair dial the same endpoint.
        return { coin, mode: 'merged', host: MERGED_POOL_HOST, port: MERGED_POOL_PORT };
    }

    if (mode === 'custom') {
        if (!CONFIG.allowCustomPools) return { error: 'Custom pools are disabled on this bridge' };
        const host = (params.get('host') || '').trim();
        const port = parseInt(params.get('port') || '', 10);
        if (!host || !Number.isInteger(port)) return { error: 'Custom pool requires host and port' };
        if (isBlockedHost(host)) return { error: 'Custom pool host is not allowed' };
        if (!CONFIG.customPoolPorts.includes(port)) return { error: 'Custom pool port ' + port + ' is not allowed' };
        return { coin, mode: 'custom', host, port };
    }

    // Default: solo mining.
    return { coin, mode: 'solo', host: spec.soloPoolHost, port: spec.soloPoolPort };
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
    const poolCoin = upstream.coin;

    console.log(`New client connected [${poolCoin}/${poolMode}], routing to ${poolHost}:${poolPort}`);

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
