#!/usr/bin/env bash
# Restores the store database (WordPress + WooCommerce on MariaDB) from a dump on the backup volume.
#
#   bash scripts/backup/restore-store.sh                                     # list the dumps
#   bash scripts/backup/restore-store.sh wordpress-20261014T203000Z.sql.gz   # restore that one
#
# Options: --context <kube context> (default k3d-urumi, or $KUBE_CONTEXT), -n <namespace> (default store).
#
# Nothing changes until you type the namespace name. Then, in order:
#   1. stop every writer: deploy/wordpress and deploy/woo-mcp scaled to 0; the wp-cron and
#      mariadb-backup CronJobs suspended (a nightly dump must not read a half-restored database)
#   2. take a safety dump of the database as it is now (the backup CronJob's own Job, with retention
#      off for that run), so this restore can itself be undone
#   3. drop and recreate the database, then load the dump. This runs in a helper pod with the backup
#      job's identity: the backup NetworkPolicy is its one way into MariaDB, and it logs in as the app
#      user, who owns exactly this database (no root password needed)
#   4. start the writers again; WordPress' bootstrap re-runs its migrations, so a dump from an older
#      WooCommerce is brought forward to the version in the running image
#
# DATA-LOSS WINDOW. Everything written after the dump was taken is gone: orders, customers, product and
# setting changes. The storefront is down from step 1 until WordPress is Ready again (1-2 minutes).
# Not in the dump: product images (wp-content/uploads) live on their own volume and are not rolled back.
#
# If a step after 1 fails, the writers stay stopped on purpose: a half-restored database must not serve
# shoppers, and WordPress' bootstrap would "install" a brand-new store into an empty one. Fix the cause
# and run this again (restoring the safety dump from step 2 if you want the pre-restore state back).
#
# Undoing a store UPGRADE (the database was migrated forward, so the old image cannot just come back):
#   1. helm rollback woo-store <revision before the upgrade> -n store --wait
#   2. bash scripts/backup/restore-store.sh <the dump taken before the upgrade>
# In this order, so the old image is what starts against the restored data (the other order would let the
# new image's bootstrap migrate the old dump forward again).
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

