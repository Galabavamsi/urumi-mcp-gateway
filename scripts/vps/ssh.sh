#!/usr/bin/env bash
# A shell on the VPS, or one command, with the same ssh the other scripts use: over Session Manager by
# default, with the pinned host key (scripts/vps/common.sh).
#
# Usage (WSL, from the repo root):
#   bash scripts/vps/ssh.sh                       an interactive shell as ubuntu
#   bash scripts/vps/ssh.sh sudo reboot           one command (here: after a kernel update)
#   VPS_SSH_VIA=direct bash scripts/vps/ssh.sh    straight to port 22 (break-glass: provision-aws.sh allow-my-ip)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/vps/common.sh
. "$ROOT/scripts/vps/common.sh"

need ssh
vps_ssh "$@"
