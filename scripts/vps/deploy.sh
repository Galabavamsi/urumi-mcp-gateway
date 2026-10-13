#!/usr/bin/env bash
# Deploys (or upgrades) the whole stack on the VPS with the images CI pushed to GHCR:
#   1. checks that ghcr.io/galabavamsi/{wordpress,woo-mcp,supplier-mcp,gateway,dashboard}:<TAG> exist
#   2. namespaces + Secrets (scripts/secrets.sh, aimed at the VPS only; existing Secrets are kept)
#   3. optional: the ghcr-pull Secret, only while the GHCR packages are private (GHCR_PULL_TOKEN)
#   4. helm upgrade --install woo-store, supplier-mcp, platform with the charts' values-prod.yaml
#   5. waits for the TLS certificates, then smoke-tests the public URLs over HTTPS
#
# Usage (WSL, repo root, tunnel running, install-addons.sh done once):
#   bash scripts/vps/deploy.sh                    TAG = the current commit (first 7 hex digits)
#   TAG=1a2b3c4 bash scripts/vps/deploy.sh        a specific commit that CI built
# Settings (environment):
#   TAG              image tag = git commit CI built the images from (default: HEAD, 7 characters)
#   GHCR_PULL_TOKEN  (environment or .env) a GitHub token (classic) with only read:packages, needed only
#                    while the packages are private: stored as Secret ghcr-pull in store, platform and
#                    mcp-upstreams (never printed), and the charts get imagePullSecrets.
#                    GHCR_PULL_USER defaults to galabavamsi.
#   CLUSTER_ISSUER   letsencrypt-prod (values-prod.yaml) | letsencrypt-staging (try the flow first)
#   BASE_DOMAIN      only to deploy under another domain: hosts become store.<d> and app.<d>
#   SKIP_IMAGE_CHECK=1  skip step 1, for a cluster whose images were imported by hand (a test cluster)
#   ENV_FILE         the .env that scripts/secrets.sh reads (default: the repo's .env)
# Targets context urumi-vps (KUBE_CONTEXT / KUBECONFIG_FILE override, see common.sh) and refuses k3d-urumi.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
# shellcheck source=scripts/vps/common.sh
. "$ROOT/scripts/vps/common.sh"

REGISTRY=ghcr.io/galabavamsi
IMAGES=(wordpress woo-mcp supplier-mcp gateway dashboard)
GHCR_PULL_TOKEN="${GHCR_PULL_TOKEN:-$(env_get GHCR_PULL_TOKEN)}"
GHCR_PULL_USER="${GHCR_PULL_USER:-galabavamsi}"
HELM_FLAGS=(--wait --timeout 15m --rollback-on-failure)   # Helm 4 spelling of the old --atomic
NAMESPACES=(store platform mcp-upstreams)

need kubectl helm curl git
require_vps_cluster
if [ -z "${TAG:-}" ]; then
  # CI tags each image with the first 7 hex digits of the commit it was built from (${GITHUB_SHA::7}).
  # `git rev-parse --short` can print more digits when 7 are ambiguous, so cut the full hash instead.
  TAG="$(git rev-parse HEAD)" || die "cannot read the current commit; pass TAG=<commit CI built>"
  TAG="${TAG:0:7}"
fi
[[ "$TAG" =~ ^[0-9a-f]{7,40}$ ]] || die "TAG '$TAG' is not a git commit hash"

