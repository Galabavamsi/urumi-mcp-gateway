# Shared by scripts/backup/*.sh (sourced, never run on its own).
# shellcheck shell=bash
#
# Each script works on one "target":
#   store     namespace store,    CronJob mariadb-backup   (charts/woo-store with backup.enabled=true)
#   platform  namespace platform, CronJob postgres-backup  (charts/platform with backup.enabled=true)
# Everything else the scripts need (release, image, user, volume, Secret, database name) is read back
# from that CronJob, so the scripts can never drift from what the chart deployed.
#
# Every kubectl call names its context (default k3d-urumi; --context or KUBE_CONTEXT to change it), so a
# script never acts on whichever cluster kubectl happens to point at. Secret values are never printed:
# pods get them through secretKeyRef, exactly like the backup CronJob.
set -euo pipefail

CONTEXT="${KUBE_CONTEXT:-k3d-urumi}"
NS=""          # --namespace, else the target's default
ARGS=()        # positional arguments left after parse_args
TOOLS_POD=""   # the helper pod, deleted again when the script exits

say() { printf '\n==> %s\n' "$*"; }
info() { printf '  %s\n' "$*"; }
die() { echo "error: $*" >&2; exit 1; }
k() { kubectl --context "$CONTEXT" -n "$NS" "$@"; }

# --help: the calling script's header comment.
usage() { sed -n '2,/^[^#]/s/^# \{0,1\}//p' "$0"; }

# The options every script takes.
parse_args() {
  while [ $# -gt 0 ]; do
    case $1 in
      --context) CONTEXT=${2:?--context needs a value}; shift 2 ;;
      -n|--namespace) NS=${2:?--namespace needs a value}; shift 2 ;;
      -h|--help) usage; exit 0 ;;
      -*) die "unknown option $1 (see --help)" ;;
      *) ARGS+=("$1"); shift ;;
    esac
  done
}

# cj <path>: a field of the CronJob's pod template, e.g. cj '.spec.containers[0].image'.
cj() { k get cronjob "$CRONJOB" -o jsonpath="{.spec.jobTemplate.spec.template$1}"; }

# use_target store|platform: checks the cluster and reads the backup's settings from its CronJob.
use_target() {
  TARGET=$1
  case $TARGET in
    store)    CRONJOB=mariadb-backup;  NS=${NS:-store};    DB_VAR=DB_NAME;    SUFFIX=.sql.gz ;;
    platform) CRONJOB=postgres-backup; NS=${NS:-platform}; DB_VAR=PGDATABASE; SUFFIX=.dump ;;
    *) die "unknown target '$TARGET' (store or platform)" ;;
  esac
  kubectl config get-contexts "$CONTEXT" >/dev/null 2>&1 \
    || die "no kube context '$CONTEXT' (pass --context, or set KUBE_CONTEXT)"
  k get cronjob "$CRONJOB" >/dev/null 2>&1 \
    || die "no CronJob $CRONJOB in namespace $NS (context $CONTEXT): backups are off for this release; turn them on with
       helm upgrade <release> <chart> -n $NS --reset-then-reuse-values --set backup.enabled=true --wait --wait-for-jobs"
  RELEASE=$(cj '.metadata.labels.app\.kubernetes\.io/instance')
  DB_NAME=$(cj ".spec.containers[0].env[?(@.name==\"$DB_VAR\")].value")
  PVC=$(cj '.spec.volumes[?(@.name=="backups")].persistentVolumeClaim.claimName')
  [ -n "$RELEASE" ] && [ -n "$DB_NAME" ] && [ -n "$PVC" ] || die "could not read the CronJob $NS/$CRONJOB"
  info "context $CONTEXT, namespace $NS, release $RELEASE, database $DB_NAME, volume $PVC"
}

# require_dump <file>: a plain file name of this target's dumps (no paths, no other database's dump),
# and the file is on the volume (needs the helper pod).
require_dump() {
  local re="^${DB_NAME}-[0-9]{8}T[0-9]{6}Z${SUFFIX//./\\.}\$"
  [[ $1 =~ $re ]] || die "'$1' is not a dump name of this database (expected $DB_NAME-YYYYMMDDTHHMMSSZ$SUFFIX)"
  tools_exec test -f "/backups/$1" 2>/dev/null || die "$1 is not on the volume $PVC"
}

