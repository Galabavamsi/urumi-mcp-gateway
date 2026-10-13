#!/usr/bin/env bash
# Brings the whole local stack up on the k3d cluster, from nothing or from any earlier state.
# Safe to re-run: every step checks before it acts, and Helm only changes what differs.
#
#   1. k3d cluster "urumi" (cluster/k3d-local.yaml): create it, or start it if it is stopped
#   2. namespaces + Secrets (scripts/secrets.sh; existing Secrets are kept)
#   3. build the five images, tagged with the git commit, and load them into the cluster
#   4. helm upgrade --install woo-store (WordPress + MariaDB + woo-mcp), supplier-mcp and platform
#      (gateway + dashboard + Postgres)
#   5. print the URLs and check that the storefront and the dashboard answer through Traefik
#
# Run inside WSL Ubuntu (Docker, k3d, kubectl and helm live there), from anywhere in the repo:
#   bash scripts/dev-up.sh
# From Windows:  wsl.exe -d Ubuntu -- bash /mnt/<drive>/<path-to-repo>/scripts/dev-up.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CLUSTER=urumi
CONTEXT="k3d-$CLUSTER"
STORE_HOST=store.127-0-0-1.sslip.io
APP_HOST=app.127-0-0-1.sslip.io
# --rollback-on-failure is Helm 4's spelling of the old --atomic. --wait-for-jobs: without it Helm 4's --wait
# counts a Job as ready once it has started (the backup-volume check, when backups are on).
HELM_FLAGS=(--wait --wait-for-jobs --timeout 10m --rollback-on-failure)

step() { printf '\n==> %s\n' "$*"; }
die() { echo "error: $*" >&2; exit 1; }

for tool in docker k3d kubectl helm git curl; do
  command -v "$tool" >/dev/null || die "$tool not found (run scripts/setup-wsl-docker.sh first)"
done
# Checked now, not at step 4: Helm 3 has no --rollback-on-failure and would fail only after the image builds.
helm_version="$(helm version --template '{{.Version}}')"
case $helm_version in
  v4.*) ;;
  *) die "Helm 4 is required (found $helm_version): these scripts use Helm 4's --rollback-on-failure" ;;
esac
if ! docker_out="$(docker info 2>&1)"; then
  case $docker_out in
    *'permission denied'*)
      die "no access to the Docker socket: your user is not in the docker group yet (log out and back in;
       on WSL run 'wsl --shutdown' from Windows once)" ;;
    *) die "the Docker daemon is not running (sudo systemctl start docker)" ;;
  esac
fi

# --- 1. Cluster ----------------------------------------------------------------------------------
step "k3d cluster $CLUSTER"
if ! k3d cluster get "$CLUSTER" >/dev/null 2>&1; then
  k3d cluster create --config cluster/k3d-local.yaml
elif [ "$(docker inspect -f '{{.State.Running}}' "k3d-$CLUSTER-server-0" 2>/dev/null)" != "true" ]; then
  k3d cluster start "$CLUSTER"
else
  echo "  already running"
fi
kubectl config use-context "$CONTEXT" >/dev/null
kubectl wait --for=condition=Ready node --all --timeout=180s >/dev/null
echo "  node Ready (context $CONTEXT)"

# --- 2. Namespaces and Secrets -------------------------------------------------------------------
step "namespaces and Secrets"
bash scripts/secrets.sh

# --- 3. Images -----------------------------------------------------------------------------------
# Tag = the commit the images were built from, so `kubectl get pod -o yaml` tells you which code
# runs. If the image sources have uncommitted changes, append "-dirty-<hash of those changes>":
# a new edit gives a new tag, so Helm sees a changed pod spec and rolls the pods. (Re-using one tag
# for different bytes would leave the old pods running, because the spec would not change.)
IMAGE_SOURCES=(apps packages images docker scripts/build-app.mjs
               package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json)
TAG="$(git rev-parse --short HEAD)"
if [ -n "$(git status --porcelain -- "${IMAGE_SOURCES[@]}")" ]; then
  changes_hash="$( { git diff HEAD -- "${IMAGE_SOURCES[@]}"
                     git ls-files --others --exclude-standard -z -- "${IMAGE_SOURCES[@]}" \
                       | xargs -0 -r sha1sum; } | sha1sum | cut -c1-7 )"
  TAG="$TAG-dirty-$changes_hash"
fi
step "images (tag $TAG)"

# --network=host: WSL's eth0 has MTU 1280 but Docker's bridge uses 1500, so large downloads inside a
# bridged build (npm tarballs, plugin zips) get reset. The host network uses the right MTU.
# Registry hiccups happen on this link too, so a failed build is retried twice (the cache keeps the
# finished layers, so a retry only redoes what failed).
build() { # image-name, then docker build args
  local image=$1; shift
  if docker image inspect "$image" >/dev/null 2>&1; then
    echo "  = $image (already built)"
    return
  fi
  local attempt
  for attempt in 1 2 3; do
    if docker build --network=host -t "$image" "$@"; then
      echo "  + $image (built)"
      return
    fi
    echo "  ! build of $image failed (attempt $attempt of 3)" >&2
    sleep 5
  done
  die "could not build $image"
}

