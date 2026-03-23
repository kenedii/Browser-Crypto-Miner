# Browser Crypto Miner

A real-time browser-based cryptocurrency miner using WebAssembly (WASM) and WebSocket proxies. Features real Proof-of-Work hashing for Monero via WebRandomX and Bitcoin via a local JavaScript Double-SHA256 solver. Uses a custom Stratum proxy bridging the web socket connections to live cryptocurrency pools while natively supporting continuous cycle "Dev Fees."

## Project Structure

- `mine-crypto.html`: The main user interface and mining execution script for running WebWorkers.
- `miner.js`: Bitcoin hash solver for real difficulty target checks.
- `stratum-bridge/`: Custom Node.js bridge translating WebSocket instructions into standard TCP JSON-RPC for pool communication. Siphons connection periodically for the Dev Fee.
- `WebRandomX/`: WASM compiled RandomX implementation running in the browser.
- `WRXProxy/`: An earlier fallback proxy implementation.
- `Dockerfile`: Runs the simple static browser UI via Nginx.

---

## 🚀 Running the Frontend

The frontend consists of the UI and WebWorkers. You can deploy it using Docker.

1. **Build the Docker container:**
   ```bash
   docker build -t browser-crypto-miner-frontend .
   ```
2. **Run the container:**
   ```bash
   docker run -p 8080:80 browser-crypto-miner-frontend
   ```
3. Visit `http://localhost:8080` in your browser.

---

## 🌉 Setting up the Stratum Bridge & Dev Fee

The Stratum Bridge dynamically links the browser to Monero (`pool.supportxmr.com:3333`) or Bitcoin (`solo.ckpool.org:3333`) mining pools, seamlessly parsing regular HTTP/WS jobs, while automatically intercepting a scheduled 5% "Dev Fee".

1. **Navigate to the bridge directory:**
   ```bash
   cd stratum-bridge
   ```
2. **Install dependencies:**
   ```bash
   npm install
   ```
3. **Configure Settings:**
   Inside `bridge.js`, customize your addresses, host ports, and the dev fee percentage. Note the `CONFIG` object handles the fee cycles (default 5% time interval every 10 minutes).
   ```javascript
   const CONFIG = {
     btcDevFeeAddress: "YOUR_BTC_ADDRESS",
     xmrDevFeeAddress: "YOUR_XMR_ADDRESS",
     devFeePercent: 5, // 5% fee
   };
   ```
4. **Run the Bridge:**
   ```bash
   npm start
   # Or directly
   node bridge.js
   ```

---

## 🛠 Installing and Compiling WebRandomX

To run Monero's RandomX in a browser, the WebRandomX module needs to be prepared. If you need to make changes to the C++ hashing, follow these compilation instructions.

1. **Prerequisites:**
   You will need Docker and CMake to compile the WASM code using the Emscripten SDK.
2. **Navigate to WebRandomX:**
   ```bash
   cd WebRandomX
   ```
3. **Install Dependencies:**
   ```bash
   npm install
   ```
4. **Compile using Docker:**
   ```bash
   docker run --rm -v $(pwd):/src emscripten/emsdk emcc ... (Add your specific compilation params according to the WebRandomX Makefile/CMakeList)
   ```
5. **Pack the JS:**
   WebRandomX uses Webpack to bundle the WASM module for the frontend:
   ```bash
   npx webpack --config webpack/webpack.config.prod.js
   ```
   If you simply want to test, the pre-compiled builds have already been verified working in this repository!
