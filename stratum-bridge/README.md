# Stratum Bridge

This small WebSocket -> Stratum TCP bridge supports BTC and XMR and includes a P2Pool option for Monero.

How it works

- Client connects to the bridge via WebSocket.
- The bridge opens a TCP connection to the upstream pool (BTC, XMR, or P2Pool for XMR) and forwards messages both ways.
- The bridge implements a simple dev-fee cycle (configured in `bridge.js`).

Selecting coin and pool

- `coin` query param controls coin type: `BTC` or `XMR` (case-insensitive).
- For Monero you can optionally request a P2Pool upstream by passing `pool=p2pool`.

Examples (WebSocket URLs expected by simple WebMiner clients):

- Mine BTC locally (no upstream connection needed):
  - If you run a local BTC stratum server, point the bridge at your local server via env vars (see config) and connect: `ws://HOST:PORT/?coin=BTC`

- Solo mine BTC (network connection):
  - Example: `ws://HOST:PORT/?coin=BTC` (bridge will route to default BTC pool configured in `bridge.js`)

- Mine XMR locally (no upstream connection):
  - If you run a local XMR stratum (e.g. `monero-wallet-rpc` + miner) set `XMR_POOL_HOST`/`XMR_POOL_PORT` env vars when starting the bridge and connect: `ws://HOST:PORT/?coin=XMR`

- Solo mine XMR (network connection):
  - `ws://HOST:PORT/?coin=XMR` (uses configured public XMR pool by default)

- Solo mine XMR with P2Pool (network connection to a P2Pool node):
  - If you have a P2Pool node (local or remote) that speaks the Monero stratum protocol, run the bridge with `P2POOL_HOST`/`P2POOL_PORT` configured or simply connect the client this way: `ws://HOST:PORT/?coin=XMR&pool=p2pool`.
  - The bridge will route XMR connections to the P2Pool host.

Environment overrides (useful for testing / local p2pool):

- `PORT` - port to listen on (default 8080)
- `XMR_POOL_HOST`, `XMR_POOL_PORT` - upstream XMR pool
- `P2POOL_HOST`, `P2POOL_PORT` - upstream P2Pool host/port
- `P2POOL_MONEROD_HOST`, `P2POOL_MONEROD_RPC_PORT`, `P2POOL_MONEROD_ZMQ_PORT` - remote monerod node to connect P2Pool to
- `P2POOL_WALLET` - wallet address for P2Pool blocks found

Local test

- A quick local integration test is provided: `node test_local.js` starts a stub "fake" P2Pool simply to test the node bridge's routing. Note: this stub is purely a local mock for verifying the Node.js WebSocket code; it doesn't perform actual cryptocurrency operations or connect to the real network.

Real P2Pool Node within Docker

When deploying via the provided `Dockerfile`, the container uses a real `p2pool` binary. It runs a full p2pool node connecting out to a remote `monerod` (e.g. `node.moneromine.co` with ZMQ exposed) and handles your Monero mining on the real, decentralized P2Pool sidechain.

Notes

- This bridge forwards JSON-RPC lines and just appends newlines; it expects miners that follow the usual stratum / JSON-RPC formatting for BTC/XMR.
- P2Pool for Monero generally accepts the same `login` JSON-RPC format as pool.supportxmr; adjust if you use a specialized P2Pool variant.

If you'd like, I can also add a small example web-miner client showing how to connect with these query params.
