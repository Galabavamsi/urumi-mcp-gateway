#!/usr/bin/env bash
# Takes a backup now, outside the nightly schedule: runs the backup CronJob's Job immediately
# (kubectl create job --from=cronjob/...), waits for it, and shows its log, which ends with the list
# of dumps on the backup volume. Run it before every store upgrade.
#
#   bash scripts/backup/backup-now.sh store       # MariaDB of the WooCommerce store (namespace store)
#   bash scripts/backup/backup-now.sh platform    # Postgres of the gateway (namespace platform)
#   bash scripts/backup/backup-now.sh all         # both
#
# Options: --context <kube context> (default k3d-urumi, or $KUBE_CONTEXT), -n <namespace> (one target only).
# Needs backup.enabled=true on the release. Run inside WSL (or wherever kubectl is), from anywhere.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

parse_args "$@"
[ ${#ARGS[@]} -eq 1 ] || { usage; exit 1; }

targets=("${ARGS[0]}")
if [ "${ARGS[0]}" = all ]; then
  [ -z "$NS" ] || die "-n/--namespace works with one target only"
  targets=(store platform)
fi

for target in "${targets[@]}"; do
  NS_GIVEN=$NS
  say "backup of $target"
  use_target "$target"
  run_backup_job
  info "done: $DUMP_FILE"
  NS=$NS_GIVEN   # the next target starts from its own default namespace
done
