#!/usr/bin/env bash
# Upgrades and rollback, live: a narrated demo of Helm 4 on the platform release (gateway, dashboard,
# Postgres) and of the safe path for the store release.
#
#   bash scripts/demo/upgrade-rollback.sh             # local k3d cluster (context k3d-urumi)
#   bash scripts/demo/upgrade-rollback.sh --pause     # wait for Enter between steps (for recording)
#
# Options:
#   --context <ctx>   kube context (default k3d-urumi, or $KUBE_CONTEXT)
#   --allow-remote    allow a context that is not k3d-*: this demo deliberately ships a broken release
#   --app-url <url>   the app origin to probe (default http://app.127-0-0-1.sslip.io)
#   --skip-store      only the platform part (a-e)
#   --pause           wait for Enter between steps
#
# The steps:
#   a. helm history of the platform release
#   b. a real, harmless upgrade (the gateway's LOG_LEVEL flips between info and debug): a new revision,
#      rolled out with no failed request (maxUnavailable 0: the new pod is Ready before the old one stops)
#   c. a BAD upgrade (a gateway image tag that does not exist) with --wait --timeout 90s
#      --rollback-on-failure: the new pod never gets Ready, the old one keeps serving, and when the 90 s
#      run out Helm 4 rolls the release back by itself
#   d. helm rollback to the revision the demo started from
#   e. health check and helm history
#   f. the store: back up first, then upgrade (why it differs is explained at that step)
# During b-d it probes the gateway through Traefik: /api/auth/me every second and /mcp every 5 seconds,
# both without credentials, so both must answer 401 (the gateway itself answered; Traefik would say
# 502/503 if no pod were serving). Each /mcp probe is recorded in the audit log as an anonymous
# auth_rejected row: the gateway doing its job (it records at most 60 anonymous rows a minute).
#
# Safe to re-run: both releases end on the configuration they started from (helm history grows by a few
# revisions each run). Step f turns store backups on if they are off, and leaves them on.
# Run inside WSL (kubectl, helm and curl live there), from anywhere in the repo.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

CONTEXT="${KUBE_CONTEXT:-k3d-urumi}"
APP_URL=http://app.127-0-0-1.sslip.io
ALLOW_REMOTE=0 SKIP_STORE=0 PAUSE=0
BAD_TAG=0.0.0-does-not-exist     # passes the chart's tag check (not empty, not "latest"); no such image
HELM_WAIT=(--wait --rollback-on-failure --hide-notes)

die() { echo "error: $*" >&2; exit 1; }
usage() { sed -n '2,/^[^#]/s/^# \{0,1\}//p' "$0"; }
while [ $# -gt 0 ]; do
  case $1 in
    --context) CONTEXT=${2:?}; shift 2 ;;
    --allow-remote) ALLOW_REMOTE=1; shift ;;
    --app-url) APP_URL=${2:?}; shift 2 ;;
    --skip-store) SKIP_STORE=1; shift ;;
    --pause) PAUSE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option $1 (see --help)" ;;
  esac
done

# --- Context guard ------------------------------------------------------------------------------------
# Step c ships a broken release on purpose. Helm recovers by itself, but that is still nothing to try on
# a cluster other people use by accident, so only k3d contexts are allowed unless asked for.
case $CONTEXT in
  k3d-*) ;;
  *) [ "$ALLOW_REMOTE" = 1 ] || die "refusing to run against context '$CONTEXT' (not k3d-*): step c deploys a broken release on purpose. Pass --allow-remote (and --app-url) if you mean it." ;;
esac
for tool in kubectl helm curl; do command -v "$tool" >/dev/null || die "$tool not found"; done
command kubectl config get-contexts "$CONTEXT" >/dev/null 2>&1 || die "no kube context '$CONTEXT'"

# Every kubectl and helm call below is pinned to $CONTEXT by these two wrappers, so the demo never acts on
# whatever cluster kubectl currently points at, and the commands it prints stay short.
kubectl() { command kubectl --context "$CONTEXT" "$@"; }
helm() { command helm --kube-context "$CONTEXT" "$@"; }

