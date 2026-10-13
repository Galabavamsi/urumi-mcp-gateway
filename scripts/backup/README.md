# Backups

Both databases get a nightly logical dump when the release has `backup.enabled=true` (off by default;
production turns it on):

| Release | Database | CronJob | Dump | Volume |
|---|---|---|---|---|
| `woo-store` (ns `store`) | MariaDB `wordpress` | `mariadb-backup`, 02:00 IST | `mariadb-dump --single-transaction --routines \| gzip` → `wordpress-<UTC time>.sql.gz` | PVC `mariadb-backups` |
| `platform` (ns `platform`) | Postgres `gateway` | `postgres-backup`, 02:15 IST | `pg_dump -Fc` → `gateway-<UTC time>.dump` | PVC `postgres-backups` |

Each run keeps the newest `backup.keep` dumps (7) and deletes older ones. The templates are
`charts/*/templates/backup-*.yaml`; the settings are the `backup:` block of each chart's `values.yaml`.

## Commands

Run inside WSL (where kubectl lives), from anywhere in the repo. Every script takes `--context`
(default `k3d-urumi`, or `$KUBE_CONTEXT`) and `-n <namespace>`, and prints its own help with `--help`.

```bash
bash scripts/backup/backup-now.sh store|platform|all     # dump now (do this before every store upgrade)
bash scripts/backup/verify.sh store|platform [dump]      # restore a dump into a throwaway server, count rows
bash scripts/backup/fetch.sh store|platform [dump]       # copy one to ~/urumi-backups/<context>/<ns>/
bash scripts/backup/restore-store.sh [dump]              # no argument: list the dumps
bash scripts/backup/restore-gateway.sh [dump]
```

## How it is built, and why

- **A volume of its own**, not the database's: a full backup volume never stops the database. It has
  `helm.sh/resource-policy: keep`, so neither `helm uninstall` nor `backup.enabled=false` deletes the dumps;
  turning backups on again adopts it.
- **Same image as the server** (`mariadb:11.8.9`, `postgres:18.6-trixie`), so the dump tool always matches
  the server version. Non-root (uid 999), read-only root filesystem, all capabilities dropped, requests
  and limits, `activeDeadlineSeconds`, `concurrencyPolicy: Forbid`.
- **Least privilege, for MariaDB.** The MariaDB dump logs in as the app user `wordpress` from the existing
  Secret (`secretKeyRef`) and never sees the root password. Postgres has only one role, `gateway`, and the
  official image's `POSTGRES_USER` makes it the superuser, so the Postgres dump (like the gateway itself)
  runs as a superuser; a separate read-only role would fix that (docs/THREAT-MODEL.md, residual risks).
  Files are written with `umask 077`.
- **One network path.** Backup pods carry the release's labels, so the release's default-deny policy
  already closes everything; `backup-networkpolicy.yaml` opens exactly backup pods → database port (+ DNS),
  at both ends. Helper pods of these scripts get a different label and therefore no network at all, except
  the restore pod, which gets the backup identity on purpose.
- **A dump only counts when it is whole.** It is written under a hidden `.partial` name and renamed only
  after a check: `gzip -t` plus mariadb-dump's closing `-- Dump completed` line, or `pg_restore --list`.
- **Two k3s gotchas, both found while testing:**
  1. *local-path binds a PVC only when a pod first mounts it* (WaitForFirstConsumer), and Helm 4's
     `--wait` counts an unbound PVC as not ready. The CronJob's first pod comes at 02:00, so a plain
     `helm upgrade --wait --rollback-on-failure` that turns backups on timed out and rolled itself back.
     Fix: a one-shot Job (`*-backup-volume-<hash>`) mounts the volume at deploy time. It also proves the
     backup user can write there, and a failed check fails the deploy because our scripts pass
     `--wait-for-jobs` (plain `--wait` in Helm 4 counts a Job as ready once it has started). Its name carries
     a hash of its pod spec, because a Job's template is immutable.
  2. *kube-router needs a few seconds to add a brand-new pod to its allow rules* and refuses its
     connections until then. A Job pod connects within a second, so every retry failed the same way.
     Fix: the job waits for the database (`mariadb-admin ping` / `pg_isready`, up to a minute) first.

## Restoring

Both restore scripts change nothing until you type the namespace name. Then:

1. stop the writers (store: `wordpress`, `woo-mcp` scaled to 0, `wp-cron` suspended; platform: `gateway`
   scaled to 0) and suspend the backup CronJob;
2. take a **safety dump** of the current database (the CronJob's own Job with `BACKUP_KEEP=0`, so it
   cannot rotate out the dump being restored), which makes the restore itself undoable;
3. drop and recreate the database and load the dump (Postgres: `pg_restore --single-transaction`), from a
   pod with the backup identity;
4. start the writers again. Both apps migrate forward on start, so an older dump is brought up to the
   running version.

**Data-loss window:** everything written after the dump. The store is down for 1-2 minutes, the gateway
for 10-30 seconds. If anything fails after step 1, the writers stay stopped on purpose, and the script
prints how to start them. Without that, WordPress would "install" a fresh store into an empty database and
the gateway would create a fresh first admin.

Things to know:

- **Store:** product images live on the `wordpress-uploads` volume and are not in the dump.
- **Undoing a store upgrade:** run `helm rollback woo-store <rev>` *first*, then `restore-store.sh <the dump
  from before the upgrade>`. In the other order, the new image would migrate the old dump forward again.
- **Gateway: API keys revoked after the dump work again.** Revoke them again. Users disabled since then
  are active again too.
- **Gateway: a dump is only usable with the `gateway-internal` Secret it was made with.** Upstream
  credentials are encrypted with its `credentials-key`, and API keys are checked with its `api-key-pepper`.
  That Secret is never in a dump, on purpose, so keep a copy of it as well.

## Limits

- On k3s the backup volume sits on the **same disk** as the database. It protects against logical damage
  (a bad migration, a deleted row, a broken upgrade) but not against losing the disk or the VM. Copy dumps
  off the machine with `fetch.sh`. The next step would be an off-site target (S3) or EBS snapshots.
- Dumps are logical: a restore takes minutes, not seconds. That is fine at this size (tens of KB today).

## Verified (2026-10-14, k3d)

| Check | Result |
|---|---|
| `helm lint --strict` and `helm template`, local and prod values, backups on and off | clean; +5 objects per chart (PVC, CronJob, Job, 2 NetworkPolicies); server-side dry run accepted, no Pod Security warnings; a bad `timeZone` is refused by the API server |
| turn backups on in the live releases (values-local + deployed tags) | no running pod restarted; the volume check bound both PVCs; `helm --wait` succeeded |
| `backup-now.sh all` + `verify.sh` on the live data | store: 52 tables, 983 rows; gateway: 9 tables, 44 rows, same row counts as the live database |
| `fetch.sh` | sha256 matches, mode 0600, `gunzip -t` OK, `PGDMP` header |
| NetworkPolicy from real pods | backup identity → database open, → WordPress/gateway refused; helper-pod identity → everything refused |
| full restore drills, in throwaway namespaces with their own releases | store 37 s, gateway 31 s: a table and a changed row planted after the dump were gone, the safety dump existed, the writers came back Ready |
| refusals | missing dump, a path as dump name, wrong confirmation: nothing changed |
| backups off, then on again | the PVC is kept with its dumps, then adopted |