# --- 1. Images exist in GHCR ---------------------------------------------------------------------
# GHCR is an OCI registry: ask its token service for a pull token for one repository (anonymous for
# public packages, with GHCR_PULL_TOKEN for private ones), then HEAD /v2/<repo>/manifests/<tag>:
# 200 = the image exists. No docker login, nothing written to disk.
ghcr_has() { # image tag
  local repo="galabavamsi/$1" token
  # A 401/403 from the token service means "no such package, or private without a token": reported below.
  if [ -n "${GHCR_PULL_TOKEN:-}" ]; then
    # The token goes to curl through stdin (-K -), so it never shows up in the process list.
    token="$(printf 'user = "%s:%s"\n' "$GHCR_PULL_USER" "$GHCR_PULL_TOKEN" \
      | curl -fsS -K - "https://ghcr.io/token?scope=repository:$repo:pull&service=ghcr.io" 2>/dev/null)" || return 1
  else
    token="$(curl -fsS "https://ghcr.io/token?scope=repository:$repo:pull&service=ghcr.io" 2>/dev/null)" || return 1
  fi
  token="$(sed -E 's/.*"token":"([^"]+)".*/\1/' <<< "$token")"
  [ "$(curl -sS -o /dev/null -w '%{http_code}' -I \
        -H "Authorization: Bearer $token" \
        -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json' \
        "https://ghcr.io/v2/$repo/manifests/$2")" = 200 ]
}

step "images $REGISTRY/*:$TAG"
if [ "${SKIP_IMAGE_CHECK:-0}" = 1 ]; then
  echo "  skipped (SKIP_IMAGE_CHECK=1): the cluster must already have these images"
else
  missing=()
  for image in "${IMAGES[@]}"; do
    if ghcr_has "$image" "$TAG"; then echo "  = $REGISTRY/$image:$TAG"; else missing+=("$image"); fi
  done
  [ ${#missing[@]} -eq 0 ] || die "not in GHCR for tag $TAG: ${missing[*]}.
       Push the commit and wait for the image workflow (gh run list), or pick a built commit with TAG=<sha>.
       If the packages are private, set GHCR_PULL_TOKEN (a token with read:packages)."
fi

# --- 2. Namespaces and Secrets ---------------------------------------------------------------------
step "namespaces and Secrets (scripts/secrets.sh)"
# secrets.sh acts on "the current context". It gets a kubeconfig that holds only the VPS context, so it
# cannot reach any other cluster, whatever your main kubeconfig has selected.
with_vps_kubeconfig bash scripts/secrets.sh | sed 's/^/  /' \
  || die "scripts/secrets.sh failed. If it stopped without a message: every key it reads must be present
       in .env (an empty value is fine): BOOTSTRAP_ADMIN_EMAIL, BOOTSTRAP_ADMIN_PASSWORD, ANTHROPIC_API_KEY,
       FIRECRAWL_API_KEY, AGENTMAIL_API_KEY"

# --- 3. GHCR pull Secret (private packages only) -------------------------------------------------
# The registry login in the format the kubelet reads (what `docker login` writes to config.json). Built with
# shell builtins and pipes only, so the token never appears in any process's argument list.
docker_config_json() {
  printf '{"auths":{"ghcr.io":{"auth":"%s"}}}' "$(printf '%s:%s' "$GHCR_PULL_USER" "$GHCR_PULL_TOKEN" | base64 | tr -d '\n')"
}

step "GHCR pull Secret"
if [ -n "${GHCR_PULL_TOKEN:-}" ]; then
  for ns in "${NAMESPACES[@]}"; do
    # Server-side apply, like secrets.sh: no last-applied annotation carrying the token.
    docker_config_json \
      | kube -n "$ns" create secret generic ghcr-pull --type=kubernetes.io/dockerconfigjson \
          --from-file=.dockerconfigjson=/dev/stdin --dry-run=client -o yaml \
      | kube apply --server-side --field-manager=urumi-deploy --force-conflicts -f - >/dev/null
    echo "  ~ $ns/ghcr-pull (from GHCR_PULL_TOKEN)"
  done
else
  echo "  GHCR_PULL_TOKEN not set: images are pulled anonymously (public packages)"
fi
# A release gets imagePullSecrets only when the Secret is in its namespace (made now or by an earlier run).
pull_secret_args() { # namespace
  if kube -n "$1" get secret ghcr-pull >/dev/null 2>&1; then
    printf '%s\n' --set 'imagePullSecrets[0].name=ghcr-pull'
  fi
}

# --- 4. Helm releases ------------------------------------------------------------------------------
# Hosts and issuer come from values-prod.yaml; BASE_DOMAIN / CLUSTER_ISSUER override them for a run.
issuer_args=()
if [ -n "${CLUSTER_ISSUER:-}" ]; then
  kube get clusterissuer "$CLUSTER_ISSUER" >/dev/null 2>&1 || die "ClusterIssuer $CLUSTER_ISSUER not found (run install-addons.sh)"
  # The dots inside the annotation key are escaped so Helm does not read them as nesting.
  issuer_args=(--set-string "ingress.annotations.cert-manager\.io/cluster-issuer=$CLUSTER_ISSUER")
fi
store_args=("${issuer_args[@]}")
app_args=("${issuer_args[@]}")
if [ -n "${BASE_DOMAIN:-}" ]; then
  store_args+=(--set-string "ingress.host=store.$BASE_DOMAIN")
  # PUBLIC_BASE_URL must match the app host (the platform chart checks it against cookieSecure too).
  app_args+=(--set-string "ingress.host=app.$BASE_DOMAIN" --set-string "gateway.publicBaseUrl=https://app.$BASE_DOMAIN")
fi

release_status() { helm_vps status "$1" -n "$2" | sed -n 's/^\(REVISION\|STATUS\):/  \1:/p'; }

# No --reuse-values: the values files plus these flags are the whole truth, so a demo toggle set by hand
# earlier (e.g. supplier DEMO_SLOW_TOOL) is reset here, exactly as dev-up.sh does locally.
# --set-string for tags: a short SHA can be all digits, which --set would turn into a number.
step "helm: woo-store (namespace store)"
mapfile -t pull_args < <(pull_secret_args store)
helm_vps upgrade --install woo-store charts/woo-store -n store \
  -f charts/woo-store/values-prod.yaml \
  --set-string wordpress.image.tag="$TAG" --set-string wooMcp.image.tag="$TAG" \
  "${store_args[@]}" "${pull_args[@]}" "${HELM_FLAGS[@]}" >/dev/null
release_status woo-store store

step "helm: supplier-mcp (namespace mcp-upstreams)"
mapfile -t pull_args < <(pull_secret_args mcp-upstreams)
helm_vps upgrade --install supplier-mcp charts/mcp-server -n mcp-upstreams \
  -f charts/mcp-server/values-prod.yaml -f charts/mcp-server/instances/supplier.yaml \
  --set-string image.tag="$TAG" "${pull_args[@]}" "${HELM_FLAGS[@]}" >/dev/null
release_status supplier-mcp mcp-upstreams

# Last: the gateway seeds woo and supplier as upstreams and health-checks them from its first second.
step "helm: platform (namespace platform)"
mapfile -t pull_args < <(pull_secret_args platform)
helm_vps upgrade --install platform charts/platform -n platform \
  -f charts/platform/values-prod.yaml \
  --set-string gateway.image.tag="$TAG" --set-string dashboard.image.tag="$TAG" \
  "${app_args[@]}" "${pull_args[@]}" "${HELM_FLAGS[@]}" >/dev/null
release_status platform platform

# --- 5. Certificates and smoke test -----------------------------------------------------------------
# Everything below is read back from the cluster, so it checks what is actually deployed.
store_host="$(kube -n store get ingress wordpress -o jsonpath='{.spec.rules[0].host}')"
app_host="$(kube -n platform get ingress app -o jsonpath='{.spec.rules[0].host}')"
issuer="$(kube -n store get ingress wordpress -o go-template='{{index .metadata.annotations "cert-manager.io/cluster-issuer"}}')"

# cert-manager names the Certificate after the Ingress's tls.secretName and creates it a moment after the
# Ingress. The first issuance takes 30-90 s (solver pod, self-check, Let's Encrypt's own check);
# renewals then happen in the background, about 30 days before expiry.
wait_certificate() { # namespace ingress
  local ns=$1 cert attempt
  cert="$(kube -n "$ns" get ingress "$2" -o jsonpath='{.spec.tls[0].secretName}')"
  for attempt in $(seq 1 30); do
    kube -n "$ns" get "certificate/$cert" >/dev/null 2>&1 && break
    [ "$attempt" -lt 30 ] || die "no Certificate $ns/$cert: is cert-manager installed (install-addons.sh)?"
    sleep 2
  done
  if ! kube -n "$ns" wait --for=condition=Ready "certificate/$cert" --timeout=5m >/dev/null 2>&1; then
    kube -n "$ns" describe "certificate/$cert" | tail -15 >&2
    die "certificate $ns/$cert is not Ready. Check DNS (provision-aws.sh status) and
       kubectl -n $ns get certificaterequests,orders,challenges; kubectl -n $ns describe challenges"
  fi
  echo "  $ns/$cert Ready, valid until $(kube -n "$ns" get "certificate/$cert" -o jsonpath='{.status.notAfter}')"
}

step "TLS certificates (issuer $issuer)"
wait_certificate store wordpress
wait_certificate platform app

step "smoke test"
curl_tls=()
if [ "$issuer" = letsencrypt-staging ]; then
  # Staging certificates chain to a root no browser or curl trusts; that is their point.
  curl_tls=(--insecure)
  echo "  (staging certificates: TLS verification skipped for this check)"
fi
# Each check is retried for up to a minute: Traefik starts serving a new certificate a few seconds after
# cert-manager writes its Secret (until then it presents its self-signed default and curl refuses it).
check() { # url expected-status-regex [redirect prefix]
  local out code location attempt
  for attempt in $(seq 1 12); do
    out="$(curl -sS "${curl_tls[@]}" -o /dev/null -w '%{http_code} %{redirect_url}' --max-time 20 "$1" 2>/dev/null || true)"
    code="${out%% *}"; location="${out#* }"
    if [[ "$code" =~ ^($2)$ ]] && { [ -z "${3:-}" ] || [[ "$location" == "$3"* ]]; }; then
      echo "  ok    $1 -> $code${3:+ $location}"
      return
    fi
    sleep 5
  done
  echo "  FAIL  $1 -> ${code:-no answer} $location (expected $2${3:+ to $3...}); try: curl -v $1"
  smoke_failed=1
}
smoke_failed=0
# Traefik's HTTP -> HTTPS redirect: permanent, 301 for GET (308 for other methods).
check "http://$store_host/checkout/" '301|308' "https://$store_host/checkout/"
check "https://$store_host/shop/" 200
check "https://$app_host/" 200                # dashboard SPA
check "https://$app_host/api/auth/me" 401     # the gateway answers (no session yet)
[ "$smoke_failed" = 0 ] || die "smoke test failed"

cat <<EOF

Deployed $TAG on $KUBE_CONTEXT.
Store:      https://$store_host/   (wp-admin: user admin; password in Secret store/woo-store-wp, key admin-password)
Dashboard:  https://$app_host/     (first admin: Secret platform/gateway-bootstrap-admin, from .env)
MCP URL:    https://$app_host/mcp  (Authorization: Bearer <API key from the dashboard>)
Releases:   helm --kubeconfig $KUBECONFIG_FILE --kube-context $KUBE_CONTEXT list -A
Roll back:  helm ... rollback <release> <revision> -n <namespace>   (docs/VPS.md)
End-to-end checks against this deployment: docs/VPS.md "Verify"
EOF
