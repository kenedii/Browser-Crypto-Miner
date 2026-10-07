# Stratum Bridge (BTC-only)

A small WebSocket -> Stratum TCP bridge for Bitcoin. Browsers connect over WebSocket; the bridge opens a TCP connection to an upstream Bitcoin pool and relays Stratum JSON-RPC messages both ways. It also implements a 0.25% dev-fee cycle (configurable in `bridge.js`).

How it works

- Client connects to the bridge via WebSocket.
- The bridge opens a TCP connection to the upstream Bitcoin pool and forwards messages both ways.
- After each `mining.authorize`, the bridge schedules a dev-fee cycle: for 0.25% of every 600s window it re-authorizes the connection to the developer BTC address, then switches back to the user's address.

Configuration (`bridge.js` / environment overrides)

- `PORT` - WebSocket port to listen on (default 8080)
- `BTC_POOL_HOST` - upstream Bitcoin pool host (default `solo.ckpool.org`)
- `BTC_POOL_PORT` - upstream Bitcoin pool port (default `3333`)
- `BTC_DEV_FEE_ADDRESS` - developer BTC address
- `DISABLE_DEV_FEE=1` (or `true`) - disable the dev fee entirely (100% of mining credits the user)

Examples (WebSocket URLs expected by the frontend)

- Default: `ws://HOST:PORT/?coin=BTC` (routes to the pool configured in `bridge.js`)
- Behind TLS: `wss://miner.example.com/?coin=BTC`

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
