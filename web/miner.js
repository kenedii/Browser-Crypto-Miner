// Miner Logic Refactored for Main Page Integration
function runMinerApp() {
    console.log("Miner App Starting...");
    const container = document.getElementById('miner-app-container');
    if (!container) {
        console.log("Miner Container Not Found - skipping initialization");
        return; 
    }
    
    // Define State Variables First
    let isMining = false;
    let startTime = 0;
    let animationFrameId;
    let totalHashes = 0;
    let sharesFound = 0;

    // Stratum session / reconnect state (see scheduleReconnect below).
    let wantMining = false;        // user intent: keep the pool session alive

    // While a miner runs the whole page goes static (cube lattice, binary rain,
    // hex ticker and CSS animations) so every cycle goes to hashing. See lattice.js.
    function setAmbient(on) {
        try {
            document.body.classList.toggle('mining', !on);
            if (window.__ambient) { if (on) window.__ambient.resume(); else window.__ambient.pause(); }
        } catch (e) {}
    }
    let stratumConnected = false;  // pool session currently authorized
    let reconnectAttempts = 0;
    let reconnectTimer = null;
    let keepaliveTimer = null;
    
    // Network State
    let currentBlockHeight = 0;
    let currentBlockHash = "";
    let difficulty = 1; // Default difficulty
    let currentBits = 0;
    let bestShareDiff = 0; // rarest hash found so far, as a difficulty

    // Web Workers for CPU
    let workers = [];
    
    // GPU State
    let adapter = null;
    let device = null;
    let pipeline = null;
    let bindGroup = null;
    const GPU_MAX_FOUND = 64;

  // Bridge config - public WebSocket stratum bridge. A ?bridge= query parameter
  // overrides it for that page load only, so the page can be pointed at a locally
  // running stratum-bridge (mine-crypto.html?bridge=ws://localhost:8080) without
  // editing this file or touching the deployed configuration.
  const BRIDGE_URL = (function () {
      const override = new URLSearchParams(location.search).get('bridge');
      if (!override) return "wss://stratum.tensors.vip";
      return /^wss?:\/\//i.test(override) ? override : 'ws://' + override;
  })();
    let stratumWs = null;
    let suggestedDifficulty = false;
    // The pool's minimum share difficulty: the bar a found hash must clear to be
    // worth submitting. How it is derived depends on the pool:
    //   - vardiff pools (btcpowlab, custom): the *current* advertised difficulty
    //     is the live accept bar and it moves up/down, so we track it exactly.
    //   - ckpool solo: it always enforces its own minimum (10,000 for solo). Its
    //     mining.suggest_difficulty only lowers the *reported search* difficulty;
    //     shares below the minimum are still rejected as "Above target". So for
    //     solo we latch the *highest* difficulty the pool advertises.
    let poolSubmitFloor = 0;
    let poolLatchHighestDifficulty = false; // true in solo mode; set per connection

    // The difficulty every engine *searches* at: deliberately the lowest (easiest)
    // Bitcoin pool difficulty. A hash that clears a harder pool target also clears
    // difficulty 1, so searching here never misses a share the pool would accept -
    // it just means we examine (and can display) many more hashes, keeping the
    // "Best Share" tile live even while the pool is still ramping its own, harder
    // difficulty down to a browser's speed. What we actually *submit* stays gated
    // by poolSubmitFloor (the pool's advertised difficulty).
    const SEARCH_DIFFICULTY = 1;

    // Clear loading message and inject UI
    container.innerHTML = '';
    container.innerHTML = `
      <div class="miner-panel">
        <div class="row2">
          <div class="field">
            <label for="coin">Crypto / Pool</label>
            <select id="coin">
              <option value="BTC" selected>Bitcoin (BTC) - SHA-256d</option>
              <option value="LTC">Litecoin (LTC) - Scrypt</option>
              <option value="DOGE">Dogecoin (DOGE) - Scrypt</option>
              <option value="XMR">Monero (XMR) - RandomX</option>
            </select>
          </div>
          <div class="field">
            <label for="mode">Mining Mode</label>
            <select id="mode">
              <option value="solo" selected>Solo - mine and keep the full block reward (default)</option>
              <option value="pplns">Shared Pool (btcpowlab) - PPLNS / hybrid, no account needed</option>
              <option value="merged" id="mode-merged">Merged (LTC + DOGE) - one scrypt session, both chains</option>
              <option value="custom">Custom Pool - mine for your own pool</option>
            </select>
          </div>
        </div>

        <div class="field addr">
          <label for="address" id="address-label">Wallet Address</label>
          <input type="text" id="address" placeholder="Enter your BTC address" value="" autocomplete="off" spellcheck="false">
          <button id="preset-btn" class="preset-btn" type="button" title="Fill in the project's own address for the selected coin">Preset</button>
          <div id="address-hint">
            No account or username is needed for the default pool &mdash; you are logged in automatically as
            <code>&lt;your-address&gt;.browser</code>.
          </div>
          <div id="pool-dashboard">
            <a href="https://btcpowlab-pool.com/start" target="_blank" rel="noopener">View the live pool dashboard &nearr;</a>
          </div>
        </div>

        <div class="field" id="custom-pool-group" style="display: none;">
          <label>Custom Pool Connection</label>
          <input type="text" id="pool-host" placeholder="Pool host (e.g. pool.example.com)">
          <input type="number" id="pool-port" placeholder="Port (e.g. 3333)">
          <input type="text" id="pool-worker" placeholder="Worker / username">
          <input type="password" id="pool-password" placeholder="Password (x if none required)">
        </div>

        <div class="row2">
          <div class="field">
            <label for="device">Mining Device</label>
            <select id="device">
              <option value="">Detecting devices...</option>
            </select>
          </div>
          <div class="field" id="cpu-threads-group">
            <label for="threads">CPU Threads</label>
            <input type="number" id="threads" min="1" max="128" value="1">
          </div>
        </div>

        <div class="field" id="gpu-intensity-group" style="display: none;">
          <label for="intensity">GPU Intensity (nonces per batch: <span id="intensity-val">1,048,576</span>)</label>
          <input type="range" id="intensity" min="64" max="65535" value="16384" step="64">
        </div>

        <div class="stats">
          <div class="stat-item"><div class="stat-value" id="hashrate">0.00 MH/s</div><div class="stat-label">Hashrate</div></div>
          <div class="stat-item"><div class="stat-value" id="network-block">...</div><div class="stat-label">Current Block</div></div>
          <div class="stat-item"><div class="stat-value" id="runtime">00:00:00</div><div class="stat-label">Time Elapsed</div></div>
          <div class="stat-item"><div class="stat-value" id="difficulty">...</div><div class="stat-label">Network Difficulty</div></div>
          <div class="stat-item"><div class="stat-value" id="share-difficulty">...</div><div class="stat-label">Share Difficulty</div></div>
          <div class="stat-item"><div class="stat-value" id="best-share">0</div><div class="stat-label">Best Share</div></div>
          <div class="stat-item"><div class="stat-value" id="total-hashes">0</div><div class="stat-label">Total Hashes</div></div>
          <div class="stat-item"><div class="stat-value" id="network-status">Only Local</div><div class="stat-label">Network</div></div>
        </div>

        <div id="status">Ready to initialize</div>

        <div class="miner-console">
          <div class="console-head">
            <span class="lbl">Console</span>
            <button id="console-clear" type="button">Clear</button>
          </div>
          <div id="console-log" aria-live="polite"></div>
        </div>

        <div class="btn-row">
          <button id="start-btn" class="btn" type="button">Start Mining</button>
          <button id="stop-btn" class="btn" type="button" disabled>Stop</button>
        </div>
      </div>

      <section class="faq">
        <button id="faq-toggle" class="faq-btn" type="button" aria-expanded="false" aria-controls="faq-body">
          <span>FAQ</span><span class="arrow" aria-hidden="true">&#9662;</span>
        </button>
        <div id="faq-body" class="faq-body" role="region" aria-label="Frequently asked questions">
          <div class="faq-inner">
            <div class="faq-content">
              <h3>What is this?</h3>
              <p>
                A browser-based miner for four coins. Your tab does the <strong>real</strong> proof-of-work &mdash; double-SHA-256 for Bitcoin, Scrypt for Litecoin and Dogecoin, RandomX for Monero &mdash; and submits the shares to a real pool. Browsers cannot open raw TCP sockets, so the work travels through a small <strong>Stratum Bridge</strong> at wss://stratum.tensors.vip that translates WebSocket to the pool's Stratum protocol. The bridge only relays: it holds no keys and takes no cut.
              </p>

              <h3>Can I really find a block?</h3>
              <p>
                In theory, yes &mdash; every share is a genuine candidate. In practice, no: a browser finding a Bitcoin block is roughly one chance in hundreds of millions of years of nonstop mining. Treat this as an honest lottery and a technology demo, not a money machine. A share only matters if the <em>pool</em> accepts it. This page just forwards your shares to the pool and never broadcasts anything to the network itself. The pool checks every share against the network target and, only when one also meets that target, builds the full block and submits it to the network through its own node.
              </p>

              <h3>Three numbers, not one</h3>
              <ul>
                <li><strong>Network Difficulty</strong> &mdash; the real, live difficulty read straight from each job. A block needs a hash at or below that target.</li>
                <li><strong>Share Difficulty</strong> &mdash; the lowest difficulty the pool will credit. Anything easier is rejected as &ldquo;Above target&rdquo;, so the miner never sends it. Values shown as &ldquo;min&rdquo; are that floor.</li>
                <li><strong>Best Share</strong> &mdash; the rarest hash you have found so far, even if it is below the pool's minimum. The Bitcoin engines search at difficulty 1 so this keeps moving, and any hash the pool accepts is submitted the moment it is found.</li>
              </ul>

              <h3>Mining modes</h3>
              <ul>
                <li><strong>Solo</strong> &mdash; your own address is the payout address; if a share solves a block, the full reward is yours. Note that solo.ckpool.org enforces a minimum share difficulty of 10,000, which a browser cannot realistically reach, so on Bitcoin solo the page mostly tracks your best local share and submits nothing.</li>
                <li><strong>Shared Pool</strong> &mdash; no account needed; your address is credited automatically. Bitcoin uses the btcpowlab hybrid pool (85% to the block finder, 10% to other recent miners, 5% to operation) and starts every miner at difficulty 1024, so it can take a few minutes of vardiff to ramp down. Litecoin uses ltc.viabtc.io, Dogecoin doge.mine.zpool.ca, and Monero uses <strong>P2Pool</strong> &mdash; a decentralized pool with no operator, paid straight to your address.</li>
                <li><strong>Merged (LTC + DOGE)</strong> &mdash; one Scrypt session at an LTC pool (ltc.f2pool.com) that embeds Dogecoin blocks inside the Litecoin blocks it finds, so the same work is credited on both chains. You enter one login (your LTC address or a pool account worker such as <code>name.rig1</code>); set both payout addresses in that pool account. The pool builds the auxpow &mdash; this page only submits shares.</li>
                <li><strong>Custom Pool</strong> &mdash; enter your own pool's host, port and worker login; your hashes are credited to that account.</li>
              </ul>

              <h3>Engines and expected speed</h3>
              <p>
                Bitcoin can use CPU Web Workers, the WebGPU (WGSL) SHA-256d kernel that scans millions of nonces per frame, or both at once. Litecoin, Dogecoin (Scrypt) and Monero (RandomX) are memory-hard by design and run on the CPU only &mdash; expect kilohashes per second for Scrypt and a handful of hashes per second for RandomX. More CPU threads means more speed and more heat.
              </p>

              <h3>Wallet addresses</h3>
              <p>
                Each coin validates its own address format before connecting, so a Bitcoin address can never credit a Litecoin, Dogecoin or Monero share. Use an address you control &mdash; payouts go directly to it.
              </p>

              <h3>What does the Preset button do?</h3>
              <p>
                <strong>Preset</strong> fills the address box with this project's own receiving address for the selected coin. Anything mined with it is credited to the website, not to you. Use it to benchmark your hardware, to try the miner without a wallet, or to support the network and the project. If you want any reward for yourself, however unlikely, enter your own address instead.
              </p>

              <h3>How decentralized is it?</h3>
              <p>
                The <strong>pool</strong> is the part that talks to the blockchain. It runs (or is connected to) a full node, asks that node for a block template, and turns it into the jobs your miner receives (<code>mining.notify</code> for Bitcoin-style coins, <code>job</code> for Monero). When a share also meets the network target, the pool assembles the block and broadcasts it through that node to the rest of the network.
              </p>
              <p>
                The <strong>bridge</strong> only exists because a browser cannot open a raw TCP socket and pools speak Stratum over TCP. Your tab opens a WebSocket (<code>wss://</code>) to the bridge, and the bridge opens one TCP connection to the chosen pool and relays the newline-delimited JSON-RPC messages in both directions, unchanged. It runs no node, holds no chain state and never sees or builds a block. It sees your public receiving address and connection metadata such as your IP, and a bridge operator could in principle delay or drop messages, so you can host your own bridge and point the page at it with <code>?bridge=ws://your-host:8080</code>.
              </p>
              <p>
                For Monero the shared pool is <strong>P2Pool</strong>, which has no operator at all. Its container connects to a Monero node over RPC and ZMQ to get block templates and to submit blocks, and to other P2Pool peers over the P2P network to share the sidechain. Payouts are written into the block's coinbase transaction, so a block pays you directly with no pool wallet in between. The remaining central piece is the bridge between your browser and that P2Pool node. This project is about making proof-of-work reachable from any browser, not about replacing dedicated mining hardware.
              </p>

              <h3>Is it safe?</h3>
              <p>
                Mining happens only while this tab is open and stops the moment you press Stop or close it. Nothing is installed and no private keys are ever requested &mdash; only a public receiving address. The console above logs every connection, job and share so you can see exactly what the page is doing.
              </p>
            </div>
          </div>
        </div>
      </section>
    `;

    // Logic
    const elements = {
      coin: document.getElementById("coin"),
      mode: document.getElementById("mode"),
      address: document.getElementById("address"),
      consoleLog: document.getElementById("console-log"),
      consoleClear: document.getElementById("console-clear"),
      device: document.getElementById("device"),
      startBtn: document.getElementById("start-btn"),
      stopBtn: document.getElementById("stop-btn"),
      hashrate: document.getElementById("hashrate"),
      runtime: document.getElementById("runtime"),
      networkBlock: document.getElementById("network-block"),
      networkDiff: document.getElementById("difficulty"),
      shareDiff: document.getElementById("share-difficulty"),
      bestShare: document.getElementById("best-share"),
      status: document.getElementById("status"),
      intensity: document.getElementById("intensity"),
      intensityVal: document.getElementById("intensity-val"),
      threads: document.getElementById("threads"),
      cpuGroup: document.getElementById("cpu-threads-group"),
      gpuGroup: document.getElementById("gpu-intensity-group"),
      totalHashesDisplay: document.getElementById("total-hashes"),
      networkStatus: document.getElementById("network-status"),
      customGroup: document.getElementById("custom-pool-group"),
      poolHost: document.getElementById("pool-host"),
      poolPort: document.getElementById("pool-port"),
      poolWorker: document.getElementById("pool-worker"),
      poolPassword: document.getElementById("pool-password"),
      presetBtn: document.getElementById("preset-btn"),
      addressHint: document.getElementById("address-hint"),
      addressLabel: document.getElementById("address-label"),
      poolDashboard: document.getElementById("pool-dashboard"),
      modeMerged: document.getElementById("mode-merged"),
    };

    // FAQ drop-down at the bottom of the panel.
    (function () {
        const faqBtn = document.getElementById('faq-toggle');
        const faqBody = document.getElementById('faq-body');
        if (!faqBtn || !faqBody) return;
        faqBtn.addEventListener('click', () => {
            const open = faqBody.classList.toggle('open');
            faqBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
            if (open) setTimeout(() => faqBtn.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
        });
    })();

    // ---- Coins -------------------------------------------------------------
    // One table drives the whole page: the proof of work the pool speaks, the
    // worker that runs it, whether a GPU path exists, and how a wallet address for
    // that chain looks. The bridge chooses the upstream pool from ?coin=, so the
    // only coin-specific knowledge on the page lives here.
    //
    //   stratum 'btc'   - Bitcoin-style subscribe / authorize / mining.notify
    //                     (BTC double-SHA-256d; LTC + DOGE Scrypt - identical wire
    //                     format, only the PoW hash differs)
    //   stratum 'xmrig' - xmrig-style login / job / submit (XMR RandomX)
    const COINS = {
        BTC: {
            name: 'Bitcoin', ticker: 'BTC', algo: 'SHA-256d',
            stratum: 'btc', worker: 'miner-worker.js', gpu: true,
            addressLabel: 'BTC Wallet Address',
            placeholder: 'Enter your BTC address (bc1..., 1..., 3...)',
            loginHint: 'your BTC address',
            preset: 'bc1qy4lgxfe8uqk3rdjlmzjp6fwcr4eylw87pvstlw',
            soloPool: 'solo.ckpool.org',
            sharedPool: 'stratum.btcpowlab-pool.com',
            pattern: /^(1|3|bc1)[a-zA-Z0-9]{25,59}$/,
            invalid: 'Invalid Bitcoin address (expected bech32 "bc1..." or base58 "1..."/"3...").'
        },
        LTC: {
            name: 'Litecoin', ticker: 'LTC', algo: 'Scrypt',
            stratum: 'btc', worker: 'scrypt-worker.js', gpu: false,
            addressLabel: 'LTC Wallet Address',
            placeholder: 'Enter your Litecoin address (L..., M..., ltc1...)',
            loginHint: 'your LTC address',
            preset: 'ltc1qecehm39tr553axsawka8nt4hpesvpszk3jwaq3',
            soloPool: 'ltc.viabtc.io',
            sharedPool: 'ltc.viabtc.io',
            // Merged mining is parented on Litecoin: one scrypt session against
            // an LTC pool that embeds Dogecoin blocks (f2pool's own Litecoin
            // page quotes revenue as "LTC + DOGE" per GH/s), so the same work is
            // credited on both chains. Only this coin offers the merged mode -
            // see applyCoinUI() and the bridge's MERGED_POOL_* settings.
            mergedPool: 'ltc.f2pool.com:8888',
            pattern: /^(ltc1[a-z0-9]{25,50}|[LM][1-9A-HJ-NP-Za-km-z]{25,40})$/,
            invalid: 'Invalid Litecoin address (expected bech32 "ltc1..." or base58 "L..."/"M...").'
        },
        DOGE: {
            name: 'Dogecoin', ticker: 'DOGE', algo: 'Scrypt',
            stratum: 'btc', worker: 'scrypt-worker.js', gpu: false,
            addressLabel: 'DOGE Wallet Address',
            placeholder: 'Enter your Dogecoin address (D..., 9..., A...)',
            loginHint: 'your DOGE address',
            preset: 'DHGdXEtBJKwe7VqDyQ84vatRPmndmLAv8k',
            soloPool: 'doge.mine.zpool.ca',
            sharedPool: 'doge.mine.zpool.ca',
            pattern: /^(D|9|A)[1-9A-HJ-NP-Za-km-z]{25,33}$/,
            invalid: 'Invalid Dogecoin address (expected a base58 "D..."/"9..."/"A..." address).'
        },
        XMR: {
            name: 'Monero', ticker: 'XMR', algo: 'RandomX',
            stratum: 'xmrig', worker: 'xmr-worker.js', gpu: false,
            addressLabel: 'XMR Wallet Address',
            placeholder: 'Enter your Monero address (4... standard, 8... subaddress)',
            loginHint: 'your XMR address',
            preset: '428NMrdxubyintHnch3L44VLWEcsK54iMcaSyczXfsMXLBh9NgDboWwTDi7MTpGPaxKq2CGdF12s1LGNaAqa1Ab1LjcrhZA',
            soloPool: 'pool.supportxmr.com',
            sharedPool: 'P2Pool (decentralized)',
            // Standard (4...) and subaddress (8...) are 95 chars, integrated 106.
            pattern: /^[48][1-9A-HJ-NP-Za-km-z]{93,105}$/,
            invalid: 'Invalid Monero address (expected 95/106 base58 chars starting with 4 or 8).'
        }
    };
    const DEFAULT_COIN = 'BTC';

    // The "shared pool" has a different name (and host) on every chain, so the
    // mode dropdown text follows the selected coin.
    const MODE_LABELS = {
        BTC: [
            'Solo - mine and keep the full block reward (default)',
            'Shared Pool (btcpowlab) - PPLNS / hybrid, no account needed',
            'Merged (LTC + DOGE) - Litecoin mode only',
            'Custom Pool - mine for your own pool'
        ],
        LTC: [
            'Solo - your own LTC address pays out (ltc.viabtc.io)',
            'Shared Pool (ltc.viabtc.io) - credited to your address',
            'Merged (LTC + DOGE) - one scrypt session, both chains credited',
            'Custom Pool - mine for your own pool'
        ],
        DOGE: [
            'Solo - your own DOGE address pays out (doge.mine.zpool.ca)',
            'Shared Pool (doge.mine.zpool.ca) - credited to your address',
            'Merged (LTC + DOGE) - pick Litecoin above to mine the pair',
            'Custom Pool - mine for your own pool'
        ],
        XMR: [
            'Solo - your own address pays out (pool.supportxmr.com)',
            'Shared Pool - P2Pool (decentralized, no operator) - paid to your address',
            'Merged (LTC + DOGE) - scrypt only, not Monero',
            'Custom Pool - mine for your own pool'
        ]
    };

    // Selected-coin helpers. Everything downstream asks these instead of reading the
    // <select> directly, so an unknown value can never break the miner.
    function coinKey() {
        const v = elements.coin.value;
        return COINS[v] ? v : DEFAULT_COIN;
    }
    function currentCoin() { return COINS[coinKey()]; }

    // Preset: fills in the project's own receiving address for the selected coin,
    // so a visitor can benchmark or support the network without owning a wallet.
    // Work mined with it is credited to the website (see the FAQ).
    if (elements.presetBtn) {
        elements.presetBtn.addEventListener('click', () => {
            if (elements.address.disabled) return;
            const c = currentCoin();
            if (!c || !c.preset) return;
            elements.address.value = c.preset;
            elements.address.dispatchEvent(new Event('input', { bubbles: true }));
            logLine('Preset ' + c.ticker + ' address loaded - work mined with it is credited to this website ' +
                '(benchmarking / supporting the network). Enter your own address to be credited instead.', 'info');
        });
    }
    function isXmr() { return currentCoin().stratum === 'xmrig'; }

    // ---- On-page console --------------------------------------------------
    // A bounded, timestamped log that mirrors exactly what we also print to the
    // browser's own devtools console, so the user can follow what the miner is
    // doing (and where shares go) without opening devtools.
    const MAX_LOG_LINES = 200;
    const LOG_COLORS = {
        info: 'rgba(216, 245, 255, 0.82)',
        ok: '#00ff66',
        warn: '#ffb020',
        error: '#ff2a4d',
        pool: '#19a7ff'
    };
    function logLine(message, level) {
        try { console.log('[miner] ' + message); } catch (e) {}
        if (!elements.consoleLog) return;
        const row = document.createElement('div');
        row.textContent = '[' + new Date().toLocaleTimeString() + '] ' + message;
        row.style.color = LOG_COLORS[level] || LOG_COLORS.info;
        elements.consoleLog.appendChild(row);
        while (elements.consoleLog.childElementCount > MAX_LOG_LINES) {
            elements.consoleLog.removeChild(elements.consoleLog.firstChild);
        }
        elements.consoleLog.scrollTop = elements.consoleLog.scrollHeight;
    }

    if (elements.consoleClear) {
        elements.consoleClear.addEventListener('click', () => {
            if (elements.consoleLog) elements.consoleLog.innerHTML = '';
            logLine('Console cleared.', 'info');
        });
    }

    // Human-readable pool the bridge is currently mining to. The bridge dials these
    // hosts per coin (see the COINS table); Custom uses the typed-in fields.
    function getPoolLabel() {
        const mode = elements.mode.value;
        const c = currentCoin();
        if (mode === 'custom') {
            const host = (elements.poolHost.value || '').trim();
            const port = (elements.poolPort.value || '').trim();
            if (!host) return 'custom pool';
            return port ? host + ':' + port : host;
        }
        if (mode === 'merged') {
            return (c.mergedPool || 'ltc.f2pool.com:8888') + ' (LTC + DOGE merged)';
        }
        return (mode === 'pplns' ? c.sharedPool : c.soloPool) + ' (' + c.ticker + ')';
    }

    // Outstanding share submissions, keyed by Stratum request id, so the pool's
    // accept/reject reply can be matched back to the exact share that was sent.
    let lastLoggedJob = null;
    let shareSeq = 0;
    const pendingShares = new Map();

    // UI Event Listeners
    // Switching coin re-labels the form (address field, mode options, engines) and
    // rebuilds the engine list, because Scrypt and RandomX have no GPU path.
    elements.coin.addEventListener('change', () => {
         applyCoinUI(true);
    });

    // Reflect the selected mode in the form: Solo / PPLNS use the wallet
    // address as the payout / credit address; Custom Pool uses its own login.
    const DEFAULT_POOL_HOST = "stratum.btcpowlab-pool.com";

    function applyModeUI() {
        const mode = elements.mode.value;
        const c = currentCoin();
        const isCustom = mode === 'custom';
        const isSharedPool = mode === 'pplns';
        const isMerged = mode === 'merged';

        // The btcpowlab dashboard belongs to Bitcoin's built-in shared pool, so show
        // it only when that pool is in use - via the mode, or when the same host has
        // been typed into the Custom Pool host field.
        const customHost = (elements.poolHost.value || '').trim().toLowerCase().split(':')[0];
        const usesPowlab = coinKey() === 'BTC' && (isSharedPool || customHost === DEFAULT_POOL_HOST);

        elements.customGroup.style.display = isCustom ? 'block' : 'none';
        // The address field stays active in every mode so the user can set the
        // worker login; on the BTC shared pool it becomes "<address>.browser".
        elements.address.disabled = isCustom;

        if (elements.addressHint) {
            if (isSharedPool) {
                elements.addressHint.style.display = 'block';
                elements.addressHint.textContent =
                    'No account is needed on ' + c.sharedPool + ' - the worker logs in as <' +
                    c.loginHint + '>' + (coinKey() === 'BTC' ? '.browser' : '') +
                    ' and is credited directly to it.' +
                    (c.gpu ? '' : ' ' + c.name + ' is ' + c.algo + ': CPU only.');
            } else if (isMerged) {
                elements.addressHint.style.display = 'block';
                elements.addressHint.textContent =
                    'Merged mining is parented on Litecoin: ' +
                    (c.mergedPool || 'ltc.f2pool.com:8888') + ' puts a Dogecoin block inside the ' +
                    'Litecoin blocks you find, so one scrypt session is credited on both chains and ' +
                    'the pool builds the auxpow. Log in with your LTC address or your pool account ' +
                    'worker (f2pool uses "name.rig1") and set both payout addresses in that account - ' +
                    'the pool pays out, this page only submits shares.';
            } else {
                elements.addressHint.style.display = 'none';
            }
        }
        if (elements.poolDashboard) {
            elements.poolDashboard.style.display = usesPowlab ? 'block' : 'none';
        }

        if (isCustom) {
            elements.address.placeholder = "(unused in Custom Pool mode)";
        } else if (isSharedPool) {
            elements.address.placeholder = c.placeholder + ' (credited automatically)';
        } else {
            elements.address.placeholder = c.placeholder;
        }
    }

    // Reflect the selected coin across the whole form: address label/placeholder,
    // engine list (only Bitcoin has a GPU kernel), mode option text and pool notes.
    // Called once at start-up and on every coin change.
    function applyCoinUI(rebuildDevices) {
        const c = currentCoin();

        if (elements.addressLabel) elements.addressLabel.textContent = c.addressLabel;

        // The shared pool is a different host on every chain, so the mode dropdown
        // text is coin-specific too.
        const labels = MODE_LABELS[coinKey()] || MODE_LABELS[DEFAULT_COIN];
        Array.prototype.forEach.call(elements.mode.options, (opt, i) => {
            if (labels[i]) opt.textContent = labels[i];
        });

        // Merged mining is parented on Litecoin (the LTC pool embeds the DOGE
        // block), so only Litecoin can select it. On the other coins the option
        // stays visible but disabled, with its label saying what to pick
        // instead - and a selection made before the coin change falls back to
        // Solo rather than silently mining something else.
        if (elements.modeMerged) {
            const canMerge = !!c.mergedPool;
            elements.modeMerged.disabled = !canMerge;
            if (!canMerge && elements.mode.value === 'merged') {
                elements.mode.value = 'solo';
            }
        }

        // A new coin starts from a clean slate: the previous chain's job,
        // difficulty and best share are meaningless here.
        currentBits = 0;
        window.currentStratumJob = null;
        window.currentXmrJob = null;
        bestShareDiff = 0;
        poolSubmitFloor = 0;
        elements.bestShare.textContent = '0';
        elements.bestShare.title = '';
        elements.networkDiff.textContent = '...';
        elements.networkDiff.title = '';
        elements.shareDiff.textContent = '...';
        elements.networkBlock.textContent = '...';

        // Scrypt / RandomX are memory-hard: CPU only (see COINS[].gpu).
        if (rebuildDevices) initDevices();

        elements.address.placeholder = c.placeholder;
        logLine('Coin set to ' + c.name + ' (' + c.ticker + ') - proof of work: ' + c.algo +
            (c.gpu ? ', CPU + optional GPU.' : ', CPU only.'), 'info');
        applyModeUI();
    }

    elements.mode.addEventListener('change', applyModeUI);
    elements.poolHost.addEventListener('input', applyModeUI);
    applyModeUI();
    applyCoinUI(false);

    elements.intensity.addEventListener('input', (e) => {
        // Each workgroup scans 64 nonces; show the per-frame nonce count.
        elements.intensityVal.textContent = (parseInt(e.target.value, 10) * 64).toLocaleString();
    });

    elements.device.addEventListener('change', (e) => {
        const v = e.target.value;
        elements.cpuGroup.style.display = (v === 'cpu' || v === 'hybrid') ? 'block' : 'none';
        elements.gpuGroup.style.display = (v === 'gpu' || v === 'hybrid') ? 'block' : 'none';
    });

    // State variables defined at top of function

    // Efficient WebGPU double-SHA256d nonce scanner (WGSL).
    //
    // The first 64 bytes of the 80-byte header are constant for a job, so the CPU
    // precomputes the SHA-256 midstate after that block and each GPU thread only
    // hashes the second header block (which carries the nonce) plus the second
    // SHA-256 application. Threads whose result meets the share target are
    // appended to `found` via an atomic counter.
    const SHADER_CODE = `
      struct Params {
        mid  : array<vec4<u32>, 2>,   // SHA-256 state after header block 1
        tgt  : array<vec4<u32>, 2>,   // share target, most significant word first
        tail : vec4<u32>,             // w0 (merkle tail), ntime, nbits, baseNonce
      };

      @group(0) @binding(0) var<uniform> P : Params;
      @group(0) @binding(1) var<storage, read_write> counter : atomic<u32>;
      @group(0) @binding(2) var<storage, read_write> found : array<u32>;

      const K : array<u32, 64> = array<u32, 64>(
        0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
        0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
        0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
        0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
        0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
        0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
        0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
        0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u, 0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u
      );

      fn rotr(x : u32, n : u32) -> u32 { return (x >> n) | (x << (32u - n)); }

      fn sha256(h_in : array<u32, 8>, w16 : array<u32, 16>) -> array<u32, 8> {
        var w : array<u32, 64>;
        for (var i = 0u; i < 16u; i = i + 1u) { w[i] = w16[i]; }
        for (var i = 16u; i < 64u; i = i + 1u) {
          let x = w[i - 15u];
          let y = w[i - 2u];
          let s0 = rotr(x, 7u) ^ rotr(x, 18u) ^ (x >> 3u);
          let s1 = rotr(y, 17u) ^ rotr(y, 19u) ^ (y >> 10u);
          w[i] = w[i - 16u] + s0 + w[i - 7u] + s1;
        }
        var a = h_in[0]; var b = h_in[1]; var c = h_in[2]; var d = h_in[3];
        var e = h_in[4]; var f = h_in[5]; var g = h_in[6]; var hh = h_in[7];
        for (var i = 0u; i < 64u; i = i + 1u) {
          let S1 = rotr(e, 6u) ^ rotr(e, 11u) ^ rotr(e, 25u);
          let ch = (e & f) ^ (~e & g);
          let t1 = hh + S1 + ch + K[i] + w[i];
          let S0 = rotr(a, 2u) ^ rotr(a, 13u) ^ rotr(a, 22u);
          let maj = (a & b) ^ (a & c) ^ (b & c);
          let t2 = S0 + maj;
          hh = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
        }
        return array<u32, 8>(h_in[0] + a, h_in[1] + b, h_in[2] + c, h_in[3] + d,
                             h_in[4] + e, h_in[5] + f, h_in[6] + g, h_in[7] + hh);
      }

      fn bswap32(x : u32) -> u32 {
        return ((x & 0xffu) << 24u) | ((x & 0xff00u) << 8u) | ((x >> 8u) & 0xff00u) | ((x >> 24u) & 0xffu);
      }

      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) gid : vec3<u32>) {
        let nonce = P.tail.w + gid.x;

        var w2 : array<u32, 16>;
        w2[0] = P.tail.x; w2[1] = P.tail.y; w2[2] = P.tail.z; w2[3] = bswap32(nonce);
        w2[4] = 0x80000000u;
        for (var i = 5u; i < 15u; i = i + 1u) { w2[i] = 0u; }
        w2[15] = 640u;

        let mid = array<u32, 8>(P.mid[0].x, P.mid[0].y, P.mid[0].z, P.mid[0].w,
                                P.mid[1].x, P.mid[1].y, P.mid[1].z, P.mid[1].w);
        let d = sha256(mid, w2);

        var wb : array<u32, 16>;
        for (var i = 0u; i < 8u; i = i + 1u) { wb[i] = d[i]; }
        wb[8] = 0x80000000u;
        for (var i = 9u; i < 15u; i = i + 1u) { wb[i] = 0u; }
        wb[15] = 256u;

        let iv = array<u32, 8>(0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au,
                               0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u);
        let f2 = sha256(iv, wb);

        // displayed hash reverses byte and word order; compare most significant first
        let r = array<u32, 8>(bswap32(f2[7]), bswap32(f2[6]), bswap32(f2[5]), bswap32(f2[4]),
                              bswap32(f2[3]), bswap32(f2[2]), bswap32(f2[1]), bswap32(f2[0]));
        let tg = array<u32, 8>(P.tgt[0].x, P.tgt[0].y, P.tgt[0].z, P.tgt[0].w,
                               P.tgt[1].x, P.tgt[1].y, P.tgt[1].z, P.tgt[1].w);

        var share = true;
        for (var i = 0u; i < 8u; i = i + 1u) {
          if (r[i] < tg[i]) { share = true; break; }
          if (r[i] > tg[i]) { share = false; break; }
        }

        if (share) {
          let slot = atomicAdd(&counter, 1u);
          if (slot < ${GPU_MAX_FOUND}u) { found[slot] = nonce; }
        }
      }
    `;

    // Human-readable difficulty: T/P/E for the large real network values, and
    // plain decimals for the small share difficulties.
    function formatDifficulty(d) {
        if (!isFinite(d)) return 'inf';
        if (d >= 1e18) return (d / 1e18).toFixed(2) + ' E';
        if (d >= 1e15) return (d / 1e15).toFixed(2) + ' P';
        if (d >= 1e12) return (d / 1e12).toFixed(2) + ' T';
        if (d >= 1e9) return (d / 1e9).toFixed(2) + ' G';
        if (d >= 1e6) return (d / 1e6).toFixed(2) + ' M';
        if (d >= 1e3) return (d / 1e3).toFixed(2) + ' k';
        if (d >= 1) return d.toFixed(2);
        return d.toPrecision(3);
    }

    // Hashrate with the unit scaled to the engine: SHA-256 walks millions of nonces
    // per second (kH/s - GH/s), while Scrypt and RandomX are memory-hard and often
    // report only a few hashes per second.
    function formatHashrate(hs) {
        if (!isFinite(hs) || hs <= 0) return '0 H/s';
        if (hs >= 1e9) return (hs / 1e9).toFixed(2) + ' GH/s';
        if (hs >= 1e6) return (hs / 1e6).toFixed(2) + ' MH/s';
        if (hs >= 1e3) return (hs / 1e3).toFixed(2) + ' kH/s';
        if (hs >= 1) return hs.toFixed(2) + ' H/s';
        return hs.toPrecision(3) + ' H/s';
    }

    async function fetchNetworkData() {
        const c = currentCoin();
        // Bitcoin's public mempool.space API is the only chain explorer wired up here
        // (CORS-enabled, no key needed). Every other coin reads its block height from
        // the pool's jobs instead, so its tiles stay pool-driven.
        if (coinKey() !== 'BTC') {
            elements.status.textContent = "Syncing with the " + c.name + " pool...";
            elements.networkDiff.textContent = "Pool";
            elements.networkDiff.title = "The " + c.ticker + " pool sets the difficulty with each job; " +
                "the value it credits is shown as Share Difficulty.";
            elements.networkStatus.textContent = "Pool Mode";
            elements.networkStatus.style.color = "#2196f3";
            return true;
        }

        elements.status.textContent = "Syncing with Bitcoin Mainnet...";
        try {
            // Get latest block list (returns array of 10 recent blocks)
            const response = await fetch('https://mempool.space/api/blocks');
            const data = await response.json();
            const tip = data[0]; // The most recent block
            
            currentBlockHeight = tip.height;
            currentBlockHash = tip.id;
            currentBits = tip.bits;
            
            elements.networkBlock.textContent = `#${tip.height}`;
            
            if (elements.mode.value === 'solo') {
                 // Use difficulty from actual block data (not difficulty-adjustment endpoint)
                 // Tip: tip.difficulty is often the raw difficulty, e.g. 80T.
                 let diffVal = tip.difficulty;
                 
                 try {
                     // Still fetch adjustment for the arrow indicator
                     const diffAdjRes = await fetch('https://mempool.space/api/v1/difficulty-adjustment');
                     const diffAdjData = await diffAdjRes.json();
                     const indicator = diffAdjData.difficultyChange > 0 ? "▲" : "▼";
                     const percent = diffAdjData.difficultyChange ? diffAdjData.difficultyChange.toFixed(2) : "0.00";
                     
                     // Format: 80.50 T ▲
                     elements.networkDiff.textContent = (diffVal / 1e12).toFixed(2) + " T " + indicator;
                     elements.networkDiff.title = `Difficulty: ${diffVal.toLocaleString()}\nNext Adjustment: ${percent > 0 ? '+' : ''}${percent}%`;
                 } catch(err) {
                     // Fallback if adjustment API fails but we have block difficulty
                     elements.networkDiff.textContent = (diffVal / 1e12).toFixed(2) + " T";
                 }
                 
                 elements.networkStatus.textContent = "Synced";
                 elements.networkStatus.style.color = "#4caf50";
                 return true;
            } else {
                 elements.networkDiff.textContent = "Pool";
                 elements.networkStatus.textContent = "Pool Mode";
                 elements.networkStatus.style.color = "#2196f3";
                 return true;
            }
        } catch (e) {
            console.error("Network sync failed", e);
            elements.status.textContent = "Network Sync Failed" + e.message;
            logLine('Network sync failed: ' + e.message, 'error');
            elements.networkBlock.textContent = "Offline";
            return false;
        }
    }

    // Build the bridge WebSocket URL for the selected mode. Custom pools also
    // pass their host/port through the query string for the bridge to dial.
    function buildBridgeUrl() {
        const mode = elements.mode.value;
        let url = BRIDGE_URL + "?coin=" + encodeURIComponent(coinKey()) +
                  "&mode=" + encodeURIComponent(mode);
        if (mode === 'custom') {
            url += "&host=" + encodeURIComponent(elements.poolHost.value.trim());
            url += "&port=" + encodeURIComponent(elements.poolPort.value.trim());
        }
        return url;
    }

    // Stratum login used for both mining.authorize and mining.submit.
    function getAuthParams() {
        if (elements.mode.value === 'custom') {
            return [elements.poolWorker.value.trim(), elements.poolPassword.value || "x"];
        }
        const addr = elements.address.value.trim();
        if (isXmr()) {
            // Monero pools take the wallet address (optionally "address.worker") as
            // the login and ignore the password entirely.
            return [addr, "x"];
        }
        if (elements.mode.value === 'merged') {
            // The merged endpoint is an LTC pool that embeds DOGE blocks: a bare
            // LTC address (verified against ltc.f2pool.com:8888, which answered
            // mining.authorize with true) or a pool account worker both work.
            return [addr, "x"];
        }
        if (elements.mode.value === 'pplns') {
            if (coinKey() === 'BTC') {
                // The default shared pool (btcpowlab) expects the worker login
                // "<btc-address>.browser" and accepts any password.
                return [(addr ? addr + ".browser" : ""), "x"];
            }
            // LTC / DOGE pools (viabtc, zpool.ca) credit the bare address.
            return [addr, "x"];
        }
        return [addr, "web"];
    }

    // Username echoed on share submission (must match the authorized login).
    function getSubmitUser() {
        return getAuthParams()[0];
    }

    // ---- Stratum session resilience ---------------------------------------
    // Reconnect with capped exponential backoff. connectToStratum already logs
    // the specific failure; here we just retry while the user still wants to
    // mine. A successful (re)authorize resets the counter.
    function scheduleReconnect() {
        if (!wantMining || reconnectTimer) return;
        reconnectAttempts++;
        const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(reconnectAttempts - 1, 5)));
        logLine('Reconnecting to the bridge in ' + Math.round(delay / 1000) + 's (attempt ' + reconnectAttempts + ').', 'warn');
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (!wantMining) return;
            connectToStratum().catch(() => {
                if (wantMining) scheduleReconnect();
            });
        }, delay);
    }

    // Lightweight application keepalive: keeps client -> server traffic flowing
    // so an idle proxy cannot silently close a quiet pool session. Bitcoin-style
    // sessions answer "mining.ping" locally in the bridge and never forward it to
    // the pool; Monero sessions send xmrig's own "keepalived", which the pool
    // understands (and which also makes it push a fresh job when it has one).
    function startKeepalive() {
        stopKeepalive();
        keepaliveTimer = setInterval(() => {
            if (stratumConnected && stratumWs && stratumWs.readyState === 1) {
                try {
                    if (isXmr()) {
                        stratumWs.send(JSON.stringify({
                            id: 900, jsonrpc: '2.0', method: 'keepalived',
                            params: { id: window.stratumClientId || '' }
                        }));
                    } else {
                        stratumWs.send(JSON.stringify({ id: 4, method: 'mining.ping', params: [] }));
                    }
                } catch (e) {}
            }
        }, 15000);
    }

    function stopKeepalive() {
        if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
    }

    function connectToStratum() {
        // Monero pools speak xmrig's "login / job / submit" protocol, not Bitcoin's
        // subscribe / authorize / notify dialect. Same bridge, same WebSocket,
        // completely different handshake.
        if (isXmr()) return connectToXmrStratum();

        return new Promise((resolve, reject) => {
            elements.status.textContent = "Connecting to Stratum Bridge...";
            logLine('Opening Stratum bridge ' + BRIDGE_URL + ' (mode: ' + elements.mode.value + ').', 'info');

            // Fresh connection -> forget the previous session's job/difficulty.
            suggestedDifficulty = false;
            poolSubmitFloor = 0;
            poolLatchHighestDifficulty = (elements.mode.value === 'solo');
            window.currentStratumJob = null;
            window.currentPoolDifficulty = null;

            try {
                const ws = new WebSocket(buildBridgeUrl());
                stratumWs = ws;

                // Guard against pools that never answer or reject the worker.
                const connectTimeout = setTimeout(() => {
                    try { ws.close(); } catch (e) {}
                    reject(new Error("Timed out waiting for pool authorization"));
                }, 20000);

                ws.onopen = function () {
                    if (ws !== stratumWs) return;
                    console.log("Stratum Connected");
                    elements.status.textContent = "Bridge Connected. Authenticating...";
                    elements.networkStatus.textContent = "Connecting...";
                    elements.networkStatus.style.color = "#ffb020";
                    logLine('Bridge connected. Subscribing...', 'info');
                    ws.send(JSON.stringify({
                        id: 1,
                        method: "mining.subscribe",
                        params: ["web-miner/1.0"]
                    }));
                };

                ws.onmessage = function (event) {
                    if (ws !== stratumWs) return;
                    let msg;
                    try { msg = JSON.parse(event.data); } catch (e) { return; }

                    // Reply to one of our mining.submit calls: the pool's verdict
                    // on a share we sent (accepted, or rejected/stale).
                    if (msg.id !== undefined && pendingShares.has(msg.id)) {
                        const info = pendingShares.get(msg.id);
                        pendingShares.delete(msg.id);
                        if (msg.result === true) {
                            logLine('Share ACCEPTED by ' + info.pool + ' (nonce ' + info.nonceHex +
                                ', ' + Math.max(0, Date.now() - info.at) + ' ms)', 'ok');
                        } else {
                            const reason = (msg.error && msg.error[1]) ? msg.error[1]
                                : (msg.error ? JSON.stringify(msg.error) : 'rejected');
                            logLine('Share REJECTED by ' + info.pool + ' (nonce ' + info.nonceHex + '): ' + reason, 'error');
                        }
                    }

                    if (msg.id === 1 && !msg.error) {
                        // Subscribed. Save extranonce and Authorize.
                        window.stratumExtranonce1 = msg.result[1];
                        window.stratumExtranonce2Size = msg.result[2];
                        logLine('Subscribed to the bridge (extranonce1 ' + msg.result[1] + ').', 'info');
                        stratumWs.send(JSON.stringify({
                            id: 2,
                            method: "mining.authorize",
                            params: getAuthParams()
                        }));
                    }

                    if (msg.id === 2 && msg.result === true) {
                        clearTimeout(connectTimeout);
                        stratumConnected = true;
                        reconnectAttempts = 0;
                        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
                        elements.status.textContent = "Authorized! Waiting for jobs...";
                        elements.networkStatus.textContent = "Stratum Active";
                        elements.networkStatus.style.color = "#3ddc84";
                        logLine('Authorized as "' + getSubmitUser() + '" - mining to ' + getPoolLabel() + '.', 'ok');
                        startKeepalive();
                        // Ask the pool for the lowest share difficulty. On a vardiff
                        // pool this is best-effort - btcpowlab ignores it and ramps
                        // its own difficulty down instead - but a pool that honours
                        // it starts crediting at difficulty 1 immediately. Solo
                        // (ckpool) is handled after its first set_difficulty so we
                        // only ever ask once we know ckpool's real minimum.
                        if (!poolLatchHighestDifficulty) sendSuggestDifficulty();
                        resolve(true);
                    }

                    if (msg.id === 2 && msg.result === false) {
                        clearTimeout(connectTimeout);
                        reject(new Error("Pool rejected the worker/address"));
                    }

                    if (msg.method === 'mining.notify') {
                        const params = msg.params;
                        const jobId = params[0];
                        elements.networkBlock.textContent = "Job #" + jobId.substring(0, 4);
                        elements.status.textContent = "Mining Job: " + jobId;

                        window.currentStratumJob = {
                            job_id: params[0], prevhash: params[1],
                            coinb1: params[2], coinb2: params[3],
                            merkle_branch: params[4], version: params[5],
                            nbits: params[6], ntime: params[7], clean_jobs: params[8]
                        };

                        // REAL live network difficulty: each job carries the block
                        // template's own nBits, which encodes the target a hash
                        // must reach to actually solve a block. Share difficulty
                        // (below) is a much lower bar and never changes this; the
                        // pool - not this page - broadcasts a block, and only when
                        // a share also meets this network target. The 2^32-hashes-per-
                        // difficulty convention is shared by the BTC and scrypt pools.
                        try {
                            const netBits = parseInt(params[6], 16) >>> 0;
                            currentBits = netBits;
                            const netDiff = SHA256Crypto.nbitsToDifficulty(netBits);
                            elements.networkDiff.textContent = formatDifficulty(netDiff);
                            elements.networkDiff.title = 'Real ' + currentCoin().name + ' network difficulty, read live from this job\'s block header (nBits ' +
                                params[6] + '). Solving a block needs a hash at or below the matching target; the pool broadcasts it, not this page.';
                        } catch (e) {}

                        if (jobId !== lastLoggedJob) {
                            lastLoggedJob = jobId;
                            logLine('New job #' + jobId.substring(0, 8) + ' - live network difficulty ' +
                                formatDifficulty(currentBits ? SHA256Crypto.nbitsToDifficulty(currentBits) : 0) +
                                ' - mining to ' + getPoolLabel() + '.', 'pool');
                        }

                        // CPU: hand every worker a fresh random extranonce2.
                        workers.forEach(w => {
                            w.postMessage({
                                cmd: 'job', job: window.currentStratumJob,
                                extranonce1: window.stratumExtranonce1,
                                en2: randHex(window.stratumExtranonce2Size || 4),
                                extranonce2Size: window.stratumExtranonce2Size || 4
                            });
                        });

                        // GPU: rebuild the midstate/target uniform for a fresh extranonce2.
                        if (gpu) {
                            gpu.en2 = randHex(window.stratumExtranonce2Size || 4);
                            gpu.baseNonce = (Math.random() * 0xffffffff) >>> 0;
                            prepareGpuContext();
                        }
                    }

                    if (msg.method === 'mining.set_difficulty') {
                         const d = msg.params[0];
                         // The pool's advertised share difficulty. For a vardiff
                         // pool (btcpowlab, custom) that IS the live accept bar and
                         // it moves up and down, so track it exactly - a latched
                         // maximum would stop us submitting once vardiff lowers it.
                         // ckpool solo never lowers what it will *accept*: its low
                         // value is only the mining.suggest_difficulty echo, so latch
                         // the highest value it advertises (its real minimum).
                         window.currentPoolDifficulty = d;
                         if (poolLatchHighestDifficulty) {
                             if (d > poolSubmitFloor) poolSubmitFloor = d;
                         } else {
                             poolSubmitFloor = d;
                         }
                         logLine('Pool set share difficulty to ' + d + '.' +
                             (poolSubmitFloor > d ? ' Minimum accepted is ' + poolSubmitFloor + '.' : ''), 'info');
                         elements.shareDiff.textContent = formatDifficulty(poolSubmitFloor) + ' min';
                         elements.shareDiff.title = 'Minimum share difficulty the pool will accept. A found hash must reach this target; the pool rejects anything lower as "Above target", so the miner does not send it.';
                         // Engines always search at difficulty 1 (see
                         // SEARCH_DIFFICULTY); the submit floor above is what
                         // actually gates submissions, so a harder advertised
                         // difficulty never slows the search down.
                         broadcastToWorkers({ cmd: 'difficulty', difficulty: SEARCH_DIFFICULTY });
                         if (gpu) prepareGpuContext();
                         // Solo only: now that we have seen ckpool's own minimum,
                         // ask for the lowest *search* difficulty so a browser (a few
                         // MH/s at best) still finds candidate shares to display.
                         // Those candidates are never submitted unless they clear the
                         // latched floor, so this cannot cause "Above target" rejects.
                         if (poolLatchHighestDifficulty && !suggestedDifficulty) {
                             sendSuggestDifficulty();
                         }
                    }
                };

                ws.onerror = function (e) {
                    if (ws !== stratumWs) return;
                    console.error("Stratum WS Error", e);
                    logLine('Bridge WebSocket error.', 'error');
                    reject(e);
                };

                // A dropped bridge must not silently stop mining or freeze the UI:
                // keep the local engines running, show the real network state, and
                // auto-reconnect while the user still wants to mine.
                ws.onclose = function (event) {
                    if (ws !== stratumWs) return;
                    clearTimeout(connectTimeout);
                    stratumConnected = false;
                    stopKeepalive();
                    const code = event && event.code;
                    const reason = event && event.reason;
                    console.log("Stratum Closed", code, reason);
                    logLine('Bridge connection closed' +
                        (code ? ' (code ' + code + (reason ? ': ' + reason : '') + ')' : '') + '.', 'warn');
                    if (wantMining) {
                        elements.networkStatus.textContent = "Reconnecting...";
                        elements.networkStatus.style.color = "#ffb020";
                        elements.status.textContent = "Bridge disconnected - reconnecting...";
                        scheduleReconnect();
                    } else {
                        elements.networkStatus.textContent = "Only Local";
                        elements.networkStatus.style.color = "#aaa";
                    }
                };

            } catch(e) {
                reject(e);
            }
        });
    }

    // ---- XMR stratum client (xmrig wire protocol) -------------------------
    // Monero pools use xmrig's dialect, which the generic bridge relays verbatim:
    //
    //   -> {"id":1,"jsonrpc":"2.0","method":"login","params":{login,pass,agent,algo}}
    //   <- {"id":1,"jsonrpc":"2.0","error":null,"result":{id,job:{...},status:"OK"}}
    //   <- {"jsonrpc":"2.0","method":"job","params":{...}}
    //   -> {"id":N,"jsonrpc":"2.0","method":"submit",
    //       "params":{id:<pool client id>,job_id,nonce,result}}
    //   <- {"id":N,"jsonrpc":"2.0","error":null,"result":{"status":"OK"}}
    //
    // The pool's own client id (result.id of the login) has to be echoed on every
    // submit, and there is no extranonce1/2 and no set_difficulty: the job carries
    // the block hashing blob (with the nonce reserved inside it) and its own target.
    //
    // xmrig errors are objects ({"code":-1,"message":"..."}) where Bitcoin's pools
    // send arrays, so both shapes are normalized here.
    function xmrErrorText(err) {
        if (!err) return 'unknown error';
        if (typeof err === 'string') return err;
        if (err.message) return err.message + (err.code !== undefined ? ' (code ' + err.code + ')' : '');
        if (Array.isArray(err)) return err.length > 1 ? String(err[1]) : JSON.stringify(err);
        return JSON.stringify(err);
    }

    // Hand a pool job to the RandomX workers and refresh the tiles. The job is
    // normalized (randomx.js) so the worker gets exactly what it needs: the blob,
    // its 64-bit target, the height and the epoch seed hash.
    function acceptXmrJob(params) {
        if (!params) return;
        if (!window.XmrCrypto) {
            logLine('randomx.js is not loaded on this page - cannot use Monero jobs.', 'error');
            return;
        }
        const job = window.XmrCrypto.normalizeJob(params);
        if (!job) {
            logLine('The pool sent a job without a usable blob/target - ignoring it.', 'warn');
            return;
        }
        window.currentXmrJob = job;

        const jobId = job.job_id;
        elements.networkBlock.textContent = job.height ? ('Block #' + job.height) : ('Job ' + jobId.substring(0, 6));
        elements.status.textContent = 'Mining Job: ' + jobId;

        // A Monero job sets its own target (no separate set_difficulty), so the job's
        // difficulty IS the accept bar for the next share - the worker only reports
        // hashes below that target.
        poolSubmitFloor = job.difficulty;
        elements.shareDiff.textContent = formatDifficulty(job.difficulty) + ' min';
        elements.shareDiff.title = 'Difficulty carried by this Monero job\'s target: the worker looks for hashes whose 64-bit value is below it.';
        elements.networkDiff.textContent = formatDifficulty(job.difficulty);
        elements.networkDiff.title = 'Difficulty set by this job\'s target. Soloing a block needs a hash at or below the same target; the pool broadcasts the block, not this page.';

        if (jobId !== lastLoggedJob) {
            lastLoggedJob = jobId;
            logLine('New XMR job ' + jobId + (job.height ? ' (height ' + job.height + ')' : '') +
                ' - share difficulty ' + formatDifficulty(job.difficulty) + '.', 'info');
        }

        broadcastToWorkers({ cmd: 'job', job: job });
    }


    function connectToXmrStratum() {
        return new Promise((resolve, reject) => {
            elements.status.textContent = "Connecting to the Monero pool...";
            logLine('Opening Stratum bridge ' + BRIDGE_URL + ' (coin: XMR, mode: ' + elements.mode.value + ').', 'info');

            // Fresh connection -> forget the previous session's client id and job.
            suggestedDifficulty = false;
            poolSubmitFloor = 0;
            poolLatchHighestDifficulty = false;
            window.currentXmrJob = null;
            window.stratumClientId = null;

            try {
                const ws = new WebSocket(buildBridgeUrl());
                stratumWs = ws;

                // Guard against pools that never answer the login.
                const connectTimeout = setTimeout(() => {
                    try { ws.close(); } catch (e) {}
                    reject(new Error("Timed out waiting for the Monero pool login"));
                }, 20000);

                ws.onopen = function () {
                    if (ws !== stratumWs) return;
                    console.log("Stratum Connected (XMR)");
                    elements.status.textContent = "Bridge Connected. Logging in...";
                    elements.networkStatus.textContent = "Connecting...";
                    elements.networkStatus.style.color = "#ffb020";
                    logLine('Bridge connected. Logging in with the XMR address...', 'info');
                    const auth = getAuthParams();
                    // The wallet address is the login (optionally "address.worker"),
                    // the password is up to the pool, and "algo" pins the RandomX
                    // variant this miner's WASM VM implements (rx/0 = Monero mainnet).
                    ws.send(JSON.stringify({
                        id: 1,
                        jsonrpc: "2.0",
                        method: "login",
                        params: {
                            login: auth[0],
                            pass: auth[1],
                            agent: "web-miner/1.0",
                            algo: ["rx/0"]
                        }
                    }));
                };

                ws.onmessage = function (event) {
                    if (ws !== stratumWs) return;
                    let msg;
                    try { msg = JSON.parse(event.data); } catch (e) { return; }

                    // Reply to one of our mining.submit calls. xmrig reads "no error
                    // object" as accepted, so that is the check here too.
                    if (msg.id !== undefined && pendingShares.has(msg.id)) {
                        const info = pendingShares.get(msg.id);
                        pendingShares.delete(msg.id);
                        if (!msg.error) {
                            logLine('Share ACCEPTED by ' + info.pool + ' (nonce ' + info.nonceHex +
                                ', ' + Math.max(0, Date.now() - info.at) + ' ms)', 'ok');
                        } else {
                            logLine('Share REJECTED by ' + info.pool + ' (nonce ' + info.nonceHex +
                                '): ' + xmrErrorText(msg.error), 'error');
                        }
                        return;
                    }

                    // Pool-pushed job (new block, or the answer to a keepalived).
                    if (msg.method === 'job') {
                        acceptXmrJob(msg.params);
                        return;
                    }

                    // Login reply: result.id is the client id every submit must echo.
                    if (msg.id === 1) {
                        clearTimeout(connectTimeout);
                        if (msg.error) {
                            const reason = xmrErrorText(msg.error);
                            logLine('Monero pool rejected the login: ' + reason, 'error');
                            reject(new Error(reason));
                            return;
                        }
                        const result = msg.result || {};
                        stratumConnected = true;
                        reconnectAttempts = 0;
                        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
                        window.stratumClientId = result.id !== undefined ? result.id : null;
                        elements.status.textContent = "Logged in. Waiting for jobs...";
                        elements.networkStatus.textContent = "Stratum Active";
                        elements.networkStatus.style.color = "#3ddc84";
                        logLine('Logged in as "' + getSubmitUser() + '" - mining to ' + getPoolLabel() +
                            (window.stratumClientId !== null ? ' (client id ' + window.stratumClientId + ')' : '') + '.', 'ok');
                        // The login reply normally carries the first job already.
                        if (result.job) acceptXmrJob(result.job);
                        startKeepalive();
                        resolve(true);
                    }
                };

                ws.onerror = function (e) {
                    if (ws !== stratumWs) return;
                    console.error("Stratum WS Error", e);
                    logLine('Bridge WebSocket error.', 'error');
                    reject(e);
                };

                // Same reconnect policy as the Bitcoin path: a dropped bridge must not
                // silently stop mining or freeze the UI.
                ws.onclose = function (event) {
                    if (ws !== stratumWs) return;
                    clearTimeout(connectTimeout);
                    stratumConnected = false;
                    stopKeepalive();
                    const code = event && event.code;
                    const reason = event && event.reason;
                    console.log("Stratum Closed", code, reason);
                    logLine('Bridge connection closed' +
                        (code ? ' (code ' + code + (reason ? ': ' + reason : '') + ')' : '') + '.', 'warn');
                    if (wantMining) {
                        elements.networkStatus.textContent = "Reconnecting...";
                        elements.networkStatus.style.color = "#ffb020";
                        elements.status.textContent = "Bridge disconnected - reconnecting...";
                        scheduleReconnect();
                    } else {
                        elements.networkStatus.textContent = "Only Local";
                        elements.networkStatus.style.color = "#aaa";
                    }
                };

            } catch (e) {
                reject(e);
            }
        });
    }


    async function initDevices() {
      elements.device.innerHTML = '';

      const c = currentCoin();
      const cpuCount = navigator.hardwareConcurrency || 4;
      elements.threads.value = Math.max(1, Math.floor(cpuCount / 2));
      elements.threads.max = cpuCount;

      const cpuOpt = document.createElement('option');
      cpuOpt.value = 'cpu';
      cpuOpt.textContent = `CPU - ${cpuCount} thread(s), JavaScript ${c.algo}`;
      cpuOpt.selected = true;
      elements.device.appendChild(cpuOpt);

      // Only Bitcoin ships a WebGPU kernel (COINS[].gpu): Scrypt and RandomX are
      // memory-hard and run in CPU workers only, so those coins get no GPU entry.
      if (!c.gpu) {
          elements.cpuGroup.style.display = 'block';
          elements.gpuGroup.style.display = 'none';
          elements.status.textContent = "Ready.";
          return;
      }

      if (navigator.gpu) {
        try {
            // Need to request adapter to see if it works, but we can't iterate ALL adapters easily in WebGPU yet.
            // Standard WebGPU only gives one adapter at a time based on preference (Low power / High perf).
            // We will just try to get a High Performance one.
          adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
          if (adapter) {
            let infoString = "GPU Device 0"; // Default name
            // Try to get info if available (some browsers hide it for privacy)
            if (adapter.info) {
               // If vendor/device is empty string, keep default
               const v = adapter.info.vendor || "";
               const d = adapter.info.device || "";
               if (v || d) {
                   infoString = `${v} ${d}`.trim();
               }
            } 

            const gpuOpt = document.createElement('option');
            gpuOpt.value = 'gpu';
            gpuOpt.textContent = `GPU - WebGPU ${c.algo} (${infoString})`;
            elements.device.appendChild(gpuOpt);

            const hybridOpt = document.createElement('option');
            hybridOpt.value = 'hybrid';
            hybridOpt.textContent = `CPU + GPU - combined (WebGPU + ${cpuCount} threads)`;
            elements.device.appendChild(hybridOpt);
          }
        } catch (e) {
          console.warn("WebGPU initialization failed:", e);
        }
      }
      elements.status.textContent = "Ready.";
    }

    // ---- CPU mining workers ----------------------------------------------
    // One worker file per coin family: miner-worker.js (double SHA-256, BTC),
    // scrypt-worker.js (LTC/DOGE) and xmr-worker.js (RandomX, XMR). All three speak
    // the same start/stop/job/difficulty protocol and answer with the same
    // { hashes } / { best } / { share } messages, so only the URL changes here.
    function makeWorker() {
        const w = new Worker(currentCoin().worker);
        w.onmessage = (e) => {
            const d = e.data || {};
            // xmr-worker.js only: RandomX WASM lifecycle (see handleVmState).
            if (d.vm) { handleVmState(d); return; }
            if (d.jobError) { logLine('Worker rejected a job: ' + d.jobError, 'error'); return; }
            if (d.hashes) totalHashes += d.hashes;
            // Rarest hash this worker has found so far (sub-target hashes too) ->
            // drives the "Best Share" tile. It is not submitted unless it also
            // clears the pool's advertised difficulty (see offerShare).
            if (d.best) updateBestShare(d.best.difficulty);
            if (d.share) handleShareMessage(d);
        };
        w.onerror = (err) => {
            console.error('Mining worker error', err);
            logLine('Mining worker error: ' + (err && err.message ? err.message : err), 'error');
        };
        return w;
    }

    // A share message differs per coin family: the Bitcoin and scrypt workers report
    // an extranonce2 + ntime (the page assembles their blobs from the Merkle tree),
    // while the RandomX worker reports only the nonce and the raw digest because the
    // pool's block hashing blob already contains everything else.
    function handleShareMessage(d) {
        if (isXmr()) offerXmrShare(d);
        else offerShare(d.job_id, d.en2, d.ntime, d.nonce, d.difficulty);
    }

    // xmr-worker.js reports the RandomX WASM lifecycle. Monero cannot be mined
    // without the real VM (randomx.js refuses to hash without it), so the page must
    // say so instead of silently hashing nothing.
    function handleVmState(d) {
        if (d.vm === 'loading') {
            elements.status.textContent = 'Loading the RandomX WebAssembly VM...';
            logLine('Loading randomx.wasm - the RandomX VM this CPU will hash with...', 'info');
        } else if (d.vm === 'ready') {
            logLine('RandomX VM ready' + (d.version ? ' (' + d.version + ')' : '') + ' - hashing now.', 'ok');
            elements.status.textContent = 'Mining with RandomX...';
        } else if (d.vm === 'unavailable') {
            logLine('RandomX WebAssembly is unavailable: ' + d.error +
                ' - Monero mining cannot run. Build WebRandomX/randomx.wasm (see crypto-frontend/README.md).', 'error');
            elements.status.textContent = 'RandomX WASM missing - Monero mining unavailable.';
        }
    }

    // Format `bytes` random bytes as hex (used for extranonce2). The argument is a
    // BYTE count: it returns bytes*2 hex characters. Callers pass the pool's
    // advertised extranonce2 size in bytes (4 on btcpowlab, 8 on solo ckpool) and
    // must NOT pre-multiply by 2 - the pool rejects a wrong-length extranonce2.
    function randHex(bytes) {
        let s = '';
        for (let i = 0; i < bytes * 2; i++) s += Math.floor(Math.random() * 16).toString(16);
        return s;
    }

    // Update the "best share" tile when a rarer hash is found (submitted or not).
    // Shares are compared against the chain's block target, which this page only
    // knows for Bitcoin (currentBits comes from mempool.space); for Scrypt and
    // RandomX the tile just reports the difficulty the worker computed.
    function updateBestShare(shareDiff) {
        if (!(typeof shareDiff === 'number' && isFinite(shareDiff)) || shareDiff <= bestShareDiff) return false;
        bestShareDiff = shareDiff;
        elements.bestShare.textContent = formatDifficulty(shareDiff);
        const netDiff = (coinKey() === 'BTC' && currentBits) ? SHA256Crypto.nbitsToDifficulty(currentBits) : 0;
        if (netDiff > 0) {
            elements.bestShare.title = 'Rarest hash found so far, as a difficulty. Solving a block needs ' +
                formatDifficulty(netDiff) + '; this best share is ' +
                (shareDiff / netDiff).toExponential(3) + ' of the way there.';
        } else {
            elements.bestShare.title = 'Rarest hash found so far, as a difficulty, on the same scale as the ' +
                'share difficulty this ' + currentCoin().ticker + ' pool advertises.';
        }
        return true;
    }

    // A hash met the search target. Submit it only if it also clears the pool's
    // minimum share difficulty; the pool rejects anything lower as "Above target"
    // (which is what produced a wall of rejections when we gated too low), so below
    // that bar we just track it as our best local share and send nothing.
    function offerShare(jobId, en2, ntime, nonceHex, shareDiff) {
        // Workers report rarity on Bitcoin's difficulty scale; scrypt pools count
        // difficulty in units 65536x smaller, so convert before comparing to the
        // pool's advertised (pool-scale) difficulty.
        const poolScaleDiff = (typeof shareDiff === 'number' && currentCoin().algo === 'Scrypt') ? shareDiff * 65536 : shareDiff;
        if (poolSubmitFloor > 0 && typeof poolScaleDiff === 'number' && isFinite(poolScaleDiff) && poolScaleDiff < poolSubmitFloor) {
            if (updateBestShare(shareDiff)) {
                logLine('Best local share so far: difficulty ' + formatDifficulty(shareDiff) + ' (nonce ' + nonceHex +
                    ') - below ' + getPoolLabel() + "'s " + formatDifficulty(poolSubmitFloor) +
                    ' minimum, so not submitted to the pool.', 'pool');
            }
            return;
        }
        submitShare(jobId, en2, ntime, nonceHex, shareDiff);
    }

    // Submit a share found by any engine (already verified on the obvious path).
    // Each submission gets a unique Stratum id so the pool's reply can be matched
    // back to the exact share; the on-message handler then logs accept / reject.
    function submitShare(jobId, en2, ntime, nonceHex, shareDiff) {
        if (!stratumWs || stratumWs.readyState !== 1) {
            logLine('Found a share but the bridge is not connected - dropping it.', 'warn');
            return;
        }
        const pool = getPoolLabel();
        const id = 1000 + (++shareSeq);
        pendingShares.set(id, { pool: pool, nonceHex: nonceHex, at: Date.now() });
        stratumWs.send(JSON.stringify({
            id: id, method: 'mining.submit',
            params: [getSubmitUser(), jobId, en2, ntime, nonceHex]
        }));
        sharesFound++;
        updateBestShare(shareDiff);
        elements.status.textContent = 'Share found & submitted to ' + pool + ' (total ' + sharesFound + ')';
        logLine('Share found: nonce ' + nonceHex + ' at difficulty ' + formatDifficulty(shareDiff || 0) +
            ' -> submitted to ' + pool + ' (total ' + sharesFound + ')', 'pool');
    }

    function broadcastToWorkers(msg) {
        workers.forEach((w) => { try { w.postMessage(msg); } catch (e) {} });
    }

    // Monero shares go out as xmrig's mining.submit: the pool's own client id (given
    // at login), the job id, our 4 nonce bytes and the raw RandomX digest - there is
    // no extranonce2 / ntime, they are already inside the pool's blob.
    function offerXmrShare(d) {
        if (!stratumWs || stratumWs.readyState !== 1) {
            logLine('Found a share but the bridge is not connected - dropping it.', 'warn');
            return;
        }
        if (window.stratumClientId === null || window.stratumClientId === undefined) {
            logLine('Found a share before the pool gave us a client id - dropping it.', 'warn');
            return;
        }
        const pool = getPoolLabel();
        const id = 1000 + (++shareSeq);
        pendingShares.set(id, { pool: pool, nonceHex: d.nonce, at: Date.now() });
        try {
            stratumWs.send(JSON.stringify({
                id: id, jsonrpc: '2.0', method: 'submit',
                params: {
                    id: window.stratumClientId,
                    job_id: d.job_id,
                    nonce: d.nonce,
                    result: d.result
                }
            }));
        } catch (e) {
            pendingShares.delete(id);
            logLine('Could not send the share: ' + (e && e.message ? e.message : e), 'error');
            return;
        }
        sharesFound++;
        updateBestShare(d.difficulty);
        elements.status.textContent = 'Share found & submitted to ' + pool + ' (total ' + sharesFound + ')';
        logLine('Share found: nonce ' + d.nonce + ' at difficulty ' + formatDifficulty(d.difficulty || 0) +
            ' -> submitted to ' + pool + ' (total ' + sharesFound + ')', 'pool');
    }

    // Ask the pool for the lowest (difficulty 1) share difficulty, once per
    // connection. Harmless if the pool ignores it - what we submit is still gated
    // by poolSubmitFloor.
    function sendSuggestDifficulty() {
        if (suggestedDifficulty || !stratumWs || stratumWs.readyState !== 1) return;
        suggestedDifficulty = true;
        try {
            stratumWs.send(JSON.stringify({ id: 3, method: "mining.suggest_difficulty", params: [SEARCH_DIFFICULTY] }));
        } catch (e) {}
    }

    function startCpuMining() {
        // clear old workers
        workers.forEach(w => w.terminate());
        workers = [];

        const threadCount = Math.max(1, parseInt(elements.threads.value, 10) || 1);
        for (let i = 0; i < threadCount; i++) {
            const w = makeWorker();
            if (isXmr()) {
                // RandomX workers mine the pool's blob directly: no extranonce1/2 and no
                // ntime to assemble, so the job goes over as-is (the target travels with
                // it as well, which is why no difficulty message is needed either).
                if (window.currentXmrJob) w.postMessage({ cmd: 'job', job: window.currentXmrJob });
            } else {
                if (window.currentStratumJob) {
                    w.postMessage({
                        cmd: 'job', job: window.currentStratumJob,
                        extranonce1: window.stratumExtranonce1,
                        en2: randHex(window.stratumExtranonce2Size || 4),
                        extranonce2Size: window.stratumExtranonce2Size || 4
                    });
                }
                // Every worker searches at difficulty 1 (see SEARCH_DIFFICULTY).
                w.postMessage({ cmd: 'difficulty', difficulty: SEARCH_DIFFICULTY });
            }
            w.postMessage({ cmd: 'start' });
            workers.push(w);
        }
    }

    // Single UI refresh loop shared by every engine.
    function startUiLoop() {
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        const tick = () => {
            if (!isMining) return;
            updateStats();
            animationFrameId = requestAnimationFrame(tick);
        };
        tick();
    }

    // ---- WebGPU SHA-256d miner -------------------------------------------
    let gpu = null;

    async function setupGpuCompute() {
        if (!adapter) throw new Error('No GPU adapter available');
        if (gpu) return gpu;
        device = await adapter.requestDevice();
        if (!device) throw new Error('GPU device creation returned null');

        const uniform = device.createBuffer({ size: 80, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
        const count = device.createBuffer({ size: 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST });
        const nonces = device.createBuffer({ size: GPU_MAX_FOUND * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const read = device.createBuffer({ size: 4 + GPU_MAX_FOUND * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

        const shaderModule = device.createShaderModule({ code: SHADER_CODE });
        pipeline = device.createComputePipeline({ layout: 'auto', compute: { module: shaderModule, entryPoint: 'main' } });
        bindGroup = device.createBindGroup({
            layout: pipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: { buffer: uniform } },
                { binding: 1, resource: { buffer: count } },
                { binding: 2, resource: { buffer: nonces } }
            ]
        });

        gpu = { uniform: uniform, count: count, nonces: nonces, read: read, ctx: null, en2: '00000000', baseNonce: 0, running: false };
        return gpu;
    }

    // Rebuild the midstate/target uniform for the current job + extranonce2.
    function prepareGpuContext() {
        if (!gpu || !window.currentStratumJob) return false;
        const ctx = SHA256Crypto.buildJobContext(
            window.currentStratumJob, window.stratumExtranonce1 || '', gpu.en2,
            SEARCH_DIFFICULTY);
        gpu.ctx = ctx;
        device.queue.writeBuffer(gpu.uniform, 0, ctx.midstate);   // midstate -> bytes 0..31
        device.queue.writeBuffer(gpu.uniform, 32, ctx.target);    // target   -> bytes 32..63
        return true;
    }

    async function startGpuMining() {
        await setupGpuCompute();
        gpu.en2 = randHex(window.stratumExtranonce2Size || 4);
        gpu.baseNonce = (Math.random() * 0xffffffff) >>> 0;
        prepareGpuContext();
        if (!gpu.running) runGpuLoop();
    }

    // Continuous GPU search. Each pass dispatches one batch and awaits its
    // readback, then immediately starts the next - it is NOT tied to
    // requestAnimationFrame (which capped the GPU at ~60 batches/s and paused
    // entirely in background tabs). Every batch snapshots the job, extranonce2
    // and context it was hashed against, so a share found while a new job
    // arrives is still verified and submitted against the job it belongs to.
    async function runGpuLoop() {
        if (!gpu || gpu.running) return;
        gpu.running = true;
        try {
            while (isMining && gpu) {
                if (!gpu.ctx || !window.currentStratumJob) {
                    await new Promise(r => setTimeout(r, 200));
                    continue;
                }
                const wg = Math.max(1, Math.min(65535, parseInt(elements.intensity.value, 10) || 16384));
                const span = wg * 64;

                // Roll extranonce2 (and rebuild the midstate) when the 32-bit
                // nonce space is exhausted.
                if (gpu.baseNonce > 0xffffffff - span) {
                    gpu.baseNonce = (Math.random() * 0xffffffff) >>> 0;
                    gpu.en2 = randHex(window.stratumExtranonce2Size || 4);
                    prepareGpuContext();
                }

                const snap = { ctx: gpu.ctx, en2: gpu.en2, job: window.currentStratumJob };
                device.queue.writeBuffer(gpu.uniform, 0, snap.ctx.midstate);
                device.queue.writeBuffer(gpu.uniform, 32, snap.ctx.target);
                device.queue.writeBuffer(gpu.uniform, 64, new Uint32Array([snap.ctx.w0, snap.ctx.ntime, snap.ctx.nbits, gpu.baseNonce >>> 0]));
                device.queue.writeBuffer(gpu.count, 0, new Uint32Array([0]));

                const enc = device.createCommandEncoder();
                const pass = enc.beginComputePass();
                pass.setPipeline(pipeline);
                pass.setBindGroup(0, bindGroup);
                pass.dispatchWorkgroups(wg);
                pass.end();
                enc.copyBufferToBuffer(gpu.count, 0, gpu.read, 0, 4);
                enc.copyBufferToBuffer(gpu.nonces, 0, gpu.read, 4, GPU_MAX_FOUND * 4);
                device.queue.submit([enc.finish()]);
                gpu.baseNonce = (gpu.baseNonce + span) >>> 0;

                await gpu.read.mapAsync(GPUMapMode.READ);
                const results = new Uint32Array(gpu.read.getMappedRange().slice(0));
                gpu.read.unmap();
                totalHashes += span;

                const n = Math.min(results[0], GPU_MAX_FOUND);
                for (let i = 0; i < n; i++) {
                    const nonce = results[1 + i];
                    // Re-verify on the CPU path (against the batch's own job) before submitting.
                    if (SHA256Crypto.nonceIsValid(snap.ctx, nonce)) {
                        const shareDiff = SHA256Crypto.hashDifficulty(SHA256Crypto.hashNonce(snap.ctx, nonce));
                        offerShare(snap.job.job_id, snap.en2, snap.job.ntime,
                            (nonce >>> 0).toString(16).padStart(8, '0'), shareDiff);
                    }
                }
            }
        } catch (e) {
            console.error('GPU loop error', e);
            elements.status.textContent = 'GPU error: ' + e.message;
            logLine('GPU engine stopped: ' + e.message, 'error');
        } finally {
            if (gpu) gpu.running = false;
        }
    }

    // Legacy single thread loop removed, replaced by Web Workers

    function updateStats() {
      const now = Date.now();
      const diff = (now - startTime) / 1000;
      
      const pad = (n) => n.toString().padStart(2, "0");
      const h = Math.floor(diff / 3600);
      const m = Math.floor((diff % 3600) / 60);
      const s = Math.floor(diff % 60);
      elements.runtime.textContent = `${pad(h)}:${pad(m)}:${pad(s)}`;

      const hs = totalHashes / (diff || 1);
      elements.hashrate.textContent = formatHashrate(hs);
      elements.totalHashesDisplay.textContent = totalHashes.toLocaleString();
    }

    elements.startBtn.addEventListener("click", async () => {
      const mode = elements.mode.value;
      const coin = coinKey();
      const c = COINS[coin];
      const addr = elements.address.value.trim();

      // Validate the inputs required by the selected mode. Every coin checks its own
      // wallet format, so an address for the wrong chain can never be submitted.
      if (mode === 'solo' || mode === 'pplns') {
          if (!addr) {
            elements.status.textContent = "Error: " + c.ticker + " wallet address required for " + (mode === 'solo' ? "Solo" : "the shared pool") + " mining";
            logLine('Enter a ' + c.ticker + ' wallet address to start ' + (mode === 'solo' ? 'Solo' : 'shared-pool') + ' mining.', 'error');
            elements.address.focus();
            return;
          }

          if (!c.pattern.test(addr)) {
              elements.status.textContent = "Error: " + c.invalid;
              logLine(c.invalid, 'error');
              elements.address.focus();
              return;
          }
      } else if (mode === 'merged') {
          // Log in with an LTC address (the parent chain) or a pool account
          // worker; the merged pool accepts either and pays both chains.
          if (!/^[A-Za-z0-9_.-]{3,64}$/.test(addr)) {
            elements.status.textContent = "Error: Merged mode logs in with your LTC address or pool account worker";
            logLine('Enter the LTC address (or a pool account worker such as "name.rig1") the merged pool should credit.', 'error');
            elements.address.focus();
            return;
          }
      } else if (mode === 'custom') {
          const poolHostVal = elements.poolHost.value.trim();
          const poolPortVal = parseInt(elements.poolPort.value.trim(), 10);
          const poolWorkerVal = elements.poolWorker.value.trim();
          if (!poolHostVal || !Number.isInteger(poolPortVal) || !poolWorkerVal) {
              elements.status.textContent = "Error: Custom Pool requires host, port and a worker/username";
              logLine('Custom Pool requires a host, port and worker/username.', 'error');
              elements.poolHost.focus();
              return;
          }
      }

      // Connect to the pool through the bridge - every mode does real stratum work.
      if (BRIDGE_URL.includes("SERVICE_URL_HERE")) {
           console.warn("Bridge URL not set. Using API data for stats only.");
           const synced = await fetchNetworkData();
           if (!synced) {
               elements.status.textContent = "Error: Network sync failed";
               return;
           }
      } else {
           try {
               await connectToStratum();
           } catch(e) {
               elements.status.textContent = "Bridge Connection Failed. Check Console.";
               return;
           }
      }
      
      // Scrypt and RandomX are memory-hard and CPU only, so force the CPU engine even
      // if the dropdown still shows a GPU option.
      let deviceMode = elements.device.value;
      if (!c.gpu && deviceMode !== 'cpu') {
          deviceMode = 'cpu';
          elements.device.value = 'cpu';
          logLine(c.name + ' has no GPU kernel here - using the CPU engine.', 'warn');
      }

      // Make sure a GPU engine has an adapter before we commit to mining.
      if ((deviceMode === 'gpu' || deviceMode === 'hybrid') && !adapter) {
          if (navigator.gpu) await initDevices(); // re-detect the adapter
          if (!adapter) {
              elements.status.textContent = "Error: WebGPU is not available in this browser.";
              return;
          }
      }

      try {
        wantMining = true;
        reconnectAttempts = 0;
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        isMining = true;
        setAmbient(false);
        startTime = Date.now();
        totalHashes = 0;
        sharesFound = 0;
        bestShareDiff = 0;
        lastLoggedJob = null;
        pendingShares.clear();
        elements.bestShare.textContent = '0';
        elements.bestShare.title = '';
        elements.startBtn.disabled = true;
        elements.stopBtn.disabled = false;
        elements.address.disabled = true;
        elements.device.disabled = true;
        elements.status.style.color = "#00ff66";

        startUiLoop();
        if (deviceMode === 'cpu' || deviceMode === 'hybrid') startCpuMining();
        if (deviceMode === 'gpu' || deviceMode === 'hybrid') await startGpuMining();
        const sessionLabel = mode === 'merged' ? 'LTC + DOGE (merged)' : c.ticker;
        elements.status.textContent = "Mining " + sessionLabel + " (" + deviceMode.toUpperCase() + ")...";
        logLine('Mining ' + sessionLabel + ' started - engine: ' + deviceMode.toUpperCase() +
            ' (' + c.algo + ').', 'ok');
      } catch (e) {
        console.error(e);
        elements.status.textContent = "Mining failed: " + e.message;
        logLine('Mining failed: ' + e.message, 'error');
        isMining = false;
        setAmbient(true);
        cancelAnimationFrame(animationFrameId);
        workers.forEach(w => w.terminate());
        workers = [];
        elements.startBtn.disabled = false;
        elements.stopBtn.disabled = true;
      }
    });

    elements.stopBtn.addEventListener("click", () => {
      isMining = false;
      setAmbient(true);
      wantMining = false;
      stratumConnected = false;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      stopKeepalive();
      cancelAnimationFrame(animationFrameId);
      /* the GPU loop exits on its own once isMining is false */

      // Stop Workers
      workers.forEach(w => w.terminate());
      workers = [];

      // Drop the stratum connection so the next start reconnects cleanly.
      if (stratumWs) { try { stratumWs.close(); } catch (e) {} stratumWs = null; }
      elements.networkStatus.textContent = "Only Local";
      elements.networkStatus.style.color = "#aaa";

      elements.startBtn.disabled = false;
      elements.stopBtn.disabled = true;
      elements.address.disabled = (elements.mode.value === 'custom');
      elements.device.disabled = false;
      logLine('Mining stopped by user.', 'info');
      elements.status.textContent = "Mining stopped";
      elements.status.style.color = "inherit";
    });

    logLine('Miner ready. Pick a coin, enter its wallet address and press Start Mining.', 'info');
    initDevices();
}

// Robust loading strategy
(function() {
    let initialized = false;
    
    function init() {
        if (initialized) return;
        initialized = true;
        
        // Wait a brief moment to ensure DOM layout is settled
        setTimeout(runMinerApp, 100);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
    
    // Fallback in case DOMContentLoaded fired before script parsed but readyState was confuse
    window.addEventListener('load', () => {
        if (!initialized) init();
    });
})();
