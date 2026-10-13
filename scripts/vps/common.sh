# Shared settings and helpers for the scripts in scripts/vps/ that run on YOUR machine (WSL, Linux or macOS).
# Sourced by them, never run on its own. (bootstrap-k3s.sh runs on the VPS itself and stands alone.)
#
# Settings, all overridable from the environment:
#   VPS_HOST         public IP of the VPS (the Elastic IP that `provision-aws.sh up|status` prints)
#   VPS_SSH_KEY      private key for ubuntu@VPS_HOST                    default ~/.ssh/urumi-vps.pem
#   TUNNEL_PORT      local end of the SSH tunnel to the kube API        default 16443
#   KUBECONFIG_FILE  kubeconfig written by kubeconfig.sh                default ~/.kube/urumi-vps.yaml
#   KUBE_CONTEXT     context every kubectl/helm call is pinned to       default urumi-vps
# shellcheck shell=bash

VPS_SSH_USER=ubuntu
VPS_SSH_KEY="${VPS_SSH_KEY:-$HOME/.ssh/urumi-vps.pem}"
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
# accept-new: the first connection records the host key in ~/.ssh/known_hosts, later ones must match it.
# (After re-creating the instance behind the same Elastic IP, remove the old key: ssh-keygen -R <ip>.)
SSH_OPTS=(-i "$VPS_SSH_KEY" -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new
          -o ServerAliveInterval=30 -o ServerAliveCountMax=3)

require_vps_host() {
  [ -n "${VPS_HOST:-}" ] || die "set VPS_HOST to the VPS's Elastic IP (scripts/vps/provision-aws.sh status prints it)"
  [ -f "$VPS_SSH_KEY" ] || die "SSH key $VPS_SSH_KEY not found (set VPS_SSH_KEY)"
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