# --- Presentation ---------------------------------------------------------------------------------------
say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
note() { printf '  # %s\n' "$@"; }
run() { printf '\n  $ %s\n' "$*"; "$@"; }   # show the exact command, then run it
pause() { if [ "$PAUSE" = 1 ]; then read -r -p "  (Enter to continue) " _ </dev/tty; fi; }
status() { # url [extra curl args...] -> HTTP status code ("000" = no answer at all)
  local url=$1; shift
  curl -s -o /dev/null -w '%{http_code}' --max-time 3 "$@" "$url" || true
}
mcp_status() {
  status "$APP_URL/mcp" -X POST -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
}
revision() { helm status "$1" -n "$2" | sed -n 's/^REVISION: //p'; }
# Before each step: the release must still be where this demo left it. If someone else deployed in the
# meantime, stop rather than roll back over their change.
expect_revision() { # release namespace revision
  local now
  now=$(revision "$1" "$2")
  [ "$now" = "$3" ] || die "release $1 is at revision $now, expected $3: someone else deployed meanwhile; stopping here so their change is not rolled back"
}
gateway_env() { kubectl -n platform get deploy gateway -o jsonpath="{.spec.template.spec.containers[0].env[?(@.name==\"$1\")].value}"; }
gateway_image() { kubectl -n platform get deploy gateway -o jsonpath='{.spec.template.spec.containers[0].image}'; }

# --- Probes: is the gateway answering while Helm works? -------------------------------------------------
PROBE_LOG=$(mktemp)
PROBE_PID=""
start_probes() {
  : > "$PROBE_LOG"
  (
    i=0
    while :; do
      echo "api $(status "$APP_URL/api/auth/me")" >> "$PROBE_LOG"
      if (( i % 5 == 0 )); then echo "mcp $(mcp_status)" >> "$PROBE_LOG"; fi
      i=$(( i + 1 ))
      sleep 1
    done
  ) &
  PROBE_PID=$!
  note "probing $APP_URL/api/auth/me every second and /mcp every 5 s (both must answer 401)"
}
stop_probes() {
  [ -n "$PROBE_PID" ] || return 0
  kill "$PROBE_PID" 2>/dev/null || true
  wait "$PROBE_PID" 2>/dev/null || true
  PROBE_PID=""
  local kind total ok others
  for kind in api mcp; do
    total=$(grep -c "^$kind " "$PROBE_LOG" || true)
    ok=$(grep -c "^$kind 401\$" "$PROBE_LOG" || true)
    others=$(grep "^$kind " "$PROBE_LOG" | grep -v ' 401$' | cut -d' ' -f2 | sort | uniq -c | awk '{ printf " %s x HTTP %s", $1, $2 }' || true)
    printf '  probes %s: %s/%s answered 401%s\n' "$([ "$kind" = api ] && echo /api/auth/me || echo '/mcp        ')" \
      "$ok" "$total" "${others:+  -- NOT OK:$others}"
  done
}
trap 'stop_probes >/dev/null 2>&1; rm -f "$PROBE_LOG"' EXIT

# --- Preflight -------------------------------------------------------------------------------------------
say "Preflight (context $CONTEXT)"
helm status platform -n platform >/dev/null 2>&1 || die "release platform not found in namespace platform"
[ "$(status "$APP_URL/api/auth/me")" = 401 ] || die "the gateway does not answer at $APP_URL (expected 401 from /api/auth/me)"
START_REV=$(revision platform platform)
START_LEVEL=$(gateway_env LOG_LEVEL)
START_IMAGE=$(gateway_image)
note "platform is at revision $START_REV: gateway image $START_IMAGE, LOG_LEVEL=$START_LEVEL"

# --- a. history ------------------------------------------------------------------------------------------
say "a. Every helm install, upgrade and rollback is a numbered revision"
run helm history platform -n platform --max 5
pause

