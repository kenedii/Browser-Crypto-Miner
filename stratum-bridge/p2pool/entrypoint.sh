#!/bin/sh
# Starts P2Pool in light mode (256 MiB RandomX cache, no 2 GiB dataset) against a
# remote monerod. The stratum port is only reachable on the compose network - the
# bridge connects to it; it is never published to the internet.
set -e
: "${P2POOL_WALLET:?P2POOL_WALLET must be set to a Monero address (default payout; miners normally log in with their own)}"
HOST="${MONERO_NODE_HOST:-p2pmd.xmrvsbeast.com}"
RPC="${MONERO_RPC_PORT:-18081}"
ZMQ="${MONERO_ZMQ_PORT:-18083}"
SIDECHAIN_FLAG="--mini"
[ "${P2POOL_SIDECHAIN:-mini}" = "main" ] && SIDECHAIN_FLAG=""
[ "${P2POOL_SIDECHAIN:-mini}" = "nano" ] && SIDECHAIN_FLAG="--nano"
echo "P2Pool -> monerod ${HOST} (rpc ${RPC}, zmq ${ZMQ}), sidechain ${P2POOL_SIDECHAIN:-mini}"
# shellcheck disable=SC2086
exec ./p2pool --host "$HOST" --rpc-port "$RPC" --zmq-port "$ZMQ" \
  --wallet "$P2POOL_WALLET" $SIDECHAIN_FLAG --light-mode \
  --stratum "0.0.0.0:3333" --no-igd --out-peers 12 --in-peers 12
