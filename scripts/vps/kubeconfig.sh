#!/usr/bin/env bash
# Fetches the VPS cluster's admin kubeconfig and makes it usable through the SSH tunnel:
#   - copies /etc/rancher/k3s/k3s.yaml over SSH (sudo: the file is root-only, mode 0600)
#   - points it at https://127.0.0.1:16443, the local end of scripts/vps/tunnel.sh (the API server's own
#     address, 127.0.0.1:6443 on the VPS, is never reachable from outside)
#   - renames cluster, user and context from k3s's generic "default" to "urumi-vps"
#   - saves it to ~/.kube/urumi-vps.yaml (mode 600), a file of its own: your main ~/.kube/config (with
#     the local k3d-urumi context) is never edited, so nothing aims at production by accident
# The file holds cluster-admin credentials and is never printed.
#
# Usage (WSL, from the repo root):  VPS_HOST=<elastic-ip> bash scripts/vps/kubeconfig.sh
# Then:  export KUBECONFIG=~/.kube/urumi-vps.yaml    (or pass --kubeconfig/--context urumi-vps to kubectl)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/vps/common.sh
. "$ROOT/scripts/vps/common.sh"

need ssh kubectl
require_vps_host

dir="$(dirname "$KUBECONFIG_FILE")"
mkdir -p "$dir"
chmod 700 "$dir"
tmp="$KUBECONFIG_FILE.partial"
trap 'rm -f "$tmp"' EXIT

step "fetching /etc/rancher/k3s/k3s.yaml from $VPS_HOST"
( umask 077; vps_ssh 'sudo cat /etc/rancher/k3s/k3s.yaml' > "$tmp" )
grep -q '^kind: Config' "$tmp" || die "what came back is not a kubeconfig (is k3s installed? run bootstrap-k3s.sh)"

# k3s writes exactly one cluster, user and context, all named "default", with server https://127.0.0.1:6443.
# The patterns are anchored to those lines, and the result is checked below.
sed -i -E \
  -e "s#^([[:space:]]*server:) https://127\.0\.0\.1:6443\$#\1 https://127.0.0.1:$TUNNEL_PORT#" \
  -e "s#^([[:space:]]*(- )?name:) default\$#\1 $KUBE_CONTEXT#" \
  -e "s#^([[:space:]]*(cluster|user):) default\$#\1 $KUBE_CONTEXT#" \
  -e "s#^current-context: default\$#current-context: $KUBE_CONTEXT#" \
  "$tmp"

server="$(kubectl --kubeconfig "$tmp" config view -o jsonpath='{.clusters[0].cluster.server}')"
contexts="$(kubectl --kubeconfig "$tmp" config get-contexts -o name | tr '\n' ' ')"
current="$(kubectl --kubeconfig "$tmp" config current-context)"
[ "$server" = "https://127.0.0.1:$TUNNEL_PORT" ] && [ "$contexts" = "$KUBE_CONTEXT " ] && [ "$current" = "$KUBE_CONTEXT" ] \
  || die "unexpected kubeconfig layout (server=$server, contexts=$contexts); k3s may have changed its format"

mv "$tmp" "$KUBECONFIG_FILE"
chmod 600 "$KUBECONFIG_FILE"
echo "  saved $KUBECONFIG_FILE (mode 600): context $KUBE_CONTEXT -> $server"

if kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$KUBE_CONTEXT" get --raw /readyz >/dev/null 2>&1; then
  echo "  the tunnel is up and the API answers:"
  kubectl --kubeconfig "$KUBECONFIG_FILE" --context "$KUBE_CONTEXT" get nodes -o wide | sed 's/^/    /'
else
  echo "  next: start the tunnel in another terminal (bash scripts/vps/tunnel.sh), then:"
  echo "    kubectl --kubeconfig $KUBECONFIG_FILE get nodes"
fi
