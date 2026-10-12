# Browser Crypto Miner (BTC / LTC / DOGE / XMR)

A browser-based multi-coin miner. The web UI runs pure-JavaScript proof-of-work solvers directly in the browser and talks to real mining pools through a small WebSocket ⇄ Stratum bridge. There is no dev fee: 100% of the work is credited to the user's own address or pool login.

## Supported Coins

The **Coin** selector picks the proof of work and the Stratum dialect, and the bridge then routes to that coin's upstream pool (all of it driven by the `?coin=` query parameter - see `stratum-bridge/README.md`).

| Coin | Algo | Browser engine | Stratum dialect | Default solo upstream |
| --- | --- | --- | --- | --- |
| Bitcoin (`BTC`) | double-SHA-256d | `miner-worker.js` (CPU Web Workers) and/or the WebGPU WGSL kernel | `subscribe` / `authorize` / `notify` | `solo.ckpool.org:3333` |
| Litecoin (`LTC`) | Scrypt | `scrypt-worker.js` (CPU only) | identical to Bitcoin | `ltc.viabtc.io:3333` |
| Dogecoin (`DOGE`) | Scrypt | `scrypt-worker.js` (CPU only) | identical to Bitcoin | `doge.mine.zpool.ca:3333` |
| Monero (`XMR`) | RandomX | `xmr-worker.js` + `randomx.wasm` (CPU only) | xmrig `login` / `job` / `submit` | `pool.supportxmr.com:3333` |

Each coin validates its own wallet-address format before it connects, so a Bitcoin address can never credit a Litecoin, Dogecoin or Monero share.

### Honest hashrate expectations

Read this before expecting anything to happen:

- **BTC (SHA-256d):** a decent desktop GPU gives a few MHash/s. At the current network difficulty a block needs on the order of 10^23 hashes, so the odds of finding one from a browser tab are around one in 10^17 per second. This is a lottery ticket, not income.
- **LTC / DOGE (Scrypt):** Scrypt is deliberately memory-hard. Expect hundreds to a few thousand hashes per second per thread - the same ballpark as one CPU core, which is roughly a million times slower than a Litecoin ASIC.
- **XMR (RandomX):** RandomX in WebAssembly light mode (256 MiB cache) does **single-digit to a few dozen H/s**, whereas native xmrig on the same machine does thousands. Public Monero pools also start at a share difficulty far above a browser's reach. It does compute *consensus-correct* hashes, though: the floating point rounding modes RandomX's `CFROUND` instruction requires are implemented in software for wasm, and the build is checked against RandomX's own known-answer vectors and its full test suite (see `WebRandomX/README.md`), so a share it finds is one the pool will accept. That is a correctness statement, not an income statement.
- **Scrypt difficulty scale:** scrypt pools define difficulty 1 as target `0x0000ffff<<224`, 65536x easier than SHA-256d's difficulty 1. `scrypt.js` therefore builds the share target from the scrypt constant (`scryptTargetWords`) and `miner.js` converts worker-reported difficulty (Bitcoin scale) by x65536 before comparing it with the pool's advertised difficulty. Guarded by `test_scrypt.js`.
- In every case the miner searches the pool's real jobs and submits a share **only when the hash actually clears the pool's accept bar**. If it cannot reach it, it submits nothing - it never fabricates a share.

## Mining Modes

The miner exposes three modes, all of which submit real pool work:

