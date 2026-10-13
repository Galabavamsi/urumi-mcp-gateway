# Shared settings and helpers for the scripts in scripts/vps/ that run on YOUR machine (WSL, Linux or macOS).
# Sourced by them, never run on its own. (bootstrap-k3s.sh runs on the VPS itself and stands alone.)
#
# Settings, all overridable from the environment:
#   VPS_HOST         public IP of the VPS (the Elastic IP that `provision-aws.sh up|status` prints)
#   VPS_SSH_KEY      private key for ubuntu@VPS_HOST                    default ~/.ssh/urumi-vps.pem
#   VPS_KNOWN_HOSTS  the VPS's pinned SSH host key (provision-aws.sh)  default <repo>/.vps/known_hosts
#   TUNNEL_PORT      local end of the SSH tunnel to the kube API        default 16443
#   KUBECONFIG_FILE  kubeconfig written by kubeconfig.sh                default ~/.kube/urumi-vps.yaml
#   KUBE_CONTEXT     context every kubectl/helm call is pinned to       default urumi-vps
# shellcheck shell=bash

VPS_SSH_USER=ubuntu
VPS_SSH_KEY="${VPS_SSH_KEY:-$HOME/.ssh/urumi-vps.pem}"
# Inside the repo (gitignored), so Git Bash, where provision-aws.sh writes it, and WSL, where ssh reads it,
# see the same file. A host key is public, not a secret.
VPS_KNOWN_HOSTS="${VPS_KNOWN_HOSTS:-$ROOT/.vps/known_hosts}"
TUNNEL_PORT="${TUNNEL_PORT:-16443}"
KUBECONFIG_FILE="${KUBECONFIG_FILE:-$HOME/.kube/urumi-vps.yaml}"
KUBE_CONTEXT="${KUBE_CONTEXT:-urumi-vps}"
# The laptop's k3d cluster. The VPS scripts refuse to act on it (they install cluster add-ons and
# production values that would break the local http setup).
LOCAL_DEV_CONTEXT=k3d-urumi

step() { printf '\n==> %s\n' "$*"; }
die() { echo "error: $*" >&2; exit 1; }
need() { local tool; for tool in "$@"; do command -v "$tool" >/dev/null || die "$tool not found"; done; }

# --- SSH to the VPS ------------------------------------------------------------------------------
# The host key is pinned, never trusted on first use: provision-aws.sh reads it from the instance's console
# output through the EC2 API and writes VPS_KNOWN_HOSTS. With StrictHostKeyChecking=yes ssh accepts only
# that key, so someone on the network path cannot pose as the VPS, not even on the very first connection
# (which is the one that would hand them the kubeconfig and, through deploy.sh, every Secret).
# The quotes inside the value keep a repo path with spaces in one piece (ssh splits the value on spaces).
SSH_OPTS=(-i "$VPS_SSH_KEY" -o IdentitiesOnly=yes
          -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=\"$VPS_KNOWN_HOSTS\"" -o GlobalKnownHostsFile=/dev/null
          -o ServerAliveInterval=30 -o ServerAliveCountMax=3)

require_vps_host() {
  [ -n "${VPS_HOST:-}" ] || die "set VPS_HOST to the VPS's Elastic IP (scripts/vps/provision-aws.sh status prints it)"
  [ -f "$VPS_SSH_KEY" ] || die "SSH key $VPS_SSH_KEY not found (set VPS_SSH_KEY)"
  [ -f "$VPS_KNOWN_HOSTS" ] || die "no pinned host key in $VPS_KNOWN_HOSTS: run scripts/vps/provision-aws.sh status to pin it"
}

# The arguments are the remote command line (e.g. 'sudo cat /etc/rancher/k3s/k3s.yaml').
# shellcheck disable=SC2029
vps_ssh() { require_vps_host; ssh "${SSH_OPTS[@]}" "$VPS_SSH_USER@$VPS_HOST" "$@"; }

# --- kubectl and helm, pinned to the VPS ----------------------------------------------------------
# Every call names the kubeconfig file and the context explicitly, so whatever context your main
# kubeconfig has selected (e.g. the local k3d-urumi) is never touched by these scripts.
kube() { kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$KUBE_CONTEXT" "$@"; }
helm_vps() { helm --kubeconfig "$KUBECONFIG_FILE" --kube-context "$KUBE_CONTEXT" "$@"; }

# Stops unless KUBE_CONTEXT is a reachable cluster that is not the local dev cluster.
require_vps_cluster() {
  [ "$KUBE_CONTEXT" != "$LOCAL_DEV_CONTEXT" ] \
    || die "refusing to run against $LOCAL_DEV_CONTEXT (the local dev cluster); these scripts are for the VPS"
  [ -f "$KUBECONFIG_FILE" ] || die "$KUBECONFIG_FILE not found (run scripts/vps/kubeconfig.sh first)"
  kube get --raw /readyz >/dev/null 2>&1 \
    || die "the API of context $KUBE_CONTEXT does not answer (is scripts/vps/tunnel.sh running in another terminal?)"
  echo "  cluster: context $KUBE_CONTEXT in $KUBECONFIG_FILE ($(kube get nodes -o name | tr '\n' ' '))"
}

# Runs a command with KUBECONFIG set to a temporary file that holds ONLY KUBE_CONTEXT, as its current
# context. For scripts that act on "the current context" (scripts/secrets.sh): they can then reach the
# VPS and nothing else. The file holds the cluster's credentials, so it lives in a private temp dir
# that is removed afterwards.
with_vps_kubeconfig() {
  local dir rc=0
  dir="$(mktemp -d)"
  chmod 700 "$dir"
  kube config view --minify --flatten > "$dir/config"
  KUBECONFIG="$dir/config" "$@" || rc=$?
  rm -rf "$dir"
  return "$rc"
}

# KEY -> its value from the repo's .env (quotes and trailing comments stripped), empty if missing.
# The same parsing as scripts/secrets.sh, including the CRLF fix for a .env saved on Windows.
env_get() {
  local file="${ENV_FILE:-$ROOT/.env}"
  [ -f "$file" ] || return 0
  # "|| true": a key that is not in the file is just empty. (grep exits 1 when nothing matches, and with
  # pipefail that would stop the calling script.)
  { tr -d '\r' < "$file" | grep -E "^[[:space:]]*$1[[:space:]]*=" || true; } | tail -1 \
    | sed -E 's/^[^=]*=[[:space:]]*//; s/(^|[[:space:]]+)#.*$//; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'
}