# k3s runs containerd inside the node container, with its own image store; import copies the image
# there. Skipped when the node already has this exact tag.
load() { # image-name
  local image=$1
  if docker exec "k3d-$CLUSTER-server-0" crictl inspecti "docker.io/$image" >/dev/null 2>&1; then
    echo "  = $image (already in the cluster)"
  else
    k3d image import "$image" -c "$CLUSTER" >/dev/null
    echo "  + $image (imported into the cluster)"
  fi
}

# The WordPress image's build context is its own folder (the repo .dockerignore excludes images/).
build "urumi/wordpress:$TAG" images/wordpress
build "urumi/woo-mcp:$TAG" -f docker/node-service.Dockerfile --build-arg APP=woo-mcp .
build "urumi/supplier-mcp:$TAG" -f docker/node-service.Dockerfile --build-arg APP=supplier-mcp .
build "urumi/gateway:$TAG" -f docker/node-service.Dockerfile --build-arg APP=gateway .
build "urumi/dashboard:$TAG" -f docker/dashboard.Dockerfile .
for image in "urumi/wordpress:$TAG" "urumi/woo-mcp:$TAG" "urumi/supplier-mcp:$TAG" \
             "urumi/gateway:$TAG" "urumi/dashboard:$TAG"; do
  load "$image"
done

# --- 4. Helm releases ----------------------------------------------------------------------------
# No --reuse-values: the values files are the whole truth, so a demo toggle set by hand earlier
# (e.g. supplier DEMO_SLOW_TOOL) is reset to its file value here.
step "helm: woo-store (namespace store)"
# --set-string, not --set: a short SHA can be all digits (e.g. 1234567), which --set would turn into a number.
helm upgrade --install woo-store charts/woo-store -n store \
  -f charts/woo-store/values-local.yaml \
  --set-string wordpress.image.tag="$TAG" --set-string wooMcp.image.tag="$TAG" \
  "${HELM_FLAGS[@]}" >/dev/null
helm status woo-store -n store | sed -n 's/^\(REVISION\|STATUS\):/  \1:/p'

step "helm: supplier-mcp (namespace mcp-upstreams)"
helm upgrade --install supplier-mcp charts/mcp-server -n mcp-upstreams \
  -f charts/mcp-server/values-local.yaml -f charts/mcp-server/instances/supplier.yaml \
  --set-string image.tag="$TAG" \
  "${HELM_FLAGS[@]}" >/dev/null
helm status supplier-mcp -n mcp-upstreams | sed -n 's/^\(REVISION\|STATUS\):/  \1:/p'

# Installed last: the gateway seeds woo and supplier as upstreams and health-checks them from its
# first second, so they should already be up (it copes if they are not; they just show Unreachable).
step "helm: platform (namespace platform: gateway, dashboard, Postgres)"
helm upgrade --install platform charts/platform -n platform \
  -f charts/platform/values-local.yaml \
  --set-string gateway.image.tag="$TAG" --set-string dashboard.image.tag="$TAG" \
  "${HELM_FLAGS[@]}" >/dev/null
helm status platform -n platform | sed -n 's/^\(REVISION\|STATUS\):/  \1:/p'

# --- 5. Done -------------------------------------------------------------------------------------
step "check"
check() { # url, expected HTTP status
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$1" || true)"
  echo "  GET $1 -> $code"
  [ "$code" = "$2" ] || die "expected $2 from $1 through Traefik"
}
check "http://$STORE_HOST/shop/" 200
check "http://$APP_HOST/" 200            # dashboard SPA (nginx)
check "http://$APP_HOST/api/auth/me" 401 # gateway REST API answers (no session yet)

cat <<EOF

Store:      http://$STORE_HOST/
Shop:       http://$STORE_HOST/shop/
wp-admin:   http://$STORE_HOST/wp-admin/   (user admin; password: Secret store/woo-store-wp, key admin-password)
Dashboard:  http://$APP_HOST/   (first admin: Secret platform/gateway-bootstrap-admin, from .env)
MCP URL:    http://$APP_HOST/mcp   (Authorization: Bearer <API key from the dashboard>)
woo-mcp:      http://woo-mcp.store.svc.cluster.local:8080/mcp            (gateway pods only)
supplier-mcp: http://supplier-mcp.mcp-upstreams.svc.cluster.local:8080/mcp (gateway pods only)
Images:     urumi/{wordpress,woo-mcp,supplier-mcp,gateway,dashboard}:$TAG

End-to-end checks (from Windows, repo root):
  node scripts/e2e-store.mjs   (store layer)
  node scripts/e2e-dod.mjs     (the brief's Definition of Done, two users, real chat)
EOF