# --- b. a good upgrade -----------------------------------------------------------------------------------
NEW_LEVEL=debug
[ "$START_LEVEL" = debug ] && NEW_LEVEL=info
say "b. A real upgrade: the gateway's LOG_LEVEL $START_LEVEL -> $NEW_LEVEL"
note "--reset-then-reuse-values keeps every value of the deployed revision (image tags included) and" \
     "applies only the --set on top; --wait waits until the new pod is Ready."
expect_revision platform platform "$START_REV"
start_probes
run helm upgrade platform charts/platform -n platform --reset-then-reuse-values \
  --set-string gateway.logLevel="$NEW_LEVEL" "${HELM_WAIT[@]}" --timeout 5m
stop_probes
GOOD_REV=$(revision platform platform)
note "revision $GOOD_REV: LOG_LEVEL is now $(gateway_env LOG_LEVEL), served by a new pod:"
run kubectl -n platform get pods -l app.kubernetes.io/name=gateway
pause

# --- c. a bad upgrade ------------------------------------------------------------------------------------
say "c. A BAD upgrade: gateway image tag '$BAD_TAG' does not exist"
note "The new pod can never pull its image, so it never gets Ready. The Deployment's rolling update" \
     "(maxUnavailable 0) keeps the old pod serving meanwhile. When --timeout runs out, Helm 4's" \
     "--rollback-on-failure (Helm 3 called it --atomic) rolls the release back by itself."
expect_revision platform platform "$GOOD_REV"
start_probes
( sleep 30
  printf '\n  [30 s in] the new pod is stuck, the old one still serves:\n'
  kubectl -n platform get pods -l app.kubernetes.io/name=gateway ) &
peek=$!
started=$SECONDS
if run helm upgrade platform charts/platform -n platform --reset-then-reuse-values \
     --set-string gateway.image.tag="$BAD_TAG" "${HELM_WAIT[@]}" --timeout 90s; then
  die "the broken upgrade was accepted: that should not happen"
fi
wait "$peek" || true
stop_probes
note "Helm gave up after $(( SECONDS - started )) s and rolled back. The broken ReplicaSet is scaled to 0:"
run kubectl -n platform get rs -l app.kubernetes.io/name=gateway
[ "$(gateway_image)" = "$START_IMAGE" ] || die "the gateway image is $(gateway_image), expected $START_IMAGE"
note "gateway image is still $START_IMAGE. The failed try and the automatic rollback are both in history:"
run helm history platform -n platform --max 4
pause

# --- d. rollback -----------------------------------------------------------------------------------------
say "d. Roll back on purpose, to revision $START_REV (where the demo started)"
note "A rollback is a new revision with an old revision's manifests and values. Safe for the gateway:" \
     "its schema changes are expand/contract, so the old code runs on the current schema."
# The failed try is revision GOOD_REV+1 and Helm's automatic rollback GOOD_REV+2.
expect_revision platform platform "$(( GOOD_REV + 2 ))"
start_probes
run helm rollback platform "$START_REV" -n platform --wait --timeout 5m
stop_probes
pause

# --- e. health ---------------------------------------------------------------------------------------------
say "e. Health check"
run kubectl -n platform rollout status deploy/gateway --timeout=2m
run kubectl -n platform get pods
printf '\n  GET  %s/             -> %s (dashboard)\n' "$APP_URL" "$(status "$APP_URL/")"
printf '  GET  %s/api/auth/me  -> %s (gateway API, no session)\n' "$APP_URL" "$(status "$APP_URL/api/auth/me")"
printf '  POST %s/mcp          -> %s (MCP endpoint, no key)\n' "$APP_URL" "$(mcp_status)"
[ "$(status "$APP_URL/")" = 200 ] && [ "$(status "$APP_URL/api/auth/me")" = 401 ] || die "the app is not healthy"
[ "$(gateway_env LOG_LEVEL)" = "$START_LEVEL" ] && [ "$(gateway_image)" = "$START_IMAGE" ] \
  || die "the gateway did not come back to LOG_LEVEL=$START_LEVEL, $START_IMAGE"
