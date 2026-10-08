const WebSocket = require('ws');

function test(name, url) {
    return new Promise((resolve) => {
        const ws = new WebSocket(url);
        const result = { name, gotJob: false, closed: null, reason: '' };
        ws.on('open', () => {
            ws.send(JSON.stringify({ id: 1, method: 'mining.subscribe', params: ['web-miner/1.0'] }) + '\n');
            ws.send(JSON.stringify({ id: 2, method: 'mining.authorize', params: ['1Datura3728Ch3cGDiSouKcDB7Cxf9vvb6', 'x'] }) + '\n');
        });
        ws.on('message', (m) => {
            const s = m.toString();
            if (s.includes('mining.notify') || s.includes('set_difficulty')) result.gotJob = true;
        });
        ws.on('close', (c, r) => { result.closed = c; result.reason = r.toString(); resolve(result); });
        ws.on('error', (e) => { result.error = e.message; });
        setTimeout(() => { try { ws.close(); } catch (e) {} resolve(result); }, 15000);
    });
}

(async () => {
    const base = 'wss://stratum.tensors.vip/?coin=BTC';
    console.log('solo:          ', JSON.stringify(await test('solo', base + '&mode=solo')));
    console.log('pplns:         ', JSON.stringify(await test('pplns', base + '&mode=pplns')));
    console.log('custom-blocked:', JSON.stringify(await test('custom', base + '&mode=custom&host=127.0.0.1&port=3333')));
    process.exit(0);
})();
