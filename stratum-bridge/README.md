# Stratum Bridge (BTC-only)

A small WebSocket -> Stratum TCP bridge for Bitcoin. Browsers connect over WebSocket; the bridge opens a TCP connection to an upstream Bitcoin pool and relays Stratum JSON-RPC messages both ways. It also implements a 0.25% dev-fee cycle (configurable in `bridge.js`).

Mining modes

The client selects a mode with the `?mode=` query parameter. The web UI defaults to `solo`.

- `mode=solo` - routes to the solo pool (`BTC_POOL_HOST`). The miner authorizes with its own BTC address; if one of its shares solves a block, the full block reward is theirs. A bare `?coin=BTC` also routes here.
- `mode=pplns` - routes to the shared pool (`PPLNS_POOL_HOST` / `PPLNS_POOL_PORT`, default `stratum.btcpowlab-pool.com:3333`). btcpowlab is an open pool: no account is required and the miner is credited as `<btc-address>.browser` (the bridge relays the login unchanged). Earnings use a hybrid allocation (85% finder / 10% recent miners / 5% operation). Override the env vars only to point at your own pool backend.
- `mode=custom` - the client supplies `&host=` and `&port=` and the bridge dials that pool ("mine for my own pool"). Disable with `ALLOW_CUSTOM_POOLS=0`. Only ports listed in `CUSTOM_POOL_PORTS` are allowed and private/loopback hosts are rejected, so the bridge cannot be abused as an SSRF proxy.

How it works

- Client connects to the bridge via WebSocket (with its mode and, for custom pools, host/port).
- The bridge opens a TCP connection to the selected upstream Bitcoin pool and forwards messages both ways.
- After each `mining.authorize`, the bridge schedules a dev-fee cycle (solo and PPLNS modes only): for 0.25% of every 600s window it re-authorizes the connection to the developer BTC address, then switches back to the user's address. Custom-pool connections are never re-authorized to the dev address.

Share difficulty

- The frontend defaults to `solo`. After authorizing, its miner sends `mining.suggest_difficulty` (1) so slow clients get a usable share target: ckpool (solo) honours it and drops to difficulty 1; btcpowlab ignores it and keeps its fixed difficulty. The bridge just relays the method upstream.

Configuration (`bridge.js` / environment overrides)

- `PORT` - WebSocket port to listen on (default 8080)
- `BTC_POOL_HOST` - solo pool host (default `solo.ckpool.org`)
- `BTC_POOL_PORT` - solo pool port (default `3333`)
- `PPLNS_POOL_HOST` - shared-pool host (default `stratum.btcpowlab-pool.com`)
- `PPLNS_POOL_PORT` - PPLNS pool port (default `3333`)
- `BTC_DEV_FEE_ADDRESS` - developer BTC address
- `DISABLE_DEV_FEE=1` (or `true`) - disable the dev fee entirely (100% of mining credits the user)
- `ALLOW_CUSTOM_POOLS=0` - disable client-supplied custom pools (enabled by default)
- `CUSTOM_POOL_PORTS` - comma-separated allow-list of ports for custom pools

The shared-pool (PPLNS) backend

There is no "lightweight" way to self-host real PPLNS: PPLNS needs a pool server that builds block templates, tracks each miner's shares over a rolling window and pays out proportionally from the blocks it finds - i.e. a full node + pool software + a hot wallet + a payout pipeline. The pragmatic option is to ride an existing open pool. The default upstream (`stratum.btcpowlab-pool.com`) is exactly that: an open hybrid-solo pool that needs no account. Only set `PPLNS_POOL_HOST` / `PPLNS_POOL_PORT` if you actually operate your own pool.

Examples (WebSocket URLs expected by the frontend)

- Solo: `...?coin=BTC&mode=solo` (bare `?coin=BTC` also routes to solo)
- Shared pool (btcpowlab): `...?coin=BTC&mode=pplns`
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

Tests

- `node test_modes.js` - verifies mode routing (solo/pplns reach the configured upstream; custom rejects blocked hosts and disallowed ports). Local mock only.
- `node test_share_e2e.js` - runs the bridge against a mock pool that hands out a **real** captured Bitcoin job at a low difficulty and then **independently verifies** the submitted share (Node crypto + real block-header byte order). Proves the whole job -> hash -> submit pipeline, including the stratum prevhash transform and the `<address>.browser` login.
- `node test_local.js` - starts a stub Bitcoin stratum server and verifies the bridge relays messages end-to-end. The stub is a local mock only; it performs no real network mining.
- `node test_local_btc.js` - a quick subscribe check against a bridge running on `localhost:8080`.
- `node test_live_mining.js` - **performs real network work**: connects to `wss://stratum.tensors.vip` in solo and pplns modes, negotiates difficulty and mines the real jobs for ~20s each.

Notes

- The bridge forwards JSON-RPC lines and appends newlines; it expects miners that follow the usual Bitcoin stratum formatting.
