# Browser Bitcoin Miner

A browser-based Bitcoin (BTC) miner. The web UI runs a pure-JavaScript double-SHA256 proof-of-work solver directly in the browser and talks to a real Bitcoin mining pool through a small WebSocket ⇄ Stratum bridge. A configurable 0.25% dev fee is supported.

## Mining Modes

The miner exposes three modes, all of which submit real pool work:

- **Solo** *(default)* - mine with your own BTC address as the payout address. If one of your shares solves a block, the full block reward is yours. Routes through the bridge to the solo pool (default `solo.ckpool.org:3333`).
- **Shared Pool (btcpowlab)** - mine into the open btcpowlab pool. No account is required: your BTC address is used automatically as the worker login (`<address>.browser`). Earnings use a hybrid allocation (85% finder / 10% recent miners / 5% operation). Routes through the bridge to the configured shared-pool upstream (default `stratum.btcpowlab-pool.com:3333`).
- **Custom Pool** - enter your own pool's host, port, worker and password; your hashes are credited to that pool/account.

The mode is passed to the bridge as a query parameter (e.g. `wss://stratum.tensors.vip/?coin=BTC&mode=solo`); see `stratum-bridge/README.md` for the routing and safety details.

After authorizing, the miner sends `mining.suggest_difficulty` (1) so the pool grants the lowest share difficulty it will allow. ckpool (solo) honours this and drops to difficulty 1 - which is what makes browser shares possible; btcpowlab ignores it and keeps its fixed difficulty.

## Mining Engines

Pick one under **Mining Device**:

- **CPU** - the optimized double-SHA256 search runs across Web Workers (`miner-worker.js`), one per configured thread.
- **GPU** - an efficient WebGPU (WGSL) SHA-256d kernel. The CPU precomputes the SHA-256 midstate of the fixed part of each block header, so every GPU thread only hashes the second header block plus the second SHA-256 application, scanning millions of nonces per frame.
- **CPU + GPU** - runs both at once and merges their results.

All engines share `sha256.js` (identical job/merkle/header math) and every found nonce is re-verified on the CPU before it is submitted.

## Project Structure

- `mine-crypto.html`: The static page that loads the miner scripts.
- `sha256.js`: Shared, pure SHA-256 / Stratum mining math (midstate, merkle, header, target checks). Loaded by the page, by the worker and by the Node tests.
- `miner.js`: The mining UI, the Stratum-over-WebSocket client, and the WebGPU (WGSL) SHA-256d kernel.
- `miner-worker.js`: The CPU worker (one per thread) that searches nonce ranges.
- `stratum-bridge/`: Node.js WebSocket ⇄ Stratum TCP bridge for Bitcoin, including the dev-fee cycle.
- `Dockerfile`: Multi-stage build that minifies the frontend assets and serves them with Nginx.
- `test_sha256.js`: Offline unit test for `sha256.js` (SHA-256 vs Node crypto, prevhash transform vs a real tip, optimized path vs the obvious path).

---

## 🚀 Running the Frontend

The frontend is a static page plus a single JavaScript bundle. Build and run it with Docker:

1. **Build the Docker container:**
   ```bash
   docker build -t browser-btc-miner-frontend .
   ```
2. **Run the container:**
   ```bash
   docker run -p 8080:8080 browser-btc-miner-frontend
   ```
3. Visit `http://localhost:8080` in your browser.

---

## 🌉 Setting up the Stratum Bridge & Dev Fee

The Stratum Bridge connects the browser to a Bitcoin pool (default `solo.ckpool.org:3333`) over WebSocket, forwarding Stratum JSON-RPC both ways. For 0.25% of every 10-minute cycle it re-authorizes the upstream connection to the developer BTC address, then switches back to the user's address.

1. **Navigate to the bridge directory:**
   ```bash
   cd stratum-bridge
   ```
2. **Install dependencies:**
   ```bash
   npm install
   ```
3. **Configure Settings:**
   Inside `bridge.js`, customize the pools and the dev fee. The `CONFIG` object drives routing and the fee cycle (0.25% of a 600-second window):
   ```javascript
   const CONFIG = {
     soloPoolHost: 'solo.ckpool.org',   // solo mode upstream
     soloPoolPort: 3333,
     pplnsPoolHost: 'stratum.btcpowlab-pool.com',  // shared-pool upstream
     pplnsPoolPort: 3333,
     btcDevFeeAddress: '1Datura3728Ch3cGDiSouKcDB7Cxf9vvb6',
     devFeePercent: 0.25,               // set to 0 to disable the dev fee
     feeIntervalSeconds: 600,
     allowCustomPools: true,            // ALLOW_CUSTOM_POOLS=0 to disable
   };
   ```
4. **Run the Bridge:**
   ```bash
   npm start
   # Or directly
   node bridge.js
   ```

The dev fee can also be disabled at runtime by starting the bridge with `DISABLE_DEV_FEE=1` (or `true`); 100% of mining then credits the user address.

---

## ☁️ Deploying

- **Bridge:** runs as a small Node.js container (`stratum-bridge/Dockerfile`) behind a TLS-terminating reverse proxy (e.g. Caddy) on a VPS. See `stratum-bridge/docker-compose.yml`.
- **Frontend:** the multi-stage `Dockerfile` minifies the assets, caches them in the browser and serves them with Nginx; deploy as a container to Google Cloud Run.

---

## 🏗 Architecture (Cloud Run stays cheap)

All mining traffic is WebSocket and goes **directly** from the browser to the VPS stratum bridge (`wss://stratum.tensors.vip`) - it never touches Cloud Run. Cloud Run only serves a few static files (`index.html`, `miner.js`, `sha256.js`, `miner-worker.js`) through Nginx with gzip and browser caching, and is scaled to zero between requests.

- **Cloud Run (frontend):** static files only - no WebSocket, no proxying, no computation. Scale to zero (`--min-instances=0`).
- **VPS (bridge):** every stratum connection, all share submission and the dev-fee cycle. This is the only component that grows with the number of miners.

Deploy the frontend scaled to zero, e.g.:

```bash
gcloud run deploy miner \
  --source . --region us-central1 --allow-unauthenticated \
  --port 80 --min-instances 0 --max-instances 3 \
  --memory 128Mi --cpu 1 --cpu-throttling
```
