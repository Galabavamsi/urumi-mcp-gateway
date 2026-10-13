#!/usr/bin/env bash
# Restores the gateway database (Postgres: users, API keys, upstream servers and their encrypted
# credentials, tool policies, audit log) from a dump on the backup volume.
#
#   bash scripts/backup/restore-gateway.sh                                  # list the dumps
#   bash scripts/backup/restore-gateway.sh gateway-20261014T204500Z.dump    # restore that one
#
# Options: --context <kube context> (default k3d-urumi, or $KUBE_CONTEXT), -n <namespace> (default platform).
#
# Nothing changes until you type the namespace name. Then, in order:
#   1. stop the writer: deploy/gateway scaled to 0; the postgres-backup CronJob suspended (a nightly
#      dump must not read a half-restored database)
#   2. take a safety dump of the database as it is now (the backup CronJob's own Job, with retention
#      off for that run), so this restore can itself be undone
#   3. drop and recreate the database, then pg_restore the dump in ONE transaction (all of it or
#      nothing). This runs in a helper pod with the backup job's identity: the backup NetworkPolicy is
#      its one way into Postgres
#   4. start the gateway again; it runs its forward migrations at startup, so a dump from an older
#      gateway is brought up to the running version's schema
#
# DATA-LOSS WINDOW. Everything written after the dump was taken is gone, and some of it matters for
# security, so check it after a restore:
#   - API keys REVOKED after the dump work again: revoke them again (dashboard, Members / My API keys)
#   - users disabled or demoted after the dump are back as they were; their sessions too, until they expire
#   - API keys, users, invites, servers and sessions created after the dump are gone (people log in again)
#   - audit rows written after the dump are gone; the safety dump from step 2 still has them
# The MCP endpoint, the API and the chat are down from step 1 until the gateway is Ready (10-30 s).
#
# A dump is only usable with the gateway-internal Secret it was made with: upstream credentials are
# encrypted with its credentials-key, and API keys are checked with its api-key-pepper. The Secret is
# never in the dump (on purpose: a leaked dump leaks no usable credential), so keep a copy of it too.
#
# If a step after 1 fails, the gateway stays stopped on purpose: started against an empty database it
# would migrate a brand-new one and create a fresh first admin. Fix the cause and run this again
# (restoring the safety dump from step 2 if you want the pre-restore state back).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

parse_args "$@"
[ ${#ARGS[@]} -le 1 ] || { usage; exit 1; }

say "restore the gateway database"
use_target platform
start_tools_pod db
list_dumps | sed 's/^/  /'
if [ ${#ARGS[@]} -eq 0 ]; then
  echo; info "pick one and run: bash scripts/backup/restore-gateway.sh <dump file>"
  exit 0
fi
FILE=${ARGS[0]}
require_dump "$FILE"
info "checking $FILE"
tools_exec pg_restore --list "/backups/$FILE" >/dev/null || die "$FILE is not a readable pg_dump archive: pick another dump"

cat <<EOF

  About to REPLACE database '$DB_NAME' in namespace $NS (context $CONTEXT)
  with the dump $FILE, taken $(dump_time "$FILE").

  - Everything written after that time is lost. API keys revoked since then WORK AGAIN: revoke them again.
  - The MCP endpoint, the API and the chat are down until the gateway is Ready again (10-30 s).
  - A safety dump of the current database is taken first, after the gateway stops.
EOF
confirm "$NS"

set_backup_suspended() { # true|false
  k patch cronjob postgres-backup --type=merge -p "{\"spec\":{\"suspend\":$1}}" >/dev/null
}
# If the script stops while the gateway is down, it says how to start it again (by hand, on purpose).
WRITERS_STOPPED=0
resume_hint() {
  cat >&2 <<EOF

The gateway is still stopped. Once database '$DB_NAME' is good again, start it with:
  kubectl --context $CONTEXT -n $NS scale deploy/gateway --replicas=1
  kubectl --context $CONTEXT -n $NS patch cronjob postgres-backup --type=merge -p '{"spec":{"suspend":false}}'
EOF
}
trap 'rc=$?; cleanup; if [ "$rc" != 0 ] && [ "$WRITERS_STOPPED" = 1 ]; then resume_hint; fi' EXIT

# --- 1. stop the writer ---------------------------------------------------------------------------
say "1/4 stopping the gateway"
WRITERS_STOPPED=1
set_backup_suspended true
if k get deploy gateway >/dev/null 2>&1; then
  k scale deploy/gateway --replicas=0 >/dev/null
fi
# The gateway drains on SIGTERM (running tool calls finish, up to its 30 s grace period).
k wait --for=delete pod -l "app.kubernetes.io/name=gateway,app.kubernetes.io/instance=$RELEASE" --timeout=120s >/dev/null
info "gateway scaled to 0; postgres-backup suspended"

# --- 2. safety dump ---------------------------------------------------------------------------------
say "2/4 safety dump of the current database"
run_backup_job BACKUP_KEEP=0   # no retention this run: it must not delete the dump being restored
SAFETY=$DUMP_FILE
info "safety dump: $SAFETY"

# --- 3. restore ---------------------------------------------------------------------------------------
say "3/4 restoring $FILE"
RESTORE=$(cat <<'SH'
set -euo pipefail
# This pod is new: kube-router may need a few more seconds before its allow rule applies.
for _ in $(seq 30); do pg_isready --quiet --timeout=3 && break; sleep 2; done
echo "restore: recreating database $PGDATABASE"
# A database cannot be dropped from inside itself, so these two run in the maintenance database
# "postgres". Drop and recreate rather than restore over the top: tables a newer gateway added after
# the dump must go too. WITH (FORCE) ends any connection still open (the gateway is already stopped).
psql --dbname=postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$PGDATABASE\" WITH (FORCE)" \
  -c "CREATE DATABASE \"$PGDATABASE\""
echo "restore: loading $FILE"
# --single-transaction: all of it or nothing (and it stops at the first error).
# --no-owner: objects belong to the user running the restore (the gateway's user, as before).
pg_restore --dbname="$PGDATABASE" --single-transaction --no-owner "/backups/$FILE"
echo "restore: done, $(psql -Atc "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')") tables in $PGDATABASE"
SH
)
if ! tools_exec env FILE="$FILE" bash -c "$RESTORE" 2>&1 | sed 's/^/    /'; then
  die "the restore failed; the gateway stays stopped. Fix the cause and re-run, or put the previous state back:
       bash scripts/backup/restore-gateway.sh $SAFETY"
fi

# --- 4. start the writer ------------------------------------------------------------------------------
say "4/4 starting the gateway"
# The chart runs exactly one gateway, so it goes back to 1 (also right after an earlier failed run).
if k get deploy gateway >/dev/null 2>&1; then
  k scale deploy/gateway --replicas=1 >/dev/null
fi
set_backup_suspended false
WRITERS_STOPPED=0
if k get deploy gateway >/dev/null 2>&1; then
  info "waiting for the gateway (it runs its migrations, then reports ready)"
  k rollout status deploy/gateway --timeout=5m
fi

say "restored $FILE into $NS/$DB_NAME"
info "safety dump of the state before this restore: $SAFETY"
info "now re-check API keys revoked after $(dump_time "$FILE"): they are valid again"