- **Solo** *(default)* - mine with your own BTC address as the payout address. If one of your shares solves a block, the full block reward is yours. Routes through the bridge to the solo pool (default `solo.ckpool.org:3333`).
- **Shared Pool (btcpowlab)** - mine into the open btcpowlab pool. No account is required: your BTC address is used automatically as the worker login (`<address>.browser`). Earnings use a hybrid allocation (85% finder / 10% recent miners / 5% operation). Routes through the bridge to the configured shared-pool upstream (default `stratum.btcpowlab-pool.com:3333`).
- **Custom Pool** - enter your own pool's host, port, worker and password; your hashes are credited to that pool/account.
- **Merged (LTC + DOGE)** - one scrypt session against an LTC pool that puts a Dogecoin block inside the Litecoin blocks it finds (f2pool by default), so the same work is credited on both chains; the pool builds the auxpow. Offered on Litecoin only, because Litecoin is the parent chain: log in with your LTC address (or a pool account worker such as `name.rig1`) and set both payout addresses in that pool account. On the other coins the option is disabled and its label says what to pick instead.

The mode is passed to the bridge as a query parameter (e.g. `wss://stratum.tensors.vip/?coin=BTC&mode=solo`); see `stratum-bridge/README.md` for the routing and safety details.

The page sends `?coin=<BTC|LTC|DOGE|XMR>&mode=<solo|pplns|merged|custom>` and the bridge looks the upstream up in its own coin table. Solo, shared and custom work for every coin; **merged is offered on Litecoin only** (that is the parent chain), so the mode selector disables it on the other coins and its label says what to pick instead. The pool names in the bullets above are the Bitcoin defaults - Litecoin, Dogecoin and Monero have their own defaults, and merged mining has its own endpoint (`MERGED_POOL_*`; see the bridge README). Each coin validates its own wallet-address format before it will connect, and merged mode accepts an LTC address or a pool account worker.

After authorizing, the miner adapts to each pool's *share* difficulty. Its engines always **search** at difficulty 1 (the easiest target) - a hash that clears a harder pool target also clears difficulty 1, so this can never miss a share the pool would accept, and it keeps the *Best Share* panel live while the pool ramps. What it **submits** is gated separately: on a vardiff pool (btcpowlab, custom) the pool's **current** advertised difficulty is the live accept bar, so the miner submits at exactly that difficulty and lets the pool ramp it down to a browser's speed (btcpowlab ignores `mining.suggest_difficulty`, so its ramp from 1024 to 1 takes a few minutes). ckpool (solo) is different: it always enforces its own minimum (10,000 for solo), and `mining.suggest_difficulty` (1) only lowers the difficulty ckpool *reports for searching*. The miner still sends the suggestion in every mode (harmless; some pools honour it), but for solo it latches ckpool's own minimum as its **submit floor** and never sends a share below it - submitting below it just yields `Above target` rejections.

### Two different difficulties (the important part)

- **Share difficulty** (the value the pool advertises) is only the bar at which the pool *credits* a share. It decides how often a browser gets feedback; it does **not** decide whether a block is valid, and it does not change what the rest of the network accepts.
- **Network difficulty** (shown live as *Network Difficulty*) is the real Bitcoin difficulty, decoded from each job's block header `nBits`. A block is valid only when a hash meets that target.

The miner **never broadcasts a block**. It only submits shares over Stratum to the pool. The pool (ckpool) independently checks every share against the **real network target** and broadcasts a block only when one meets it - so asking for share difficulty 1 can never make the network reject anything. The **Best Share** panel shows the rarest hash the browser has produced (as a difficulty), so you can see how far it is from a block.

### Extranonce2 length (why shares were once rejected)

Every job the miner searches uses a fresh random **extranonce2**. Its length must equal the size the pool advertised in `mining.subscribe` - exactly **4 bytes** (8 hex characters) on btcpowlab, **8 bytes** on solo ckpool. `randHex(bytes)` already emits `bytes*2` hex characters, so the miner passes the pool's byte count straight through. Pre-multiplying it by 2 (as an earlier revision did) produced a double-length extranonce2 that btcpowlab rejects outright with `[20, "extranonce2 must contain exactly 4 bytes"]` - so every share was refused at the pool. Guarded by `test_en2_size.js` (source/contract) and `stratum-bridge/test_en2_size.js` (wire-level: a strict mock pool accepts the correct length and rejects the doubled one).


## Mining Engines

Pick one under **Mining Device**:

