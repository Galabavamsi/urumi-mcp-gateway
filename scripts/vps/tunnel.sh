#!/usr/bin/env bash
# Keeps an SSH tunnel open from 127.0.0.1:16443 on your machine to the kube API on the VPS
# (127.0.0.1:6443 there). kubectl and helm reach the cluster only through this tunnel: port 6443 is
# never open in the security group, so the API is not exposed to the internet at all, and the tunnel
# itself is authenticated with your SSH key and limited to your IP by the SSH rule.
#
# Usage (WSL, its own terminal; Ctrl-C closes it):  VPS_HOST=<elastic-ip> bash scripts/vps/tunnel.sh
#   -N                 no remote command, forwarding only
#   -L a:b:c:d         listen on 127.0.0.1:16443 here (loopback only, so no one else on your network
#                      can use it) and connect to 127.0.0.1:6443 as seen from the VPS
#   ExitOnForwardFailure  fail at once if 16443 is already taken, instead of a tunnel-less session
#   ServerAlive*       a keepalive every 30 s; after 3 missed answers ssh exits instead of hanging
# If the connection drops (laptop sleep, Wi-Fi change), it reconnects after 5 s until you press Ctrl-C.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/vps/common.sh
. "$ROOT/scripts/vps/common.sh"

need ssh
require_vps_host

trap 'echo; echo "tunnel closed"; exit 0' INT TERM
while true; do
  echo "tunnel: 127.0.0.1:$TUNNEL_PORT -> $VPS_HOST:127.0.0.1:6443 (Ctrl-C to close)"
  ssh "${SSH_OPTS[@]}" -N -o ExitOnForwardFailure=yes \
    -L "127.0.0.1:$TUNNEL_PORT:127.0.0.1:6443" "$VPS_SSH_USER@$VPS_HOST" || true
  echo "tunnel: connection lost; reconnecting in 5 s (did your IP change? provision-aws.sh allow-my-ip)"
  sleep 5
done
