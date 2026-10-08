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
    
    // Network State
    let currentBlockHeight = 0;
    let currentBlockHash = "";
    let difficulty = 1; // Default difficulty
    let currentBits = 0;

    // Web Workers for CPU
    let workers = [];
    let workerCodeBlob = null;
    
    // GPU State
    let adapter = null;
    let device = null;
    let pipeline = null;
    let bindGroup = null;
    let resultBuffer = null;

  // Bridge config - public WebSocket stratum bridge
  const BRIDGE_URL = "wss://stratum.tensors.vip";
    let stratumWs = null;

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
            <option value="pplns" selected>Shared Pool (btcpowlab) - PPLNS / hybrid, no account needed</option>
            <option value="solo">Solo - mine and keep the full block reward</option>
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
            <label for="intensity" style="display: block; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; opacity: 0.7; margin-bottom: 8px;">Compute Intensity (Workgroup Size: <span id="intensity-val">65535</span>)</label>
            <input type="range" id="intensity" min="1000" max="65535" value="65535" step="100" style="width: 100%; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.2); color: #fff; padding: 12px; border-radius: 8px;">
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
            <div class="stat-label" style="font-size: 11px; opacity: 0.6; text-transform: uppercase;">Difficulty (Rel)</div>
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
              <strong>Shared Pool (btcpowlab) &mdash; default:</strong> your work joins the btcpowlab hybrid pool. No account is required &mdash; your wallet address is credited automatically. Eligible earnings use a hybrid allocation (85% to the block finder, 10% to other recent miners, 5% to operation). Browser mining is extremely limited and no block or reward is guaranteed.
              <br><br>
              <strong>Solo:</strong> your wallet address is the payout address &mdash; if one of your shares solves a block, the full block reward is paid to you.
              <br><br>
              <strong>Custom Pool:</strong> enter your own pool's host, port and worker login &mdash; your hashes are credited to that pool/account.
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
        elements.intensityVal.textContent = e.target.value;
    });

    elements.device.addEventListener('change', (e) => {
        if (e.target.value === 'cpu') {
            elements.cpuGroup.style.display = 'block';
            elements.gpuGroup.style.display = 'none';
        } else {
            elements.cpuGroup.style.display = 'none';
            elements.gpuGroup.style.display = 'block';
        }
    });

    // State variables defined at top of function

    // Simplified SHA256 simulation in WGSL
    const SHADER_CODE = `
      @group(0) @binding(0) var<storage, read_write> result: atomic<u32>;
      @group(0) @binding(1) var<uniform> params: vec2<u32>; // [seed, difficulty]

      fn hash(x: u32) -> u32 {
          var z = x;
          z = (z ^ 61u) ^ (z >> 16u);
          z = z * 9u;
          z = z ^ (z >> 4u);
          z = z * 668265261u;
          z = z ^ (z >> 15u);
          return z;
      }

      @compute @workgroup_size(64)
      fn main(@builtin(global_invocation_id) global_id : vec3<u32>) {
          let index = global_id.x;
          let seed = params.x;
          
          var h = hash(index + seed);
          for (var i = 0u; i < 100u; i = i + 1u) {
              h = hash(h + i);
          }

          if (h < 100u) {
              atomicAdd(&result, 1u);
          }
      }
    `;

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
                        resolve(true);
                    }

                    if (msg.id === 2 && msg.result === false) {
                        clearTimeout(connectTimeout);
                        reject(new Error("Pool rejected the worker/address"));
                    }

                    if (msg.method === 'mining.notify') {
                        const params = msg.params;
                        const jobId = params[0];
                        elements.networkBlock.textContent = "Job #" + jobId.substring(0,4);
                        elements.status.textContent = "Mining Job: " + jobId;

                        // Dispatch actual network job to all running web workers
                        window.currentStratumJob = {
                            job_id: params[0], prevhash: params[1],
                            coinb1: params[2], coinb2: params[3],
                            merkle_branch: params[4], version: params[5],
                            nbits: params[6], ntime: params[7], clean_jobs: params[8]
                        };

                        workers.forEach(w => {
                            // Gen random en2
                            let en2 = Math.floor(Math.random() * 0xFFFFFFFF).toString(16).padStart((window.stratumExtranonce2Size || 4) * 2, '0');
                            w.postMessage({
                                cmd: 'job', job: window.currentStratumJob,
                                extranonce1: window.stratumExtranonce1, en2: en2
                            });
                        });
                    }

                    if (msg.method === 'mining.set_difficulty') {
                         window.currentPoolDifficulty = msg.params[0];
                         elements.networkDiff.textContent = msg.params[0] + " (Pool Diff)";
                         workers.forEach(w => w.postMessage({ cmd: 'difficulty', difficulty: msg.params[0] }));
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
      cpuOpt.textContent = `CPU (JavaScript Emulation) - ${cpuCount} Threads Avail.`;
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
            gpuOpt.textContent = `WebGPU: ${infoString}`;
            elements.device.appendChild(gpuOpt);
          }
        } catch (e) {
          console.warn("WebGPU initialization failed:", e);
        }
      }
      elements.status.textContent = "Ready.";
    }

    // Prepare Worker Code
    const workerScript = `
        // True Double-SHA256 Stratum Miner Worker
        let poolDifficulty = 1.0;
        let isMining = false;
        let isSimulation = false;
        let poolJob = null;
        let en1 = ''; let en2 = ''; let nonce = 0;

        self.onmessage = function(e) {
            if (e.data.cmd === 'start') {
                isMining = true; 
                isSimulation = e.data.simulation;
                mineBatch();
            } else if (e.data.cmd === 'stop') {
                isMining = false;
            } else if (e.data.cmd === 'job') {
                poolJob = e.data.job; en1 = e.data.extranonce1; en2 = e.data.en2; nonce = 0;
            } else if (e.data.cmd === 'difficulty') {
                poolDifficulty = e.data.difficulty;
            }
        };

        function hexToBytes(hex) {
            if (!hex) return new Uint8Array();
            const bytes = new Uint8Array(hex.length / 2);
            for (let i = 0; i < hex.length; i += 2) bytes[i/2] = parseInt(hex.substr(i, 2), 16);
            return bytes;
        }

        async function mineBatch() {
            if (!isMining) return;
            
            // Simulation Mode (Mock hashing to demonstrate UI & local computation)
            if (isSimulation) {
                const batchSize = 1000;
                for (let i = 0; i < batchSize; i++) {
                    let z = i ^ 0x12345;
                }
                self.postMessage({ hashes: batchSize });
                setTimeout(mineBatch, 0); // Non-blocking loop
                return;
            }

            if (!poolJob) { setTimeout(mineBatch, 500); return; }

            // Ensure we don't exhaust the 32-bit nonce space and duplicate work
            if (nonce >= 0xFFFFF000) {
                nonce = 0;
                en2 = Math.floor(Math.random() * 0xFFFFFFFF).toString(16).padStart(en2.length || 8, '0');
            }

            const batchSize = 100;
            let hashesDone = 0;
            const job = poolJob;
            
            try {
                {
                    // Construct Coinbase for BTC
                    const coinbaseText = job.coinb1 + en1 + en2 + job.coinb2;
                const coinbaseBytes = hexToBytes(coinbaseText);
                const cbHash1 = await crypto.subtle.digest('SHA-256', coinbaseBytes);
                const coinbaseHash = await crypto.subtle.digest('SHA-256', cbHash1);

                // Merkle Root
                let merkleRoot = new Uint8Array(coinbaseHash);
                if (job.merkle_branch && job.merkle_branch.length > 0) {
                    for (let i = 0; i < job.merkle_branch.length; i++) {
                        const combined = new Uint8Array(64);
                        combined.set(merkleRoot, 0); combined.set(hexToBytes(job.merkle_branch[i]), 32);
                        const h1 = await crypto.subtle.digest('SHA-256', combined);
                        merkleRoot = new Uint8Array(await crypto.subtle.digest('SHA-256', h1));
                    }
                }

                // Header (80 bytes)
                const header = new Uint8Array(80);
                header.set(hexToBytes(job.version), 0);
                header.set(hexToBytes(job.prevhash), 4);
                header.set(merkleRoot, 36);
                header.set(hexToBytes(job.ntime), 68);
                header.set(hexToBytes(job.nbits), 72);

                let batchNonce = nonce;
                for (let i = 0; i < batchSize; i++) {
                    batchNonce++;
                    let nonceHex = batchNonce.toString(16).padStart(8, '0');
                    header.set(hexToBytes(nonceHex), 76);

                    // Double SHA256 of header
                    let h1 = await crypto.subtle.digest('SHA-256', header);
                    let finalHash = new Uint8Array(await crypto.subtle.digest('SHA-256', h1));
                    
                    // Real Stratum pool difficulty validation
                    let hexStr = '';
                    for (let j = 31; j >= 0; j--) {
                        hexStr += finalHash[j].toString(16).padStart(2, '0');
                    }
                    let hashVal = BigInt('0x' + hexStr);
                    let maxTarget = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
                    let diffBig = BigInt(Math.floor(poolDifficulty * 1000000));
                    let targetVal = diffBig > 0n ? (maxTarget * 1000000n) / diffBig : 0n;
                    
                    if (hashVal <= targetVal) {
                        self.postMessage({ share: true, job_id: job.job_id, en2: en2, ntime: job.ntime, nonce: nonceHex });
                    }
                    hashesDone++;
                }
                nonce = batchNonce;
                }
            } catch (e) {
                console.error(e);
            }

            self.postMessage({ hashes: hashesDone });
            setTimeout(mineBatch, 0); // Non-blocking loop
        };
    `;
    const blob = new Blob([workerScript], { type: 'application/javascript' });
    workerCodeBlob = URL.createObjectURL(blob);

    function startCpuMining() {
        // clear old workers
        workers.forEach(w => w.terminate());
        workers = [];

        const threadCount = parseInt(elements.threads.value, 10) || 1;
        const isSimulation = false; // all modes submit real pool work
        
        for (let i = 0; i < threadCount; i++) {
            const w = new Worker(workerCodeBlob);
            w.onmessage = (e) => {
                if (e.data.hashes) totalHashes += e.data.hashes;
                if (e.data.share) {
                    if (stratumWs && stratumWs.readyState === 1) {
                        stratumWs.send(JSON.stringify({
                                 id: 4, method: "mining.submit", 
                                 params: [getSubmitUser(), e.data.job_id, e.data.en2, e.data.ntime, e.data.nonce]
                            }));
                        
                        console.log("Submitting Share...", e.data);
                        elements.status.textContent = "Share Found & Submitted! Nonce: " + e.data.nonce;
                    }
                }
            };
            w.postMessage({ cmd: 'start', simulation: isSimulation });
            
            // Send current job if we already have one from stratum
            if (window.currentStratumJob) {
                 let en2 = Math.floor(Math.random()*0xFFFFFFFF).toString(16).padStart((window.stratumExtranonce2Size||4)*2, '0');
                 w.postMessage({ cmd: 'job', job: window.currentStratumJob, extranonce1: window.stratumExtranonce1, en2: en2 });
            }
            // Send current difficulty if we already have it
            if (window.currentPoolDifficulty) {
                 w.postMessage({ cmd: 'difficulty', difficulty: window.currentPoolDifficulty });
            }
            
            workers.push(w);
        }

        // Animation frame just for UI updates
        function uiLoop() {
            if (!isMining) return;
            updateStats();
            animationFrameId = requestAnimationFrame(uiLoop);
        }
        uiLoop();
    }

    async function setupGpuCompute() {
      if (!adapter) throw new Error("No GPU adapter available");
      if (device) return; // Already setup

      try {
        device = await adapter.requestDevice();
      } catch (e) {
        throw new Error("Failed to request GPU device: " + e.message);
      }
      
      if (!device) throw new Error("GPU device creation returned null");

      const bufferSize = 4;
      resultBuffer = device.createBuffer({
        size: bufferSize,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
      });

      const paramsBuffer = device.createBuffer({
        size: 8, // 2 x u32
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      });
      
      device.queue.writeBuffer(paramsBuffer, 0, new Uint32Array([Date.now(), 0]));

      const shaderModule = device.createShaderModule({
        code: SHADER_CODE,
      });

      pipeline = device.createComputePipeline({
        layout: "auto",
        compute: {
          module: shaderModule,
          entryPoint: "main",
        },
      });

      bindGroup = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: resultBuffer } },
          { binding: 1, resource: { buffer: paramsBuffer } },
        ],
      });

      // Seed with network data if available
      if (currentBlockHash) {
           const seed = parseInt(currentBlockHash.substring(0, 8), 16);
           device.queue.writeBuffer(paramsBuffer, 0, new Uint32Array([seed, 0]));
      }
    }

    function runGpuLoop() {
      if (!isMining || !device) return;
      
      const workgroupCount = parseInt(elements.intensity.value, 10) || 1000;
      
      try {
          const commandEncoder = device.createCommandEncoder();
          const passEncoder = commandEncoder.beginComputePass();
          passEncoder.setPipeline(pipeline);
          passEncoder.setBindGroup(0, bindGroup);
          passEncoder.dispatchWorkgroups(workgroupCount);
          passEncoder.end();

          device.queue.submit([commandEncoder.finish()]);

          totalHashes += 64 * workgroupCount;
          updateStats();
          animationFrameId = requestAnimationFrame(runGpuLoop);
      } catch(e) {
          console.error("GPU Loop Error", e);
          isMining = false;
          elements.status.textContent = "GPU Error: " + e.message;
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
      
      const deviceMode = elements.device.value;
      try {
        if (deviceMode === 'gpu') {
            if (!adapter) {
                // If the adapter variable is null but navigator.gpu exists, try to init again or fail
                if (navigator.gpu) {
                    await initDevices(); // Attempt re-init
                    if (!adapter) {
                        elements.status.textContent = "Error: GPU adapter could not be initialized.";
                        return;
                    }
                } else {
                     elements.status.textContent = "Error: WebGPU not supported in this browser.";
                     return;
                }
            }
            await setupGpuCompute();
            elements.status.textContent = "Mining started (GPU Mode)...";
        } else {
            elements.status.textContent = "Mining started (CPU Mode)...";
        }
        isMining = true;
        startTime = Date.now();
        totalHashes = 0;
        elements.startBtn.disabled = true;
        elements.stopBtn.disabled = false;
        elements.address.disabled = true;
        elements.device.disabled = true;
        elements.status.style.color = "#7d3cff";

        if (deviceMode === 'gpu') runGpuLoop();
        else startCpuMining();
      } catch (e) {
        console.error(e);
        elements.status.textContent = "Mining failed: " + e.message;
        isMining = false;
      }
    });

    elements.stopBtn.addEventListener("click", () => {
      isMining = false;
      cancelAnimationFrame(animationFrameId);
      
      // Stop Workers
      workers.forEach(w => w.terminate());
      workers = [];

      elements.startBtn.disabled = false;
      elements.stopBtn.disabled = true;
      elements.address.disabled = false;
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
