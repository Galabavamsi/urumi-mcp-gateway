#!/usr/bin/env bash
# Copies a dump from the backup volume to this machine: the off-site copy. The backup volume sits on the
# same disk as the database (k3s local-path), so it does not survive losing that disk or the VM.
#
#   bash scripts/backup/fetch.sh store                   # the newest store dump
#   bash scripts/backup/fetch.sh platform <dump file>    # a specific gateway dump
#
# Options: --context <kube context> (default k3d-urumi, or $KUBE_CONTEXT), -n <namespace>.
# Saves to $BACKUP_DIR/<context>/<namespace>/ (default BACKUP_DIR=~/urumi-backups): outside the repo on
# purpose, because dumps hold customer data and must never be committed. Files are made readable by you
# only. A short-lived helper pod (no network, no database password) mounts the volume read-only; the copy
# is checked against the pod's sha256 before the script says it worked.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

parse_args "$@"
[ ${#ARGS[@]} -ge 1 ] && [ ${#ARGS[@]} -le 2 ] || { usage; exit 1; }

say "fetch a ${ARGS[0]} dump"
use_target "${ARGS[0]}"
start_tools_pod plain
list_dumps | sed 's/^/  /'
FILE=${ARGS[1]:-$(newest_dump)}
[ -n "$FILE" ] || die "there are no dumps on $PVC yet (bash scripts/backup/backup-now.sh $TARGET)"
require_dump "$FILE"

umask 077
dest_dir="${BACKUP_DIR:-$HOME/urumi-backups}/$CONTEXT/$NS"
mkdir -p "$dest_dir"
dest="$dest_dir/$FILE"
info "copying $FILE (taken $(dump_time "$FILE")) to $dest"
# kubectl cp is tar over `kubectl exec`. The path is relative to the pod's working directory (/backups),
# which keeps tar from warning about a leading "/".
k cp -c tools "$TOOLS_POD:$FILE" "$dest"

remote_sum=$(tools_exec sha256sum "/backups/$FILE" | cut -d' ' -f1)
local_sum=$(sha256sum "$dest" | cut -d' ' -f1)
[ "$remote_sum" = "$local_sum" ] || die "checksum mismatch: the copy at $dest is damaged (delete it and retry)"
case $SUFFIX in
  .sql.gz) gzip -t "$dest" || die "$dest is not a valid gzip file" ;;
  .dump) [ "$(head -c 5 "$dest")" = PGDMP ] || die "$dest is not a pg_dump custom-format archive" ;;
esac
info "ok: sha256 $local_sum matches the volume"
ls -l "$dest" | sed 's/^/  /'
