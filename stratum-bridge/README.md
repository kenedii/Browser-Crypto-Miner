# Stratum Bridge (BTC / LTC / DOGE / XMR)

A small WebSocket -> Stratum TCP bridge for **Bitcoin, Litecoin, Dogecoin and Monero**. Browsers connect over WebSocket; the bridge opens a TCP connection to an upstream pool for the selected coin and relays Stratum JSON-RPC messages both ways unchanged. There is no dev fee: the bridge never re-authorizes or rewrites the miner's login.

## Supported coins

The client picks the coin with the `?coin=` query parameter (`BTC` by default; `LTC`, `DOGE`, `XMR` are upper-cased, so any case works). The relay itself is protocol-agnostic - the only coin-specific knowledge lives in the `COINS` table of `bridge.js`:

| Coin | Algo | Stratum dialect | Default solo upstream | Default shared (pplns) upstream |
| --- | --- | --- | --- | --- |
| `BTC` | SHA-256d | Bitcoin-style `mining.subscribe` / `mining.notify` | `solo.ckpool.org:3333` | `stratum.btcpowlab-pool.com:3333` (open, no account) |
| `LTC` | Scrypt | identical to Bitcoin | `ltc.viabtc.io:3333` | same as solo unless `LTC_PPLNS_POOL_*` is set |
| `DOGE` | Scrypt | identical to Bitcoin | `doge.mine.zpool.ca:3333` | same as solo unless `DOGE_PPLNS_POOL_*` is set |
| `XMR` | RandomX | xmrig-style `login` / `job` / `submit` | `pool.supportxmr.com:3333` | same as solo unless `XMR_PPLNS_POOL_*` is set |

Merged mining is not a coin: `mode=merged` is the LTC + DOGE pair, parented on
Litecoin, and dials its own upstream (`MERGED_POOL_HOST` / `MERGED_POOL_PORT`,
default `ltc.f2pool.com:8888`).

Scrypt coins speak the exact same wire dialect as Bitcoin, so the generic relay carries them unchanged. Monero pools speak the xmrig dialect instead - still plain newline-delimited JSON-RPC, only the message names differ (`login`/`job`/`submit` instead of `subscribe`/`notify`/`submit`). Every default is a public pool; override the environment variables below to point a coin at your own backend.

These defaults are the ones the bridge actually ships, and each was checked live (subscribe/login each upstream, then a client through the bridge): `solo.ckpool.org:3333`, `stratum.btcpowlab-pool.com:3333`, `ltc.viabtc.io:3333`, `doge.mine.zpool.ca:3333` and `pool.supportxmr.com:3333` all answer. Dogecoin used to point at viaBTC, but `doge.viabtc.io` no longer resolves (`ENOTFOUND`), so it moved to zpool.ca - another pooled upstream that credits the bare address. If a default goes dark again, re-point that coin with `*_POOL_HOST` / `*_POOL_PORT`; no code change is needed.

## Mining modes

The client selects a mode with the `?mode=` query parameter. The web UI defaults to `solo`.