note "back to LOG_LEVEL=$START_LEVEL on $START_IMAGE"
run helm history platform -n platform --max 6
pause

[ "$SKIP_STORE" = 1 ] && { say "Done (store part skipped)"; exit 0; }

# --- f. the store ----------------------------------------------------------------------------------------
# Why the store is different. A new WordPress/WooCommerce image migrates the DATABASE when its pod
# starts (the bootstrap runs `wp core update-db` and `wp wc update`), and those migrations only go
# forward: old code on a migrated schema is not supported. `helm rollback` puts back Kubernetes objects
# (the old image tag), never data. So a store upgrade is:
#   1. back up (scripts/backup/backup-now.sh store)  2. upgrade
# and undoing one is: helm rollback to the old image, then scripts/backup/restore-store.sh <that dump>.
# A store upgrade that does not change the WordPress image (woo-mcp, resources, policies) migrates
# nothing and rolls back freely; the demo checks exactly that before it rolls back.
say "f. The store release: back up first, then upgrade"
note "A new WordPress/WooCommerce image migrates the database on start, and those migrations only go" \
     "forward; helm rollback restores Kubernetes objects, never data. So: back up, then upgrade."
if ! kubectl -n store get cronjob mariadb-backup >/dev/null 2>&1; then
  note "Backups are off in this release. Turning them on is itself a safe upgrade: it adds a CronJob," \
       "a volume, a one-shot volume check and two NetworkPolicies, and changes no image."
  run helm upgrade woo-store charts/woo-store -n store --reset-then-reuse-values \
    --set backup.enabled=true "${HELM_WAIT[@]}" --timeout 5m
fi
STORE_REV=$(revision woo-store store)
wp_image() { kubectl -n store get deploy wordpress -o jsonpath='{.spec.template.spec.containers[0].image}'; }
WP_IMAGE=$(wp_image)
MCP_LEVEL=$(kubectl -n store get deploy woo-mcp -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="LOG_LEVEL")].value}')
MCP_NEW=debug
[ "$MCP_LEVEL" = debug ] && MCP_NEW=info
pause

say "f1. Back up the store database first"
run bash scripts/backup/backup-now.sh store --context "$CONTEXT"
pause

say "f2. Then upgrade"
note "For a real release this is --set-string wordpress.image.tag=<new git sha>. Here it is a harmless" \
     "change (woo-mcp's LOG_LEVEL $MCP_LEVEL -> $MCP_NEW); the order is the point."
expect_revision woo-store store "$STORE_REV"
run helm upgrade woo-store charts/woo-store -n store --reset-then-reuse-values \
  --set-string wooMcp.logLevel="$MCP_NEW" "${HELM_WAIT[@]}" --timeout 10m
pause

say "f3. Undo it, the safe way"
expect_revision woo-store store "$(( STORE_REV + 1 ))"
if [ "$(wp_image)" = "$WP_IMAGE" ]; then
  note "The WordPress image did not change ($WP_IMAGE), so no migration ran: helm rollback alone is safe."
  run helm rollback woo-store "$STORE_REV" -n store --wait --timeout 10m
else
  note "The WordPress image changed: a plain rollback would run old code on a migrated database. Undo with" \
       "  helm rollback woo-store $STORE_REV -n store --wait" \
       "  bash scripts/backup/restore-store.sh <the dump from f1>"
fi
run helm history woo-store -n store --max 4

say "Done: platform back on revision $START_REV's configuration, store on revision $STORE_REV's"
note "store backups are on (CronJob mariadb-backup, volume mariadb-backups). To turn them off again:" \
     "helm upgrade woo-store charts/woo-store -n store --reset-then-reuse-values --set backup.enabled=false --wait" \
     "(the volume and its dumps are kept; delete PVC mariadb-backups to wipe them)"
