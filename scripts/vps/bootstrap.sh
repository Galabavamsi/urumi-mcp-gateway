#!/usr/bin/env bash
# Runs scripts/vps/bootstrap-k3s.sh on the VPS, over ssh with the host key that provision-aws.sh pinned
# (scripts/vps/common.sh), so even this first connection refuses a machine that is not ours.
#
# Usage (WSL, from the repo root):  VPS_HOST=<elastic-ip> bash scripts/vps/bootstrap.sh
# bootstrap-k3s.sh's optional settings, PUBLIC_IP and NODE_NAME, are passed on from your environment,
# e.g.  NODE_NAME=urumi-vps VPS_HOST=<elastic-ip> bash scripts/vps/bootstrap.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/vps/common.sh
. "$ROOT/scripts/vps/common.sh"

need ssh
remote_env=()
for var in PUBLIC_IP NODE_NAME; do
  # printf %q quotes the value for the remote shell, which parses the command line again.
  [ -z "${!var:-}" ] || remote_env+=("$var=$(printf '%q' "${!var}")")
done
# The script travels on stdin; the remote shell reads it with `bash -s`.
vps_ssh "${remote_env[*]} bash -s" < "$ROOT/scripts/vps/bootstrap-k3s.sh"