- `mode=solo` - routes to the solo pool (`BTC_POOL_HOST`). The miner authorizes with its own wallet address for the selected coin; if one of its shares solves a block, the full block reward is theirs. A bare `?coin=BTC` also routes here.
- `mode=pplns` - routes to that coin's shared pool: `PPLNS_POOL_HOST` / `PPLNS_POOL_PORT` for BTC (default `stratum.btcpowlab-pool.com:3333`), `LTC_PPLNS_POOL_*`, `DOGE_PPLNS_POOL_*` and `XMR_PPLNS_POOL_*` for the other three (each defaults to that coin's solo upstream). btcpowlab is an open pool: no account is required and the miner is credited as `<btc-address>.browser` (the bridge relays the login unchanged). Earnings use a hybrid allocation (85% finder / 10% recent miners / 5% operation). Override the env vars only to point at your own pool backend.
- `mode=merged` - LTC + DOGE auxpow **merged mining**: one scrypt session against `MERGED_POOL_HOST` / `MERGED_POOL_PORT` (default `ltc.f2pool.com:8888`), where the pool puts a Dogecoin block inside the Litecoin blocks it finds, so the same hashrate is credited on both chains and the pool builds the auxpow. The wire format is ordinary Bitcoin-style stratum, so the generic relay carries it unchanged: the miner logs in with its own LTC address (the parent chain) or a pool account worker such as `name.rig1`, and submits exactly the shares it always does. Only the two scrypt coins accept the mode - `?coin=BTC&mode=merged` and `?coin=XMR&mode=merged` are refused with a reason - and since Litecoin is the parent, `?coin=DOGE&mode=merged` dials the same endpoint as `?coin=LTC&mode=merged`. Verified live: `ltc.f2pool.com:8888` answered `mining.authorize` for a bare LTC address and returned a real Litecoin job, and f2pool's own coin page quotes Litecoin revenue as "LTC + DOGE" per GH/s (that merged payout is why it is the default).
- `mode=custom` - the client supplies `&host=` and `&port=` and the bridge dials that pool ("mine for my own pool"). Disable with `ALLOW_CUSTOM_POOLS=0`. Only ports listed in `CUSTOM_POOL_PORTS` are allowed and private/loopback hosts are rejected, so the bridge cannot be abused as an SSRF proxy.

## How it works