- **CPU** - the optimized double-SHA256 search runs across Web Workers (`miner-worker.js`), one per configured thread.
- **GPU** - an efficient WebGPU (WGSL) SHA-256d kernel. The CPU precomputes the SHA-256 midstate of the fixed part of each block header, so every GPU thread only hashes the second header block plus the second SHA-256 application, scanning millions of nonces per frame.
- **CPU + GPU** - runs both at once and merges their results.

All engines share `sha256.js` (identical job/merkle/header math) and every found nonce is re-verified on the CPU before it is submitted.

### Engine per coin

The coin selector also picks the engine, because each coin needs a different proof of work:

- `BTC` - the engines above (`miner-worker.js` CPU workers and/or the WebGPU kernel).
- `LTC`, `DOGE` - `scrypt-worker.js`, a pure-JavaScript scrypt (N=1024, r=1, p=1) run over the same job/merkle/header math.
- `XMR` - `xmr-worker.js`, which hashes the pool's block blob through the real RandomX VM (`randomx.wasm`, light mode, 256 MiB cache) and checks the VM's result against the pool's target.

Scrypt and RandomX are memory-hard, so there is no useful WebGPU formulation for them: the device selector stays on CPU for those coins and the page says so. RandomX additionally needs `randomx.wasm` (see `WebRandomX/README.md`); if it is missing, or the module does not expose the expected `rx_*` exports, the Monero worker reports exactly what is wrong and submits **nothing** rather than hashing with a fake VM.

## Local Testing (no deploy)

Everything can be exercised locally; no Cloud Run, no VPS and no commit is involved.

```bash
# 1) Start the bridge (terminal 1). It listens on 8080 by default.
cd stratum-bridge
npm install
node bridge.js

# 2) Serve the static frontend (terminal 2), from the repository root.
python -m http.server 8000 --directory crypto-frontend
#   (or: npx --yes serve crypto-frontend -l 8000)

# 3) Open the page pointed at the local bridge:
#    http://localhost:8000/mine-crypto.html?bridge=ws://localhost:8080
```

- `?bridge=` overrides the bridge URL for that page load only (the default stays `wss://stratum.tensors.vip`), so the deployed configuration is untouched.
- In the UI pick a coin, paste the matching wallet address, choose a mode and press start. The bridge console prints `New client connected [<COIN>/<mode>], routing to <host>:<port>` for every client - the quickest way to confirm the coin/mode routing end to end.
- Routing was verified live on 2026-10-12 from this checkout, not only against the mock pools: BTC, LTC, DOGE and XMR each in both modes dialed the upstream that belongs to them and got a real reply (a `subscribe` reply for the three Bitcoin-dialect coins, an `rx/0` job for Monero), and the DOGE pool accepted `mining.authorize` for a freshly generated wallet address - the strongest link of the chain that can be shown without actually finding a share.
- Offline tests (Node, no network): `node test_sha256.js`, `node test_scrypt.js`, `node test_en2_size.js`, `node test_xmr_protocol.js` here, plus `node test_modes.js` and `node test_en2_size.js` in `stratum-bridge/`.
- Monero needs `randomx.wasm` next to this page. It is **not** committed (it is a build artifact): build it once following `WebRandomX/README.md` and copy the result into `crypto-frontend/`. Without it the XMR engine logs the reason and submits nothing, while BTC, LTC and DOGE work immediately.

## Project Structure