parse_args "$@"
[ ${#ARGS[@]} -le 1 ] || { usage; exit 1; }

say "restore the store database"
use_target store
start_tools_pod db
list_dumps | sed 's/^/  /'
if [ ${#ARGS[@]} -eq 0 ]; then
  echo; info "pick one and run: bash scripts/backup/restore-store.sh <dump file>"
  exit 0
fi
FILE=${ARGS[0]}
require_dump "$FILE"
info "checking $FILE"
tools_exec env FILE="$FILE" bash -c 'gzip -t "/backups/$FILE" && gunzip -c "/backups/$FILE" | tail -n 1 | grep -q "^-- Dump completed"' \
  || die "$FILE is damaged or incomplete (gzip error or no closing line): pick another dump"

cat <<EOF

  About to REPLACE database '$DB_NAME' in namespace $NS (context $CONTEXT)
  with the dump $FILE, taken $(dump_time "$FILE").

  - Everything written to the store after that time is lost (orders, customers, product edits).
  - The storefront and woo-mcp are down until WordPress is Ready again (1-2 minutes).
  - Product images (uploads volume) are not rolled back.
  - A safety dump of the current database is taken first, after the writers stop.
EOF
confirm "$NS"

# The writers. wp-cron and woo-mcp can be turned off in the chart, so each is handled only if it exists.
suspend_cronjobs() { # true|false
  local cronjob
  for cronjob in wp-cron mariadb-backup; do
    if k get cronjob "$cronjob" >/dev/null 2>&1; then
      k patch cronjob "$cronjob" --type=merge -p "{\"spec\":{\"suspend\":$1}}" >/dev/null
    fi
  done
}
scale_writers() { # replicas
  local deploy
  for deploy in wordpress woo-mcp; do
    if k get deploy "$deploy" >/dev/null 2>&1; then
      k scale "deploy/$deploy" --replicas="$1" >/dev/null
    fi
  done
}
# If the script stops while the writers are down, it says how to start them again (by hand, on purpose).
WRITERS_STOPPED=0
resume_hint() {
  cat >&2 <<EOF

The writers are still stopped. Once database '$DB_NAME' is good again, start them with:
  kubectl --context $CONTEXT -n $NS scale deploy/wordpress deploy/woo-mcp --replicas=1
  kubectl --context $CONTEXT -n $NS patch cronjob wp-cron --type=merge -p '{"spec":{"suspend":false}}'
  kubectl --context $CONTEXT -n $NS patch cronjob mariadb-backup --type=merge -p '{"spec":{"suspend":false}}'
EOF
}
trap 'rc=$?; cleanup; if [ "$rc" != 0 ] && [ "$WRITERS_STOPPED" = 1 ]; then resume_hint; fi' EXIT

# --- 1. stop the writers --------------------------------------------------------------------------
say "1/4 stopping the writers"
WRITERS_STOPPED=1
suspend_cronjobs true
scale_writers 0
k wait --for=delete pod -l "app.kubernetes.io/name in (wordpress,woo-mcp),app.kubernetes.io/instance=$RELEASE" --timeout=180s >/dev/null
# A wp-cron run already going is allowed to finish (its activeDeadlineSeconds bounds it).
deadline=$(( SECONDS + 300 ))
while [ -n "$(k get cronjob wp-cron -o jsonpath='{.status.active}' 2>/dev/null)" ]; do
  (( SECONDS < deadline )) || die "a wp-cron run is still active; writers are stopped, re-run when it ends"
  sleep 3
done
info "wordpress and woo-mcp scaled to 0; wp-cron and mariadb-backup suspended"

# --- 2. safety dump ---------------------------------------------------------------------------------
say "2/4 safety dump of the current database"
run_backup_job BACKUP_KEEP=0   # no retention this run: it must not delete the dump being restored
SAFETY=$DUMP_FILE
info "safety dump: $SAFETY"

# --- 3. restore ---------------------------------------------------------------------------------------
say "3/4 restoring $FILE"
RESTORE=$(cat <<'SH'
set -euo pipefail
db() { mariadb --host="$DB_HOST" --user="$DB_USER" --default-character-set=utf8mb4 "$@"; }
# This pod is new: kube-router may need a few more seconds before its allow rule applies.
for _ in $(seq 30); do
  mariadb-admin --host="$DB_HOST" --user="$DB_USER" --connect-timeout=3 ping >/dev/null 2>&1 && break
  sleep 2
done
# Drop and recreate rather than load over the top: tables a newer WooCommerce added after the dump must
# go too. The app user's grant is on the database name, so it survives the drop.
echo "restore: recreating database $DB_NAME"
db -e "DROP DATABASE IF EXISTS \`$DB_NAME\`; CREATE DATABASE \`$DB_NAME\`"
echo "restore: loading $FILE"
gunzip -c "/backups/$FILE" | db "$DB_NAME"
echo "restore: done, $(db -N -e "SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = '$DB_NAME'") tables in $DB_NAME"
SH
)
if ! tools_exec env FILE="$FILE" bash -c "$RESTORE" 2>&1 | sed 's/^/    /'; then
  die "the restore failed; the writers stay stopped. Fix the cause and re-run, or put the previous state back:
       bash scripts/backup/restore-store.sh $SAFETY"
fi

# --- 4. start the writers -----------------------------------------------------------------------------
say "4/4 starting the writers"
# The chart runs exactly one of each, so they go back to 1 (also right after an earlier failed run).
scale_writers 1
suspend_cronjobs false
WRITERS_STOPPED=0
info "waiting for WordPress (its bootstrap checks the database and runs any migrations first)"
k rollout status deploy/wordpress --timeout=10m
if k get deploy woo-mcp >/dev/null 2>&1; then
  k rollout status deploy/woo-mcp --timeout=5m
fi

say "restored $FILE into $NS/$DB_NAME"
info "safety dump of the state before this restore: $SAFETY"
info "WordPress bootstrap log: kubectl --context $CONTEXT -n $NS logs deploy/wordpress -c bootstrap"