# dump_time <file>: when the dump was taken, from its name (UTC), as "YYYY-MM-DD HH:MM:SS UTC (N min ago)".
dump_time() {
  local ts=${1#"$DB_NAME"-} epoch
  ts=${ts%"$SUFFIX"}
  epoch=$(date -u -d "${ts:0:4}-${ts:4:2}-${ts:6:2}T${ts:9:2}:${ts:11:2}:${ts:13:2}Z" +%s)
  printf '%s (%s min ago)' "$(date -u -d "@$epoch" '+%Y-%m-%d %H:%M:%S UTC')" "$(( ($(date +%s) - epoch) / 60 ))"
}

# run_backup_job [VAR=value ...]: runs the CronJob's Job now and waits for it; sets DUMP_FILE.
# With arguments, those env vars are changed for this one run (e.g. BACKUP_KEEP=0: no retention): the
# Job is built from the CronJob locally, edited with `kubectl set env --local`, then created.
run_backup_job() {
  local job logs state="" limit deadline
  job="$CRONJOB-manual-$(date -u +%Y%m%d-%H%M%S)"
  if [ $# -gt 0 ]; then
    k create job "$job" --from="cronjob/$CRONJOB" --dry-run=client -o yaml \
      | kubectl set env --local -f - "$@" -o yaml \
      | k create -f - >/dev/null
  else
    k create job "$job" --from="cronjob/$CRONJOB" >/dev/null
  fi
  info "job $job started${1:+ (with $*)}"
  # Wait as long as Kubernetes lets the Job run (its activeDeadlineSeconds), plus a minute.
  limit=$(k get job "$job" -o jsonpath='{.spec.activeDeadlineSeconds}')
  deadline=$(( SECONDS + ${limit:-900} + 60 ))
  while (( SECONDS < deadline )); do
    state=$(k get job "$job" -o jsonpath='{range .status.conditions[?(@.status=="True")]}{.type} {end}')
    case " $state" in *" Complete "*|*" Failed "*) break ;; esac
    sleep 2
  done
  logs=$(k logs -l "batch.kubernetes.io/job-name=$job" --tail=-1 2>&1 || true)
  printf '%s\n' "$logs" | sed 's/^/    /'
  case " $state" in *" Complete "*) ;; *) die "backup job $job did not complete (conditions: ${state:-none yet})" ;; esac
  DUMP_FILE=$(printf '%s\n' "$logs" | sed -n 's/^backup: wrote \([^ ]*\) .*/\1/p' | tail -n 1)
  [ -n "$DUMP_FILE" ] || die "backup job $job finished but did not name its dump"
}

# start_tools_pod plain|db: a short-lived helper pod on the backup volume (mounted read-only), running
# the CronJob's image as the CronJob's user, under the same restricted security settings.
#   plain  its label matches no allow rule, so the release's default-deny NetworkPolicy leaves it no
#          network at all, and it gets no database password. For listing, checking and copying dumps.
#   db     the backup job's own label (its NetworkPolicy is the one way into the database) and env
#          (host, user, password via secretKeyRef). Only the restore scripts use it.
# It deletes itself after an hour even if this script is killed. Run commands in it with tools_exec.
start_tools_pod() {
  local mode=$1 label=backup-tools env='[]'
  if [ "$mode" = db ]; then
    label=$(cj '.metadata.labels.app\.kubernetes\.io/name')
    env=$(cj '.spec.containers[0].env')
  fi
  TOOLS_POD="backup-tools-$(date +%s)-$RANDOM"
  # JSON from the CronJob (env, securityContext) is valid YAML, so it is pasted in as is.
  k create -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $TOOLS_POD
  labels:
    app.kubernetes.io/name: $label
    app.kubernetes.io/instance: $RELEASE
    app.kubernetes.io/part-of: urumi
spec:
  restartPolicy: Never
  activeDeadlineSeconds: 3600
  enableServiceLinks: false
  automountServiceAccountToken: false
  securityContext: $(cj '.spec.securityContext')
  containers:
    - name: tools
      image: $(cj '.spec.containers[0].image')
      imagePullPolicy: $(cj '.spec.containers[0].imagePullPolicy')
      command: ["sleep", "3600"]
      workingDir: /backups
      env: $env
      # Room for verify.sh's throwaway database server.
      resources: {requests: {cpu: 100m, memory: 256Mi}, limits: {cpu: "1", memory: 1Gi}}
      securityContext: $(cj '.spec.containers[0].securityContext')
      volumeMounts:
        - {name: backups, mountPath: /backups, readOnly: true}
        - {name: tmp, mountPath: /tmp}
  volumes:
    - name: backups
      persistentVolumeClaim: {claimName: $PVC, readOnly: true}
    - name: tmp
      emptyDir: {sizeLimit: 2Gi}
EOF
  k wait --for=condition=Ready "pod/$TOOLS_POD" --timeout=180s >/dev/null \
    || die "helper pod $TOOLS_POD did not start (kubectl -n $NS describe pod $TOOLS_POD)"
}

# No -i: nothing in the pod reads stdin, and an attached stdin would swallow a piped confirmation.
tools_exec() { k exec "$TOOLS_POD" -c tools -- "$@"; }

cleanup() {
  if [ -n "$TOOLS_POD" ]; then
    k delete pod "$TOOLS_POD" --wait=false >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

# list_dumps: the dumps on the volume, oldest first (needs the helper pod).
list_dumps() {
  tools_exec bash -c 'cd /backups && shopt -s nullglob && f=("$1"-*"$2") && if ((${#f[@]})); then ls -l "${f[@]}"; else echo "(no dumps yet)"; fi' \
    _ "$DB_NAME" "$SUFFIX"
}

# newest_dump: the newest dump's file name, or nothing (needs the helper pod).
newest_dump() {
  tools_exec bash -c 'cd /backups && shopt -s nullglob && f=("$1"-*"$2") && if ((${#f[@]})); then echo "${f[-1]}"; fi' \
    _ "$DB_NAME" "$SUFFIX"
}

# confirm <word>: the operator must type <word> exactly (read from the terminal, or from stdin when piped).
confirm() {
  local answer=""
  printf '\nType the namespace name (%s) to go ahead; anything else aborts: ' "$1"
  read -r answer || true
  [ "$answer" = "$1" ] || die "aborted: nothing was changed"
}