- `mine-crypto.html`: The static page that loads the miner scripts.
- `sha256.js`: Shared, pure SHA-256 / Stratum mining math (midstate, merkle, header, target checks). Loaded by the page, by the worker and by the Node tests.
- `miner.js`: The mining UI, the Stratum-over-WebSocket client, and the WebGPU (WGSL) SHA-256d kernel.
- `miner-worker.js`: The CPU worker (one per thread) that searches nonce ranges.
- `scrypt.js` / `scrypt-worker.js`: Pure-JavaScript scrypt (N=1024, r=1, p=1) for Litecoin and Dogecoin, and the Web Worker that searches with it.
- `randomx.js` / `xmr-worker.js`: The page-side RandomX loader (WASI/env import stubs, `randomx.wasm` fetch and the `rx_*` ABI check) and the Web Worker that hashes Monero jobs with the resulting VM.
- `WebRandomX/`: C/C++ wrapper + CMake/emsdk build that produces `randomx.wasm` (see `WebRandomX/README.md`).
- `stratum-bridge/`: Node.js WebSocket ⇄ Stratum TCP bridge for BTC / LTC / DOGE / XMR (see `stratum-bridge/README.md`).
- `Dockerfile`: Multi-stage build that minifies the frontend assets and serves them with Nginx.
- `test_sha256.js`: Offline unit test for `sha256.js` (SHA-256 vs Node crypto, prevhash transform vs a real tip, optimized path vs the obvious path).
- `test_en2_size.js`: Regression test that the miner always submits an extranonce2 of exactly the length the pool advertised (`randHex(bytes)`, never `bytes*2`).
- `test_scrypt.js`: Offline unit test for `scrypt.js` (scrypt vs Node's `crypto.scrypt`, share target and nonce verdicts vs an independent implementation).
- `test_xmr_protocol.js`: Offline unit test for the Monero seam (`randomx.js` + the xmr-worker contract): protocol handling, ABI checks, the no-fake-VM guarantee, WASI-stub instantiation, and clear errors naming missing wasm imports.

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

## 🌉 Setting up the Stratum Bridge

The Stratum Bridge connects the browser to a Bitcoin pool (default `solo.ckpool.org:3333`) over WebSocket, forwarding Stratum JSON-RPC both ways unchanged.

1. **Navigate to the bridge directory:**
   ```bash
   cd stratum-bridge
   ```
2. **Install dependencies:**
   ```bash
   npm install
   ```
3. **Configure Settings:**
   Inside `bridge.js` (or via environment variables), customize the pools. The `CONFIG` object drives routing:
   ```javascript
   const CONFIG = {
     soloPoolHost: 'solo.ckpool.org',   // solo mode upstream
     soloPoolPort: 3333,
     pplnsPoolHost: 'stratum.btcpowlab-pool.com',  // shared-pool upstream
     pplnsPoolPort: 3333,
     allowCustomPools: true,            // ALLOW_CUSTOM_POOLS=0 to disable
   };
   ```
4. **Run the Bridge:**
   ```bash
   npm start
   # Or directly
   node bridge.js
   ```

---

## ☁️ Deploying

- **Bridge:** runs as a small Node.js container (`stratum-bridge/Dockerfile`) behind a TLS-terminating reverse proxy (e.g. Caddy) on a VPS. See `stratum-bridge/docker-compose.yml`.
- **Frontend:** the multi-stage `Dockerfile` minifies the assets, caches them in the browser and serves them with Nginx; deploy as a container to Google Cloud Run.

---

## 🏗 Architecture (Cloud Run stays cheap)

All mining traffic is WebSocket and goes **directly** from the browser to the VPS stratum bridge (`wss://stratum.tensors.vip`) - it never touches Cloud Run. Cloud Run only serves a few static files (`index.html`, `miner.js`, `sha256.js`, `miner-worker.js`) through Nginx with gzip and browser caching, and is scaled to zero between requests.

- **Cloud Run (frontend):** static files only - no WebSocket, no proxying, no computation. Scale to zero (`--min-instances=0`).
- **VPS (bridge):** every stratum connection and all share submission. This is the only component that grows with the number of miners.

Deploy the frontend scaled to zero, e.g.:

```bash
gcloud run deploy miner \
  --source . --region us-central1 --allow-unauthenticated \
  --port 80 --min-instances 0 --max-instances 3 \
  --memory 128Mi --cpu 1 --cpu-throttling
```
