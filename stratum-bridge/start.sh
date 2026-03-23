#!/bin/bash

echo "Starting P2Pool node..."

# Using a public Monero remote node that supports ZMQ (this may need to be updated with a reliable node)
# Note: P2Pool requires a very reliable connection. If this node drops, P2Pool will pause.
P2POOL_HOST=${P2POOL_MONEROD_HOST:-"node.moneromine.co"}
P2POOL_RPC_PORT=${P2POOL_MONEROD_RPC_PORT:-28081}
P2POOL_ZMQ_PORT=${P2POOL_MONEROD_ZMQ_PORT:-28082}

# Default p2pool pool stratum port
P2POOL_STRATUM_PORT=${P2POOL_PORT:-3335}

# Wallet address where P2Pool payouts go
# Note: P2Pool requires a wallet address to be started, you can override with P2POOL_WALLET env var
P2POOL_WALLET=${P2POOL_WALLET:-"45sDBs39VzdK9af7h2v2heDk9TaKSHVPyRjrCLa9esnyEKweRvi1Rj9NwgxP9MaMCFh6gak3XSY85GHULXLm63WiSWHyRLB"}

# Start p2pool in the background
# Using --mini for the p2pool-mini sidechain which is better for small hashrates (web miners)
p2pool --host $P2POOL_HOST --rpc-port $P2POOL_RPC_PORT --zmq-port $P2POOL_ZMQ_PORT --wallet $P2POOL_WALLET --stratum 127.0.0.1:$P2POOL_STRATUM_PORT --mini &
P2POOL_PID=$!

echo "Starting Node.js Stratum Bridge..."
npm start

# Keep script running as long as npm start is running
kill $P2POOL_PID
