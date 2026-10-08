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

  // Bridge config - public WebSocket stratum bridge
  const BRIDGE_URL = "wss://stratum.tensors.vip";
    let stratumWs = null;
    let suggestedDifficulty = false;

    // Clear loading message and inject UI
    container.innerHTML = '';
    container.innerHTML = `
      <div class="miner-container" style="background: rgba(42, 15, 69, 0.4); border: 1px solid rgba(255, 255, 255, 0.12); backdrop-filter: blur(4px); border-radius: 20px; padding: 32px; width: 100%; max-width: 500px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4); margin: 0 auto;">
        <h2 style="margin-top: 0; margin-bottom: 24px; font-weight: 600; text-transform: uppercase; letter-spacing: 2px; text-align: center;">Web Mining Panel</h2>

        <div class="form-group" style="margin-bottom: 20px;">
          <label for="coin" style="display: block; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; opacity: 0.7; margin-bottom: 8px;">Crypto / Pool</label>
          <select id="coin" style="width: 100%; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.2); color: #fff; padding: 12px; border-radius: 8px; font-family: inherit; font-size: 14px; outline: none;">
            <option value="BTC" selected>Bitcoin (BTC)</option>
          </select>
        </div>

        <div class="form-group" style="margin-bottom: 20px;">
          <label for="mode" style="display: block; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; opacity: 0.7; margin-bottom: 8px;">Mining Mode</label>
          <select id="mode" style="width: 100%; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.2); color: #fff; padding: 12px; border-radius: 8px; font-family: inherit; font-size: 14px; outline: none;">
            <option value="solo" selected>Solo - mine and keep the full block reward (default)</option>
            <option value="pplns">Shared Pool (btcpowlab) - PPLNS / hybrid, no account needed</option>
            <option value="custom">Custom Pool - mine for your own pool</option>
          </select>
        </div>

        <div class="form-group" style="margin-bottom: 20px;">
          <label for="address" style="display: block; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; opacity: 0.7; margin-bottom: 8px;">Wallet Address</label>
          <input type="text" id="address" placeholder="Enter your BTC address" value="" style="width: 100%; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.2); color: #fff; padding: 12px; border-radius: 8px; font-family: inherit; font-size: 14px; outline: none;">
          <div id="address-hint" style="margin-top: 8px; font-size: 12px; line-height: 1.45; opacity: 0.72; display: none;">
            No account or username is needed for the default pool &mdash; you are logged in automatically as
            <code style="background: rgba(0,0,0,0.35); padding: 1px 5px; border-radius: 4px;">&lt;your-address&gt;.browser</code>.
          </div>
          <div id="pool-dashboard" style="margin-top: 10px; display: none;">
            <a href="https://btcpowlab-pool.com/start" target="_blank" rel="noopener" style="color: #b892ff; font-size: 13px; text-decoration: underline;">View the live pool dashboard &nearr;</a>
          </div>
        </div>

        <div class="form-group" id="custom-pool-group" style="margin-bottom: 20px; display: none;">
          <label style="display: block; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; opacity: 0.7; margin-bottom: 8px;">Custom Pool Connection</label>
          <input type="text" id="pool-host" placeholder="Pool host (e.g. pool.example.com)" style="width: 100%; margin-bottom: 8px; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.2); color: #fff; padding: 12px; border-radius: 8px; font-family: inherit; font-size: 14px; outline: none;">
          <input type="number" id="pool-port" placeholder="Port (e.g. 3333)" style="width: 100%; margin-bottom: 8px; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.2); color: #fff; padding: 12px; border-radius: 8px; font-family: inherit; font-size: 14px; outline: none;">
          <input type="text" id="pool-worker" placeholder="Worker / username" style="width: 100%; margin-bottom: 8px; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.2); color: #fff; padding: 12px; border-radius: 8px; font-family: inherit; font-size: 14px; outline: none;">
          <input type="password" id="pool-password" placeholder="Password (x if none required)" style="width: 100%; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.2); color: #fff; padding: 12px; border-radius: 8px; font-family: inherit; font-size: 14px; outline: none;">
        </div>

        <div class="form-group" style="margin-bottom: 20px;">
          <label for="device" style="display: block; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; opacity: 0.7; margin-bottom: 8px;">Mining Device</label>
          <select id="device" style="width: 100%; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.2); color: #fff; padding: 12px; border-radius: 8px; font-family: inherit; font-size: 14px; outline: none;">
            <option value="">Detecting devices...</option>
          </select>
        </div>

        <div class="form-group" id="cpu-threads-group" style="margin-bottom: 20px;">
             <label for="threads" style="display: block; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; opacity: 0.7; margin-bottom: 8px;">CPU Threads</label>
             <input type="number" id="threads" min="1" max="128" value="1" style="width: 100%; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.2); color: #fff; padding: 12px; border-radius: 8px; font-family: inherit; font-size: 14px; outline: none;">
        </div>

        <div class="form-group" id="gpu-intensity-group" style="margin-bottom: 20px; display: none;">
            <label for="intensity" style="display: block; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; opacity: 0.7; margin-bottom: 8px;">GPU Intensity (nonces per frame: <span id="intensity-val">131072</span>)</label>
            <input type="range" id="intensity" min="64" max="65535" value="2048" step="64" style="width: 100%; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.2); color: #fff; padding: 12px; border-radius: 8px;">
        </div>

        <div class="stats" style="margin-top: 24px; padding-top: 24px; border-top: 1px solid rgba(255, 255, 255, 0.1); display: grid; grid-template-columns: 1fr 1fr; gap: 16px;">
          <div class="stat-item" style="text-align: center;">
            <div class="stat-value" id="hashrate" style="font-size: 20px; font-weight: 700; margin-bottom: 4px; font-feature-settings: 'tnum';">0.00 MH/s</div>
            <div class="stat-label" style="font-size: 11px; opacity: 0.6; text-transform: uppercase;">Hashrate</div>
          </div>
          <div class="stat-item" style="text-align: center;">
            <div class="stat-value" id="network-block" style="font-size: 20px; font-weight: 700; margin-bottom: 4px; font-feature-settings: 'tnum';">...</div>
            <div class="stat-label" style="font-size: 11px; opacity: 0.6; text-transform: uppercase;">Current Block</div>
          </div>
          <div class="stat-item" style="text-align: center;">
            <div class="stat-value" id="runtime" style="font-size: 20px; font-weight: 700; margin-bottom: 4px; font-feature-settings: 'tnum';">00:00:00</div>
            <div class="stat-label" style="font-size: 11px; opacity: 0.6; text-transform: uppercase;">Time Elapsed</div>
          </div>
          <div class="stat-item" style="text-align: center;">
            <div class="stat-value" id="difficulty" style="font-size: 20px; font-weight: 700; margin-bottom: 4px; font-feature-settings: 'tnum';">...</div>
            <div class="stat-label" style="font-size: 11px; opacity: 0.6; text-transform: uppercase;">Network Difficulty</div>
          </div>
          <div class="stat-item" style="text-align: center;">
            <div class="stat-value" id="share-difficulty" style="font-size: 20px; font-weight: 700; margin-bottom: 4px; font-feature-settings: 'tnum';">...</div>
            <div class="stat-label" style="font-size: 11px; opacity: 0.6; text-transform: uppercase;">Share Difficulty</div>
          </div>
          <div class="stat-item" style="text-align: center;">
            <div class="stat-value" id="best-share" style="font-size: 20px; font-weight: 700; margin-bottom: 4px; font-feature-settings: 'tnum';">0</div>
            <div class="stat-label" style="font-size: 11px; opacity: 0.6; text-transform: uppercase;">Best Share</div>
          </div>
          <div class="stat-item" style="text-align: center;">
             <div class="stat-value" id="total-hashes" style="font-size: 20px; font-weight: 700; margin-bottom: 4px; font-feature-settings: 'tnum';">0</div>
             <div class="stat-label" style="font-size: 11px; opacity: 0.6; text-transform: uppercase;">Total Hashes</div>
          </div>
          <div class="stat-item" style="text-align: center;">
             <div class="stat-value" id="network-status" style="font-size: 16px; font-weight: 700; margin-bottom: 4px; color: #aaa;">Only Local</div>
             <div class="stat-label" style="font-size: 11px; opacity: 0.6; text-transform: uppercase;">Network</div>
          </div>
        </div>

        <div class="status-log" id="status" style="margin-top: 16px; font-size: 12px; font-family: monospace; color: rgba(255, 255, 255, 0.6); text-align: center; min-height: 1.5em;">Ready to initialize</div>

        <div class="btn-row" style="display: flex; gap: 12px; margin-top: 32px;">
          <button id="start-btn" style="flex: 1; padding: 14px; border: none; border-radius: 999px; font-weight: 600; cursor: pointer; text-transform: uppercase; letter-spacing: 1px; transition: transform 0.2s, opacity 0.2s; background: #7d3cff; color: white;">Start Mining</button>
          <button id="stop-btn" style="flex: 1; padding: 14px; border: none; border-radius: 999px; font-weight: 600; cursor: pointer; text-transform: uppercase; letter-spacing: 1px; transition: transform 0.2s, opacity 0.2s; background: rgba(255, 255, 255, 0.1); color: white;" disabled>Stop</button>
        </div>

        <div class="info-text" style="margin-top: 32px; padding-top: 24px; border-top: 1px solid rgba(255, 255, 255, 0.1); font-size: 13px; line-height: 1.5; opacity: 0.8;">
          <h3 style="font-size: 14px; text-transform: uppercase; margin-bottom: 8px;">How it works</h3>
          <p>
              Every mode submits <strong>real</strong> Bitcoin (SHA-256) work to a real pool through the <strong>Stratum Bridge</strong> at wss://stratum.tensors.vip.
              <br><br>
              <strong>Solo &mdash; default:</strong> your wallet address is the payout address &mdash; if one of your shares solves a block, the full block reward is paid to you. The miner asks the pool for the lowest <em>share</em> difficulty (1) so a browser can still find shares.
              <br><br>
              <strong>Two different difficulties:</strong> the <em>Network Difficulty</em> panel shows the real, live Bitcoin difficulty, read straight from each job's block header. A block is valid only when a hash meets that (enormous) target &mdash; and it is the <strong>pool</strong> (ckpool) that detects it and broadcasts the block. This page only ever submits shares over Stratum and never broadcasts anything. The <em>Share Difficulty</em> (1) is just the much lower bar at which the pool <em>credits</em> a share; lowering it changes nothing about block validity, so a browser can never make the network reject a block.
              <br><br>
              <strong>Shared Pool (btcpowlab):</strong> your work joins the open btcpowlab hybrid pool. No account is required &mdash; your wallet address is credited automatically. Eligible earnings use a hybrid allocation (85% to the block finder, 10% to other recent miners, 5% to operation).
              <br><br>
              <strong>Custom Pool:</strong> enter your own pool's host, port and worker login &mdash; your hashes are credited to that pool/account.
              <br><br>
              <strong>Engines:</strong> CPU runs the double-SHA256 search across Web Workers; GPU runs an efficient WebGPU (WGSL) SHA-256d kernel that scans millions of nonces per frame; CPU + GPU runs both at once. Browser mining is extremely limited and no block or reward is guaranteed.
              <br><br>
              <em>Decentralization Note:</em> While this approach democratizes computation by distributing real network Proof-of-Work (SHA-256 for BTC) across many disparate browser instances, it has a limitation: the underlying submitted work routes through one centralized proxy (the bridge). This limits the "true" autonomy compared to running a full node locally, but successfully expands the overall hash pool to browsers.
          </p>
        </div>
      </div>
    `;

    // Logic
    const elements = {
      coin: document.getElementById("coin"),
      mode: document.getElementById("mode"),
      address: document.getElementById("address"),
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
      addressHint: document.getElementById("address-hint"),
      poolDashboard: document.getElementById("pool-dashboard"),
    };

    // UI Event Listeners
    elements.coin.addEventListener('change', () => {
         elements.address.placeholder = "Enter your BTC Address";
         initDevices();
    });

    // Reflect the selected mode in the form: Solo / PPLNS use the wallet
    // address as the payout / credit address; Custom Pool uses its own login.
    const DEFAULT_POOL_HOST = "stratum.btcpowlab-pool.com";

    function applyModeUI() {
        const mode = elements.mode.value;
        const isCustom = mode === 'custom';
        const isDefaultPool = mode === 'pplns';

        // The dashboard belongs to the default (btcpowlab) pool, so show it when
        // that pool is in use - via the built-in mode or when the same host has
        // been typed into the Custom Pool host field.
        const customHost = (elements.poolHost.value || '').trim().toLowerCase().split(':')[0];
        const usesDefaultPool = isDefaultPool || customHost === DEFAULT_POOL_HOST;

        elements.customGroup.style.display = isCustom ? 'block' : 'none';
        // The address field stays active in every mode so the user can set the
        // worker login; on the default pool it becomes "<address>.browser".
        elements.address.disabled = isCustom;

        if (elements.addressHint) {
            elements.addressHint.style.display = isDefaultPool ? 'block' : 'none';
        }
        if (elements.poolDashboard) {
            elements.poolDashboard.style.display = usesDefaultPool ? 'block' : 'none';
        }

        if (isCustom) {
            elements.address.placeholder = "(unused in Custom Pool mode)";
        } else if (isDefaultPool) {
            elements.address.placeholder = "Enter your BTC address (credited automatically)";
        } else {
            elements.address.placeholder = "Enter your BTC address";
        }
    }

    elements.mode.addEventListener('change', applyModeUI);
    elements.poolHost.addEventListener('input', applyModeUI);
    applyModeUI();

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
        w2[0] = P.tail.x; w2[1] = P.tail.y; w2[2] = P.tail.z; w2[3] = nonce;
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

    async function fetchNetworkData() {
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
            elements.networkBlock.textContent = "Offline";
            return false;
        }
    }

    // Build the bridge WebSocket URL for the selected mode. Custom pools also
    // pass their host/port through the query string for the bridge to dial.
    function buildBridgeUrl() {
        const mode = elements.mode.value;
        let url = BRIDGE_URL + "?coin=BTC&mode=" + encodeURIComponent(mode);
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
        if (elements.mode.value === 'pplns') {
            // The default shared pool (btcpowlab) expects the worker login
            // "<btc-address>.browser" and accepts any password.
            return [(addr ? addr + ".browser" : ""), "x"];
        }
        return [addr, "web"];
    }

    // Username echoed on share submission (must match the authorized login).
    function getSubmitUser() {
        return getAuthParams()[0];
    }

    function connectToStratum() {
        return new Promise((resolve, reject) => {
            elements.status.textContent = "Connecting to Stratum Bridge...";

            // Fresh connection -> forget the previous session's job/difficulty.
            suggestedDifficulty = false;
            window.currentStratumJob = null;
            window.currentPoolDifficulty = null;

            try {
                stratumWs = new WebSocket(buildBridgeUrl());

                // Guard against pools that never answer or reject the worker.
                const connectTimeout = setTimeout(() => {
                    try { stratumWs.close(); } catch (e) {}
                    reject(new Error("Timed out waiting for pool authorization"));
                }, 20000);

                stratumWs.onopen = () => {
                    console.log("Stratum Connected");
                    elements.status.textContent = "Bridge Connected. Authenticating...";
                    stratumWs.send(JSON.stringify({
                        id: 1,
                        method: "mining.subscribe",
                        params: ["web-miner/1.0"]
                    }));
                };

                stratumWs.onmessage = (event) => {
                    const msg = JSON.parse(event.data);

                    if (msg.id === 1 && !msg.error) {
                        // Subscribed. Save extranonce and Authorize.
                        window.stratumExtranonce1 = msg.result[1];
                        window.stratumExtranonce2Size = msg.result[2];
                        stratumWs.send(JSON.stringify({
                            id: 2,
                            method: "mining.authorize",
                            params: getAuthParams()
                        }));
                    }

                    if (msg.id === 2 && msg.result === true) {
                        clearTimeout(connectTimeout);
                        elements.status.textContent = "Authorized! Waiting for jobs...";
                        elements.networkStatus.textContent = "Stratum Active";
                        // Ask the pool for the lowest difficulty it will grant so a
                        // browser (a few MH/s at best) can still find shares. Solo
                        // (ckpool) honours this and drops to difficulty 1; btcpowlab
                        // ignores it and stays at its fixed difficulty.
                        if (!suggestedDifficulty) {
                            suggestedDifficulty = true;
                            try {
                                stratumWs.send(JSON.stringify({ id: 3, method: "mining.suggest_difficulty", params: [1] }));
                            } catch (e) {}
                        }
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
                        // a share also meets this network target.
                        try {
                            const netBits = parseInt(params[6], 16) >>> 0;
                            currentBits = netBits;
                            const netDiff = SHA256Crypto.nbitsToDifficulty(netBits);
                            elements.networkDiff.textContent = formatDifficulty(netDiff);
                            elements.networkDiff.title = 'Real Bitcoin network difficulty, read live from this job\'s block header (nBits ' +
                                params[6] + '). Solving a block needs a hash at or below the matching target; the pool broadcasts it, not this page.';
                        } catch (e) {}

                        // CPU: hand every worker a fresh random extranonce2.
                        workers.forEach(w => {
                            w.postMessage({
                                cmd: 'job', job: window.currentStratumJob,
                                extranonce1: window.stratumExtranonce1,
                                en2: randHex((window.stratumExtranonce2Size || 4) * 2),
                                extranonce2Size: window.stratumExtranonce2Size || 4
                            });
                        });

                        // GPU: rebuild the midstate/target uniform for a fresh extranonce2.
                        if (gpu) {
                            gpu.en2 = randHex((window.stratumExtranonce2Size || 4) * 2);
                            gpu.baseNonce = (Math.random() * 0xffffffff) >>> 0;
                            prepareGpuContext();
                        }
                    }

                    if (msg.method === 'mining.set_difficulty') {
                         window.currentPoolDifficulty = msg.params[0];
                         elements.shareDiff.textContent = msg.params[0] + ' (pool)';
                         elements.shareDiff.title = 'Share difficulty: the pool credits a share when a hash meets this target. It is far below the network difficulty and does not by itself solve a block.';
                         broadcastToWorkers({ cmd: 'difficulty', difficulty: msg.params[0] });
                         if (gpu) prepareGpuContext();
                    }
                };

                stratumWs.onerror = (e) => {
                    clearTimeout(connectTimeout);
                    console.error("Stratum WS Error", e);
                    reject(e);
                };

                stratumWs.onclose = () => {
                    console.log("Stratum Closed");
                    isMining = false;
                };

            } catch(e) {
                reject(e);
            }
        });
    }

    async function initDevices() {
      elements.device.innerHTML = '';
      
      const cpuCount = navigator.hardwareConcurrency || 4;
      elements.threads.value = Math.max(1, Math.floor(cpuCount / 2));
      elements.threads.max = cpuCount;

      const cpuOpt = document.createElement('option');
      cpuOpt.value = 'cpu';
      cpuOpt.textContent = `CPU - ${cpuCount} thread(s), JavaScript SHA-256`;
      cpuOpt.selected = true;
      elements.device.appendChild(cpuOpt);

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
            gpuOpt.textContent = `GPU - WebGPU SHA-256d (${infoString})`;
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
    // miner-worker.js imports sha256.js and runs the optimized nonce search.
    function makeWorker() {
        const w = new Worker('miner-worker.js');
        w.onmessage = (e) => {
            if (e.data.hashes) totalHashes += e.data.hashes;
            if (e.data.share) submitShare(e.data.job_id, e.data.en2, e.data.ntime, e.data.nonce, e.data.difficulty);
        };
        w.onerror = (err) => { console.error('Mining worker error', err); };
        return w;
    }

    // Format `bytes` random bytes as hex (used for extranonce2).
    function randHex(bytes) {
        let s = '';
        for (let i = 0; i < bytes * 2; i++) s += Math.floor(Math.random() * 16).toString(16);
        return s;
    }

    // Submit a share found by any engine (already verified on the obvious path).
    function submitShare(jobId, en2, ntime, nonceHex, shareDiff) {
        if (!stratumWs || stratumWs.readyState !== 1) return;
        stratumWs.send(JSON.stringify({
            id: 4, method: 'mining.submit',
            params: [getSubmitUser(), jobId, en2, ntime, nonceHex]
        }));
        sharesFound++;
        if (typeof shareDiff === 'number' && isFinite(shareDiff) && shareDiff > bestShareDiff) {
            bestShareDiff = shareDiff;
            const netDiff = currentBits ? SHA256Crypto.nbitsToDifficulty(currentBits) : 0;
            elements.bestShare.textContent = formatDifficulty(shareDiff);
            elements.bestShare.title = 'Rarest hash found so far, as a difficulty. Solving a block needs ' +
                formatDifficulty(netDiff) + '; this best share is ' +
                (netDiff > 0 ? (shareDiff / netDiff).toExponential(3) : '0') + ' of the way there.';
        }
        elements.status.textContent = 'Share found & submitted! nonce ' + nonceHex + ' (total ' + sharesFound + ')';
    }

    function broadcastToWorkers(msg) {
        workers.forEach((w) => { try { w.postMessage(msg); } catch (e) {} });
    }

    function startCpuMining() {
        // clear old workers
        workers.forEach(w => w.terminate());
        workers = [];

        const threadCount = Math.max(1, parseInt(elements.threads.value, 10) || 1);
        for (let i = 0; i < threadCount; i++) {
            const w = makeWorker();
            if (window.currentStratumJob) {
                w.postMessage({
                    cmd: 'job', job: window.currentStratumJob,
                    extranonce1: window.stratumExtranonce1,
                    en2: randHex((window.stratumExtranonce2Size || 4) * 2),
                    extranonce2Size: window.stratumExtranonce2Size || 4
                });
            }
            if (window.currentPoolDifficulty) {
                w.postMessage({ cmd: 'difficulty', difficulty: window.currentPoolDifficulty });
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

        gpu = { uniform: uniform, count: count, nonces: nonces, read: read, ctx: null, en2: '00000000', baseNonce: 0, frame: 0 };
        return gpu;
    }

    // Rebuild the midstate/target uniform for the current job + extranonce2.
    function prepareGpuContext() {
        if (!gpu || !window.currentStratumJob) return false;
        const ctx = SHA256Crypto.buildJobContext(
            window.currentStratumJob, window.stratumExtranonce1 || '', gpu.en2,
            window.currentPoolDifficulty || 1);
        gpu.ctx = ctx;
        device.queue.writeBuffer(gpu.uniform, 0, ctx.midstate);   // midstate -> bytes 0..31
        device.queue.writeBuffer(gpu.uniform, 32, ctx.target);    // target   -> bytes 32..63
        return true;
    }

    async function startGpuMining() {
        await setupGpuCompute();
        gpu.en2 = randHex((window.stratumExtranonce2Size || 4) * 2);
        gpu.baseNonce = (Math.random() * 0xffffffff) >>> 0;
        prepareGpuContext();
        if (!gpu.frame) runGpuLoop();
    }

    async function runGpuLoop() {
        if (!isMining || !gpu) return;
        try {
            if (!gpu.ctx || !window.currentStratumJob) {
                gpu.frame = requestAnimationFrame(runGpuLoop);
                return;
            }
            const wg = Math.max(1, Math.min(65535, parseInt(elements.intensity.value, 10) || 2048));
            const span = wg * 64;

            // Roll extranonce2 (and rebuild the midstate) when the 32-bit nonce
            // space is exhausted.
            if (gpu.baseNonce > 0xffffffff - span) {
                gpu.baseNonce = (Math.random() * 0xffffffff) >>> 0;
                gpu.en2 = randHex((window.stratumExtranonce2Size || 4) * 2);
                prepareGpuContext();
            }

            device.queue.writeBuffer(gpu.uniform, 64, new Uint32Array([gpu.ctx.w0, gpu.ctx.ntime, gpu.ctx.nbits, gpu.baseNonce >>> 0]));
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
            totalHashes += span;

            await gpu.read.mapAsync(GPUMapMode.READ);
            const results = new Uint32Array(gpu.read.getMappedRange().slice(0));
            gpu.read.unmap();
            const n = Math.min(results[0], GPU_MAX_FOUND);
            for (let i = 0; i < n; i++) {
                const nonce = results[1 + i];
                // Re-verify on the CPU path before submitting.
                if (SHA256Crypto.nonceIsValid(gpu.ctx, nonce)) {
                    const shareDiff = SHA256Crypto.hashDifficulty(SHA256Crypto.hashNonce(gpu.ctx, nonce));
                    submitShare(window.currentStratumJob.job_id, gpu.en2, window.currentStratumJob.ntime,
                        (nonce >>> 0).toString(16).padStart(8, '0'), shareDiff);
                }
            }
            gpu.baseNonce = (gpu.baseNonce + span) >>> 0;
            gpu.frame = requestAnimationFrame(runGpuLoop);
        } catch (e) {
            console.error('GPU loop error', e);
            elements.status.textContent = 'GPU error: ' + e.message;
            isMining = false;
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
      elements.hashrate.textContent = `${(hs / 1000000).toFixed(2)} MH/s`;
      elements.totalHashesDisplay.textContent = totalHashes.toLocaleString();
    }

    elements.startBtn.addEventListener("click", async () => {
      const mode = elements.mode.value;
      const coin = elements.coin.value;
      const addr = elements.address.value.trim();

      // Validate the inputs required by the selected mode.
      if (mode === 'solo' || mode === 'pplns') {
          if (!addr) {
            elements.status.textContent = "Error: BTC wallet address required for " + (mode === 'solo' ? "Solo" : "the shared pool") + " mining";
            elements.address.focus();
            return;
          }

          if (coin === 'BTC') {
              if (!/^(1|3|bc1)[a-zA-Z0-9]{25,59}$/.test(addr)) {
                  elements.status.textContent = "Error: Invalid Bitcoin address format";
                  elements.address.focus();
                  return;
              }
          }
      } else if (mode === 'custom') {
          const poolHostVal = elements.poolHost.value.trim();
          const poolPortVal = parseInt(elements.poolPort.value.trim(), 10);
          const poolWorkerVal = elements.poolWorker.value.trim();
          if (!poolHostVal || !Number.isInteger(poolPortVal) || !poolWorkerVal) {
              elements.status.textContent = "Error: Custom Pool requires host, port and a worker/username";
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
      
      // Make sure a GPU engine has an adapter before we commit to mining.
      const deviceMode = elements.device.value;
      if ((deviceMode === 'gpu' || deviceMode === 'hybrid') && !adapter) {
          if (navigator.gpu) await initDevices(); // re-detect the adapter
          if (!adapter) {
              elements.status.textContent = "Error: WebGPU is not available in this browser.";
              return;
          }
      }

      try {
        isMining = true;
        startTime = Date.now();
        totalHashes = 0;
        sharesFound = 0;
        bestShareDiff = 0;
        elements.bestShare.textContent = '0';
        elements.bestShare.title = '';
        elements.startBtn.disabled = true;
        elements.stopBtn.disabled = false;
        elements.address.disabled = true;
        elements.device.disabled = true;
        elements.status.style.color = "#7d3cff";

        startUiLoop();
        if (deviceMode === 'cpu' || deviceMode === 'hybrid') startCpuMining();
        if (deviceMode === 'gpu' || deviceMode === 'hybrid') await startGpuMining();
        elements.status.textContent = "Mining started (" + deviceMode.toUpperCase() + ")...";
      } catch (e) {
        console.error(e);
        elements.status.textContent = "Mining failed: " + e.message;
        isMining = false;
        cancelAnimationFrame(animationFrameId);
        workers.forEach(w => w.terminate());
        workers = [];
        elements.startBtn.disabled = false;
        elements.stopBtn.disabled = true;
      }
    });

    elements.stopBtn.addEventListener("click", () => {
      isMining = false;
      cancelAnimationFrame(animationFrameId);
      if (gpu && gpu.frame) { cancelAnimationFrame(gpu.frame); gpu.frame = 0; }

      // Stop Workers
      workers.forEach(w => w.terminate());
      workers = [];

      // Drop the stratum connection so the next start reconnects cleanly.
      if (stratumWs) { try { stratumWs.close(); } catch (e) {} stratumWs = null; }

      elements.startBtn.disabled = false;
      elements.stopBtn.disabled = true;
      elements.address.disabled = (elements.mode.value === 'custom');
      elements.device.disabled = false;
      elements.status.textContent = "Mining stopped";
      elements.status.style.color = "inherit";
    });

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
