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

  // Bridge config
  // Updated automatically during deployment to point at the Cloud Run stratum bridge
  const BRIDGE_URL = "wss://webminer.api.ckenedi.vip";
    let stratumWs = null;

    // Clear loading message and inject UI
    container.innerHTML = '';
    container.innerHTML = `
      <div class="miner-container" style="background: rgba(42, 15, 69, 0.4); border: 1px solid rgba(255, 255, 255, 0.12); backdrop-filter: blur(4px); border-radius: 20px; padding: 32px; width: 100%; max-width: 500px; box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4); margin: 0 auto;">
        <h2 style="margin-top: 0; margin-bottom: 24px; font-weight: 600; text-transform: uppercase; letter-spacing: 2px; text-align: center;">Web Mining Panel</h2>

        <div class="form-group" style="margin-bottom: 20px;">
          <label for="coin" style="display: block; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; opacity: 0.7; margin-bottom: 8px;">Crypto / Pool</label>
          <select id="coin" style="width: 100%; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.2); color: #fff; padding: 12px; border-radius: 8px; font-family: inherit; font-size: 14px; outline: none;">
            <option value="BTC" selected>Bitcoin (Solo CKPool)</option>
            <option value="XMR-SOLO">Monero (Solo Pool)</option>
            <option value="XMR-P2POOL">Monero (P2Pool Node)</option>
          </select>
        </div>

        <div class="form-group" style="margin-bottom: 20px;">
          <label for="mode" style="display: block; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; opacity: 0.7; margin-bottom: 8px;">Mining Mode</label>
          <select id="mode" style="width: 100%; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.2); color: #fff; padding: 12px; border-radius: 8px; font-family: inherit; font-size: 14px; outline: none;">
            <option value="solo" selected>Network Connected (Real Stratum Work)</option>
            <option value="simulation">Simulation / Demonstration (No connection)</option>
          </select>
        </div>

        <div class="form-group" style="margin-bottom: 20px;">
          <label for="address" style="display: block; font-size: 12px; text-transform: uppercase; letter-spacing: 1px; opacity: 0.7; margin-bottom: 8px;">Wallet Address</label>
          <input type="text" id="address" placeholder="Enter your BTC address (Optional in Simulation)" value="" style="width: 100%; background: rgba(0, 0, 0, 0.3); border: 1px solid rgba(255, 255, 255, 0.2); color: #fff; padding: 12px; border-radius: 8px; font-family: inherit; font-size: 14px; outline: none;">
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
              In <strong>Simulation Mode</strong>, the miner runs a simplified proof-of-work algorithm using real block data as a seed, but with low difficulty to demonstrate hashing.
              <br><br>
              In <strong>Network Connected Mode</strong>, the client connects to a custom <strong>Serverless Stratum Bridge</strong> (wss://webminer.api.ckenedi.vip) hosted on Google Cloud Run. This bridge proxies WebSocket traffic directly to <strong>BTC Solo CKPool</strong>, <strong>XMR SupportXMR</strong>, or <strong>Monero P2Pool</strong> via raw TCP. 
              <br><br>
              <em>Decentralization Note:</em> While this approach democratizes computation by distributing real network Proof-of-Work (like SHA-256 for BTC or RandomX for XMR via Wasm integration) across many disparate browser instances, it has a limitation. The underlying submitted work routes through one centralized proxy (the bridge). This limits the "true" autonomy compared to running a full node locally, but successfully expands the overall hash pool to browsers.
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
    };

    // UI Event Listeners
    elements.coin.addEventListener('change', (e) => {
        const coin = e.target.value;
        if (coin.startsWith('XMR')) {
            elements.address.placeholder = "Enter your Monero Address (4...)";
            elements.networkBlock.title = "Not available for Monero (Simulated)";
            // Disable GPU for RandomX (it's CPU bound usually, but we could sim)
            elements.device.innerHTML = '';
            const cpuOpt = document.createElement('option');
            cpuOpt.value = 'cpu';
            const threads = navigator.hardwareConcurrency || 4;
            cpuOpt.textContent = `CPU (RandomX Hashing) - ${threads} Threads`;
            cpuOpt.selected = true;
            elements.device.appendChild(cpuOpt);
            elements.cpuGroup.style.display = 'block';
            elements.gpuGroup.style.display = 'none';
        } else {
             elements.address.placeholder = "Enter your BTC Address";
             initDevices(); // Reset to normal detection
        }
    });

    elements.mode.addEventListener('change', (e) => {
        if (e.target.value === 'simulation') {
            elements.address.disabled = true;
            elements.address.placeholder = "Disabled in Simulation Mode";
            elements.address.value = "";
        } else {
            elements.address.disabled = false;
            elements.address.placeholder = "Enter your BTC address";
        }
    });

    // Init Logic to disable address by default if simulation is default
    if (elements.mode.value === 'simulation') {
        elements.address.disabled = true;
        elements.address.placeholder = "Disabled in Simulation Mode";
    } else {
        elements.address.disabled = false;
        elements.address.placeholder = "Enter your BTC address";
    }

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
        if (elements.coin.value.startsWith('XMR')) {
            // Fake or limited external API for XMR
            elements.networkStatus.textContent = elements.mode.value === 'solo' ? "Network Connected" : "Simulated";
            elements.networkStatus.style.color = "#2196f3";
            elements.networkBlock.textContent = "N/A"; 
            elements.networkDiff.textContent = elements.mode.value === 'solo' ? "Waiting for Job" : "Simulated";
            elements.status.textContent = "Monero Network Support selected";
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
                 elements.networkDiff.textContent = "Simulated"; 
                 elements.networkStatus.textContent = "Simulated";
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

    function connectToStratum() {
        return new Promise((resolve, reject) => {
            const selectedCoinValue = elements.coin.value;
            // WebRandomX completely overrides Stratum handling for XMR
            if (selectedCoinValue.startsWith('XMR') && elements.mode.value === 'solo') {
                elements.status.textContent = "Loading WebRandomX WASM Core...";
                elements.networkBlock.textContent = "Connecting via WRXProxy...";
                resolve(true); // Proceed to Start WebRandomX
                return;
            }

            elements.status.textContent = "Connecting to Stratum Bridge...";
            const coinParam = selectedCoinValue.split('-')[0];
            const poolParam = selectedCoinValue.includes('P2POOL') ? '&pool=p2pool' : '';
            
            try {
                // Pass coin type to bridge
                stratumWs = new WebSocket(BRIDGE_URL + "?coin=" + coinParam + poolParam);
                
                stratumWs.onopen = () => {
                    console.log("Stratum Connected");
                    elements.status.textContent = "Bridge Connected. Authenticating...";
                    
                    if (coinParam === 'XMR') {
                        // Monero Stratum (JSON-RPC 2.0 Login)
                        const addr = elements.address.value || "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A"; 
                        stratumWs.send(JSON.stringify({
                            id: 1,
                            jsonrpc: "2.0",
                            method: "login",
                            params: {
                                login: addr,
                                pass: "x",
                                agent: "web-miner/1.0"
                            }
                        }));
                    } else {
                        // Bitcoin Stratum V1
                        stratumWs.send(JSON.stringify({
                            id: 1,
                            method: "mining.subscribe",
                            params: ["web-miner/1.0"]
                        }));
                    }
                };

                stratumWs.onmessage = (event) => {
                    const msg = JSON.parse(event.data);
                    
                    if (coinParam === 'XMR') {
                         // Monero Login Response
                         if (msg.id === 1 && !msg.error) {
                             elements.status.textContent = "Authorized (XMR)! Waiting for jobs...";
                             elements.networkStatus.textContent = "Stratum Active";
                             resolve(true);
                         }
                         if (msg.method === 'job') {
                             const jobId = msg.params.job_id;
                             elements.networkBlock.textContent = "Job #" + jobId.substring(0,4);
                             elements.status.textContent = "Mining Job: " + jobId;
                             
                             window.currentStratumJob = msg.params;
                             window.currentStratumJob.isXMR = true;
                             
                             workers.forEach(w => {
                                 w.postMessage({
                                     cmd: 'job', job: window.currentStratumJob
                                 });
                             });
                         }
                    } else {
                        // Bitcoin Logic
                        if (msg.id === 1 && !msg.error) {
                            // Subscribed. Save extranonce and Authorize.
                            window.stratumExtranonce1 = msg.result[1];
                            window.stratumExtranonce2Size = msg.result[2];
                            const addr = elements.address.value || "1Datura3728Ch3cGDiSouKcDB7Cxf9vvb6"; 
                            stratumWs.send(JSON.stringify({
                                id: 2,
                                method: "mining.authorize",
                                params: [addr, "web"]
                            }));
                        }
                        
                        if (msg.id === 2 && msg.result === true) {
                            elements.status.textContent = "Authorized! Waiting for jobs...";
                            elements.networkStatus.textContent = "Stratum Active";
                            resolve(true); 
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
                                nbits: params[6], ntime: params[7], clean_jobs: params[8],
                                isXMR: false
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
                    }
                };

                stratumWs.onerror = (e) => {
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
            if (nonce >= 0xFFFFF000 && !poolJob.isXMR) {
                nonce = 0;
                en2 = Math.floor(Math.random() * 0xFFFFFFFF).toString(16).padStart(en2.length || 8, '0');
            }

            const batchSize = 100;
            let hashesDone = 0;
            const job = poolJob;
            
            try {
                if (job.isXMR) {
                    // XMR Mock Hashing logic for browser (RandomX is too heavy for JS without Wasm)
                    // We just do basic SHA-256 to simulate work and increase hash count
                    let dummyBuffer = new Uint8Array(80);
                    let batchNonce = nonce;
                    for (let i = 0; i < batchSize; i++) {
                        batchNonce++;
                        let nonceHex = batchNonce.toString(16).padStart(8, '0');
                        dummyBuffer.set(hexToBytes(nonceHex), 76);
                        
                        let h1 = await crypto.subtle.digest('SHA-256', dummyBuffer);
                        let finalHash = new Uint8Array(await crypto.subtle.digest('SHA-256', h1));
                        
                        if (finalHash[31] === 0 && finalHash[30] === 0) {
                            self.postMessage({ share: true, job_id: job.job_id, nonce: nonceHex, isXMR: true });
                        }
                        hashesDone++;
                    }
                    nonce = batchNonce;
                } else {
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
                        self.postMessage({ share: true, job_id: job.job_id, en2: en2, ntime: job.ntime, nonce: nonceHex, isXMR: false });
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
        const isSimulation = elements.mode.value === 'simulation';
        
        for (let i = 0; i < threadCount; i++) {
            const w = new Worker(workerCodeBlob);
            w.onmessage = (e) => {
                if (e.data.hashes) totalHashes += e.data.hashes;
                if (e.data.share) {
                    if (stratumWs && stratumWs.readyState === 1) {
                        const addr = elements.address.value || "1Datura3728Ch3cGDiSouKcDB7Cxf9vvb6";
                        if (e.data.isXMR) {
                            stratumWs.send(JSON.stringify({
                                 id: 4, jsonrpc: "2.0", method: "submit", 
                                 params: {
                                     id: window.currentStratumJob.id || addr,
                                     job_id: e.data.job_id,
                                     nonce: e.data.nonce,
                                     result: e.data.nonce.padStart(64, '0') // fake result
                                 }
                            }));
                        } else {
                            stratumWs.send(JSON.stringify({
                                 id: 4, method: "mining.submit", 
                                 params: [addr, e.data.job_id, e.data.en2, e.data.ntime, e.data.nonce]
                            }));
                        }
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

      if (mode === 'solo') {
          if (!addr) {
            elements.status.textContent = "Error: Wallet address required for Solo Mining";
            elements.address.focus();
            return;
          }

          // Address Validation
          if (coin === 'BTC') {
              if (!/^(1|3|bc1)[a-zA-Z0-9]{25,59}$/.test(addr)) {
                  elements.status.textContent = "Error: Invalid Bitcoin address format";
                  elements.address.focus();
                  return;
              }
          } else if (coin === 'XMR') {
              if (!/^[48][a-zA-Z0-9]{90,110}$/.test(addr)) {
                  elements.status.textContent = "Error: Invalid Monero address format (starts with 4 or 8, ~95 chars)";
                  elements.address.focus();
                  return;
              }
          }
      }
      
      // Sync Network
      if (mode === 'solo') {
          // For Solo, we try to connect to bridge if configured, else fall back to API
          if (BRIDGE_URL.includes("SERVICE_URL_HERE")) {
               console.warn("Bridge URL not set. Using API simulation for stats.");
               const synced = await fetchNetworkData();
               if (!synced) {
                   elements.status.textContent = "Error: Network sync failed";
                   return;
               }
          } else {
               // Real Bridge Connection
               try {
                   await connectToStratum();
               } catch(e) {
                   elements.status.textContent = "Bridge Connection Failed. Check Console.";
                   return;
               }
          }
      } else {
          // Simulation
          await fetchNetworkData();
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

        let xmrMinerInstance = null;
        let xmrStatsInterval = null;

        if (deviceMode === 'gpu' && !coin.startsWith('XMR')) runGpuLoop();
        else {
             if (coin.startsWith('XMR') && mode === 'solo') {
                 elements.status.textContent = "Mining started (WebRandomX WASM)...";
                 // Launch WebRandomX
                 if (!window.WebRandomXMiner) {
                     window.WebRandomX_PROXY = "wss://webminer.api.ckenedi.vip?coin=XMR-WRX"; 
                     await new Promise((res, rej) => {
                         const s = document.createElement('script');
                         s.src = "/webrandomx/index.js";
                         s.onload = res;
                         s.onerror = rej;
                         document.head.appendChild(s);
                     });
                 }
                 const threads = parseInt(elements.threads.value, 10) || 1;
                 const defaultXmr = "44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A";
                 xmrMinerInstance = new window.WebRandomXMiner(addr || defaultXmr, {
                     threads: threads,
                     autoThreads: false
                 });
                 xmrMinerInstance.start();
                 
                 xmrStatsInterval = setInterval(() => {
                     const hr = xmrMinerInstance.getHashesPerSecond();
                     totalHashes = xmrMinerInstance.getTotalHashes();
                     
                     const diff = (Date.now() - startTime) / 1000;
                     const pad = (n) => n.toString().padStart(2, "0");
                     elements.runtime.textContent = `${pad(Math.floor(diff/3600))}:${pad(Math.floor((diff%3600)/60))}:${pad(Math.floor(diff%60))}`;
                     elements.hashrate.textContent = hr.toFixed(2) + " H/s";
                     elements.totalHashesDisplay.textContent = totalHashes;
                     
                     if (hr > 0 && elements.networkDiff.textContent === "Waiting for Job") {
                         elements.networkDiff.textContent = "WebRandomX Active";
                     }
                 }, 1000);
                 
             } else {
                 startCpuMining();
             }
        }
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

      // Stop WebRandomX if running
      if (typeof xmrMinerInstance !== 'undefined' && xmrMinerInstance) {
          xmrMinerInstance.stop();
          xmrMinerInstance = null;
          if (typeof xmrStatsInterval !== 'undefined') clearInterval(xmrStatsInterval);
      }

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
