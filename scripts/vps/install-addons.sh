#!/usr/bin/env bash
# One-time cluster setup on the VPS, safe to re-run (each step changes only what differs):
#   1. namespaces store, platform, mcp-upstreams with their Pod Security labels (cluster/namespaces.yaml,
#      the same file the local cluster uses)
#   2. cert-manager v1.21.2 from its OCI Helm chart, CRDs included (values: cluster/cert-manager/values.yaml),
#      in namespace cert-manager with Pod Security "restricted" enforced
#   3. the Let's Encrypt ClusterIssuers letsencrypt-staging and letsencrypt-prod
#      (cluster/cert-manager/cluster-issuers.yaml; the email line comes from ACME_EMAIL, see that file)
#   4. Traefik: every plain-HTTP request is redirected to HTTPS (cluster/traefik-prod.yaml). The ACME
#      HTTP-01 challenge keeps working through the redirect; cluster-issuers.yaml explains why.
#
# Usage (WSL, repo root, with scripts/vps/tunnel.sh running in another terminal):
#   bash scripts/vps/install-addons.sh               ACME_EMAIL from the environment or .env (optional)
# Targets context urumi-vps in ~/.kube/urumi-vps.yaml (KUBE_CONTEXT / KUBECONFIG_FILE override, see
# scripts/vps/common.sh) and refuses the local k3d-urumi cluster.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/vps/common.sh
. "$ROOT/scripts/vps/common.sh"

CERT_MANAGER_VERSION=v1.21.2
CERT_MANAGER_CHART=oci://quay.io/jetstack/charts/cert-manager
HELM_FLAGS=(--wait --timeout 10m --rollback-on-failure)   # Helm 4 spelling of the old --atomic

need kubectl helm envsubst
require_vps_cluster

# --- 1. Namespaces -------------------------------------------------------------------------------
step "namespaces"
kube apply -f cluster/namespaces.yaml | sed 's/^/  /'

# --- 2. cert-manager -----------------------------------------------------------------------------
step "cert-manager $CERT_MANAGER_VERSION"
# Created here (not by Helm's --create-namespace) so it carries a Pod Security label like ours. cert-manager's
# pods all meet the "restricted" profile, so it can be enforced, not just warned about.
kube create namespace cert-manager --dry-run=client -o yaml | kube apply -f - >/dev/null
kube label namespace cert-manager --overwrite \
  app.kubernetes.io/part-of=urumi \
  pod-security.kubernetes.io/enforce=restricted \
  pod-security.kubernetes.io/warn=restricted \
  pod-security.kubernetes.io/audit=restricted >/dev/null
helm_vps upgrade --install cert-manager "$CERT_MANAGER_CHART" --version "$CERT_MANAGER_VERSION" \
  -n cert-manager -f cluster/cert-manager/values.yaml "${HELM_FLAGS[@]}" >/dev/null
helm_vps status cert-manager -n cert-manager | sed -n 's/^\(REVISION\|STATUS\):/  \1:/p'
kube -n cert-manager get deploy -o custom-columns='DEPLOYMENT:.metadata.name,READY:.status.readyReplicas,IMAGE:.spec.template.spec.containers[0].image' \
  | sed 's/^/  /'

# --- 3. ClusterIssuers ---------------------------------------------------------------------------
step "Let's Encrypt ClusterIssuers"
ACME_EMAIL="${ACME_EMAIL:-$(env_get ACME_EMAIL)}"
if [ -n "$ACME_EMAIL" ]; then
  # Checked before it goes into YAML: one address, no quotes, spaces or other YAML/shell specials.
  [[ "$ACME_EMAIL" =~ ^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]] || die "ACME_EMAIL '$ACME_EMAIL' does not look like an email address"
  # envsubst with an explicit variable list replaces ${ACME_EMAIL} and nothing else. (Single quotes on
  # purpose: the literal text ${ACME_EMAIL} is the argument.)
  # shellcheck disable=SC2016
  issuers="$(ACME_EMAIL="$ACME_EMAIL" envsubst '${ACME_EMAIL}' < cluster/cert-manager/cluster-issuers.yaml)"
  echo "  ACME account email: set (from ACME_EMAIL)"
else
  # shellcheck disable=SC2016
  issuers="$(grep -v 'email: "${ACME_EMAIL}"' cluster/cert-manager/cluster-issuers.yaml)"
  echo "  ACME account email: none (optional; set ACME_EMAIL to add one)"
fi
printf '%s\n' "$issuers" | kube apply -f - | sed 's/^/  /'
# Ready = cert-manager registered (or found) the ACME account at Let's Encrypt.
kube wait --for=condition=Ready clusterissuer/letsencrypt-staging clusterissuer/letsencrypt-prod --timeout=180s \
  | sed 's/^/  /'

# --- 4. Traefik: HTTP -> HTTPS -------------------------------------------------------------------
step "Traefik: redirect HTTP to HTTPS"
kube apply -f cluster/traefik-prod.yaml | sed 's/^/  /'
# k3s's helm-controller re-renders its bundled Traefik chart with these values; wait until the running
# Deployment has the redirect, then until it has rolled out.
for attempt in $(seq 1 60); do
  if kube -n kube-system get deploy traefik -o jsonpath='{.spec.template.spec.containers[0].args}' \
       | grep -q 'redirections.entryPoint.to'; then
    break
  fi
  [ "$attempt" -lt 60 ] || die "Traefik did not pick up cluster/traefik-prod.yaml within 3 minutes (kubectl -n kube-system get jobs,pods)"
  sleep 3
done
kube -n kube-system rollout status deploy/traefik --timeout=300s | sed 's/^/  /'

cat <<EOF

Add-ons ready on $KUBE_CONTEXT. Next: bash scripts/vps/deploy.sh   (docs/VPS.md)
EOF
