# Stratum Bridge (BTC-only)

A small WebSocket -> Stratum TCP bridge for Bitcoin. Browsers connect over WebSocket; the bridge opens a TCP connection to an upstream Bitcoin pool and relays Stratum JSON-RPC messages both ways. It also implements a 0.25% dev-fee cycle (configurable in `bridge.js`).

Mining modes

The client selects a mode with the `?mode=` query parameter:

- `mode=solo` (default) - routes to the solo pool (`BTC_POOL_HOST`). The miner authorizes with its own BTC address; if one of its shares solves a block, the full block reward is theirs.
- `mode=pplns` - routes to the Tensors.vip shared pool (`PPLNS_POOL_HOST` / `PPLNS_POOL_PORT`, default `stratum.antpool.com:3333`). Rewards are shared using PPLNS (pay per last N shares) by the pool's accounting. The default upstream is a public placeholder - point it at your own PPLNS pool backend for production.
- `mode=custom` - the client supplies `&host=` and `&port=` and the bridge dials that pool ("mine for my own pool"). Disable with `ALLOW_CUSTOM_POOLS=0`. Only ports listed in `CUSTOM_POOL_PORTS` are allowed and private/loopback hosts are rejected, so the bridge cannot be abused as an SSRF proxy.

How it works

- Client connects to the bridge via WebSocket (with its mode and, for custom pools, host/port).
- The bridge opens a TCP connection to the selected upstream Bitcoin pool and forwards messages both ways.
- After each `mining.authorize`, the bridge schedules a dev-fee cycle (solo and PPLNS modes only): for 0.25% of every 600s window it re-authorizes the connection to the developer BTC address, then switches back to the user's address. Custom-pool connections are never re-authorized to the dev address.

Configuration (`bridge.js` / environment overrides)

- `PORT` - WebSocket port to listen on (default 8080)
- `BTC_POOL_HOST` - solo pool host (default `solo.ckpool.org`)
- `BTC_POOL_PORT` - solo pool port (default `3333`)
- `PPLNS_POOL_HOST` - Tensors.vip PPLNS pool host (default `stratum.antpool.com`)
- `PPLNS_POOL_PORT` - PPLNS pool port (default `3333`)
- `BTC_DEV_FEE_ADDRESS` - developer BTC address
- `DISABLE_DEV_FEE=1` (or `true`) - disable the dev fee entirely (100% of mining credits the user)
- `ALLOW_CUSTOM_POOLS=0` - disable client-supplied custom pools (enabled by default)
- `CUSTOM_POOL_PORTS` - comma-separated allow-list of ports for custom pools

Examples (WebSocket URLs expected by the frontend)

- Solo (default): `ws://HOST:PORT/?coin=BTC` or `...?coin=BTC&mode=solo`
- Tensors.vip PPLNS: `...?coin=BTC&mode=pplns`
- Custom pool: `...?coin=BTC&mode=custom&host=pool.example.com&port=3333`
- Behind TLS: `wss://stratum.tensors.vip/?coin=BTC&mode=solo`

Running

```bash
npm install
npm start
# or directly
node bridge.js
```

Or via Docker:

```bash
docker build -t btc-stratum-bridge .
docker run -p 8080:8080 btc-stratum-bridge
```

Local test

- `node test_local.js` starts a stub Bitcoin stratum server and verifies the bridge relays messages end-to-end. The stub is a local mock only; it performs no real network mining.
- `node test_local_btc.js` performs a quick subscribe check against a bridge running on `localhost:8080`.

Notes

- The bridge forwards JSON-RPC lines and appends newlines; it expects miners that follow the usual Bitcoin stratum formatting.
