const WebSocket = require('ws');

const wss = new WebSocket('wss://webminer.api.ckenedi.vip/?coin=BTC');
wss.on('open', () => {
    console.log("WS open, sending subscribe");
    wss.send(JSON.stringify({
        id: 1,
        method: "mining.subscribe",
        params: ["web-miner/1.0"]
    }) + "\n");
});
wss.on('message', m => {
    console.log("MSG:", m.toString());
    const msg = JSON.parse(m.toString());
    if (msg.id === 1) {
        wss.send(JSON.stringify({
            id: 2,
            method: "mining.authorize",
            params: ["1Datura3728Ch3cGDiSouKcDB7Cxf9vvb6", "web"]
        }) + "\n");
    }
});
wss.on('close', (c, r) => console.log("CLOSE:", c, r.toString()));
wss.on('error', e => console.error("ERR:", e));