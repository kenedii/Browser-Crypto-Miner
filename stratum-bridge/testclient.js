// End-to-end test run INSIDE the bridge container: connects to the bridge's
// own WS port (127.0.0.1:8080) which relays to the real BTC pool.
const WebSocket = require('ws');
const ws = new WebSocket('ws://127.0.0.1:8080/?coin=BTC');
let done = false;
const finish = (code, msg) => {
    if (done) return;
    done = true;
    console.log(msg);
    try { ws.close(); } catch (e) {}
    process.exit(code);
};
ws.on('open', () => {
    console.log('WS_OPEN');
    ws.send(JSON.stringify({ id: 1, method: 'mining.subscribe', params: ['web-miner/1.0'] }) + '\n');
    ws.send(JSON.stringify({ id: 2, method: 'mining.authorize', params: ['1Datura3728Ch3cGDiSouKcDB7Cxf9vvb6', 'x'] }) + '\n');
});
ws.on('message', (m) => {
    const s = m.toString();
    console.log('MSG:', s.slice(0, 200));
    if (s.includes('"method":"mining.notify"')) finish(0, 'GOT_JOB_OK');
});
ws.on('error', (e) => finish(1, 'WS_ERR ' + e.message));
setTimeout(() => finish(1, 'TIMEOUT_NO_JOB'), 20000);