- Client connects to the bridge via WebSocket (with its mode and, for custom pools, host/port).
- The bridge opens a TCP connection to the selected coin's upstream pool and forwards messages both ways.
- Messages are relayed unchanged (apart from answering the client's `mining.ping` keepalive locally), so every share is credited to the login the miner authorized with.

## Share difficulty

- The frontend defaults to `solo`. Its miner always *searches* at difficulty 1 (the easiest target) and only **submits** what clears the pool's live accept bar. It sends `mining.suggest_difficulty` (1) in every mode, but this is best-effort: btcpowlab ignores it and instead ramps its own advertised difficulty down to a browser's speed (starting at 1024, taking a few minutes to reach 1), while ckpool relays the value back yet still enforces its own minimum (10,000 for solo). The miner therefore tracks a vardiff pool's current advertised difficulty exactly as its submit floor, and latches ckpool's own minimum as the floor in solo - so it never sends a share the pool will reject as `Above target`. The bridge just relays `mining.suggest_difficulty` upstream unchanged. Note this is the **share** difficulty only - the **network** difficulty (decoded from each job's `nBits`) is separate, and the pool - not the browser - checks it and broadcasts any block, so a low share difficulty can never make the network reject a block. Monero jobs work differently: each one carries its own `target` (plus the `seed_hash` that keys the RandomX cache) instead of a suggested difficulty, and the miner checks every RandomX result against that job target. The bridge rewrites none of it.

## Configuration (`bridge.js` / environment overrides)

- `PORT` - WebSocket port to listen on (default 8080)
- `BTC_POOL_HOST` - solo pool host (default `solo.ckpool.org`)
- `BTC_POOL_PORT` - solo pool port (default `3333`)
- `PPLNS_POOL_HOST` - shared-pool host (default `stratum.btcpowlab-pool.com`)
- `PPLNS_POOL_PORT` - PPLNS pool port (default `3333`)
- `ALLOW_CUSTOM_POOLS=0` - disable client-supplied custom pools (enabled by default)
- `CUSTOM_POOL_PORTS` - comma-separated allow-list of ports for custom pools
- `LTC_POOL_HOST` / `LTC_POOL_PORT` - Litecoin upstream (default `ltc.viabtc.io:3333`)
- `LTC_PPLNS_POOL_HOST` / `LTC_PPLNS_POOL_PORT` - Litecoin shared-pool upstream (default: the solo one)
- `DOGE_POOL_HOST` / `DOGE_POOL_PORT` - Dogecoin upstream (default `doge.mine.zpool.ca:3333`)
- `DOGE_PPLNS_POOL_HOST` / `DOGE_PPLNS_POOL_PORT` - Dogecoin shared-pool upstream (default: the solo one)
- `MERGED_POOL_HOST` / `MERGED_POOL_PORT` - merged-mining upstream, an LTC pool that embeds DOGE blocks (default `ltc.f2pool.com:8888`); used by `mode=merged`, which both scrypt coins dial
- `XMR_POOL_HOST` / `XMR_POOL_PORT` - Monero upstream (default `pool.supportxmr.com:3333`)
- `XMR_PPLNS_POOL_HOST` / `XMR_PPLNS_POOL_PORT` - Monero shared-pool upstream (default: the solo one)

## The shared-pool (PPLNS) backend

There is no "lightweight" way to self-host real PPLNS: PPLNS needs a pool server that builds block templates, tracks each miner's shares over a rolling window and pays out proportionally from the blocks it finds - i.e. a full node + pool software + a hot wallet + a payout pipeline. The pragmatic option is to ride an existing open pool. The default upstream (`stratum.btcpowlab-pool.com`) is exactly that: an open hybrid-solo pool that needs no account. Only set `PPLNS_POOL_HOST` / `PPLNS_POOL_PORT` if you actually operate your own pool.

## Examples (WebSocket URLs expected by the frontend)

- Solo: `...?coin=BTC&mode=solo` (bare `?coin=BTC` also routes to solo)
- Shared pool (btcpowlab): `...?coin=BTC&mode=pplns`
- Custom pool: `...?coin=BTC&mode=custom&host=pool.example.com&port=3333`
- Litecoin / Dogecoin (Scrypt, Bitcoin-style dialect): `...?coin=LTC&mode=pplns`, `...?coin=DOGE&mode=solo`
- Merged LTC + DOGE (auxpow, one session for both chains): `...?coin=LTC&mode=merged` (or `coin=DOGE` - the parent pool is the same endpoint)
- Monero (RandomX, xmrig dialect): `...?coin=XMR&mode=pplns`
- Behind TLS: `wss://stratum.tensors.vip/?coin=BTC&mode=solo`, `wss://stratum.tensors.vip/?coin=XMR&mode=pplns`

## Running

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

## Tests

- `node test_modes.js` - verifies coin/mode routing: **every** coin (BTC / LTC / DOGE / XMR) in **both** real modes (solo, pplns) dials the upstream that belongs to it (eight separate mock pools, so a coin or mode mix-up cannot hide behind a shared connection counter), the pool's reply is relayed back to the client for the xmrig dialect as well as the Bitcoin one, a bare `?coin=BTC` defaults to solo, an unknown coin is rejected, custom mode rejects blocked hosts and disallowed ports, and all four default upstream hostnames are still present. Local mocks only.
- `node test_share_e2e.js` - runs the bridge against a mock pool that hands out a **real** captured Bitcoin job at a low difficulty and then **independently verifies** the submitted share (Node crypto + real block-header byte order). Proves the whole job -> hash -> submit pipeline, including the stratum prevhash transform and the `<address>.browser` login.
- `node test_en2_size.js` - wire-level regression for the extranonce2 length bug: a strict mock pool (like btcpowlab) advertises a 4-byte extranonce2 and rejects any wrong-sized `en2` with `[20, "extranonce2 must contain exactly 4 bytes"]`. Two clients submit a real share through the bridge - the correct 4-byte `en2` is **accepted**, the doubled 8-byte one is **rejected**.
- `node test_local.js` - starts a stub Bitcoin stratum server and verifies the bridge relays messages end-to-end. The stub is a local mock only; it performs no real network mining.
- `node test_local_btc.js` - a quick subscribe check against a bridge running on `localhost:8080`.
- `node test_live_mining.js` - **performs real network work**: connects to `wss://stratum.tensors.vip` in solo and pplns modes, negotiates difficulty and mines the real jobs for ~20s each.

## Notes

- The bridge forwards JSON-RPC lines and appends newlines; it expects miners that follow the usual Bitcoin stratum formatting.
- It only parses the client's query string (`coin`, `mode`, and `host`/`port` for custom pools); it never has to understand the mining protocol, because whatever a pool sends is forwarded to the client unchanged. That is why the same relay serves the xmrig Monero dialect without special cases.
- To exercise the frontend against a local bridge, append `?bridge=ws://localhost:8080` to the page URL (see the "Local Testing" section of `crypto-frontend/README.md`); without it the page keeps using the deployed `wss://stratum.tensors.vip`.
