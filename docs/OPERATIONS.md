# Operations

Day-2 work on the running system: upgrades and rollbacks, backups, observability, troubleshooting and rotating
secrets. Commands run where kubectl and Helm run (inside WSL on the development laptop) with the right kube
context: `k3d-urumi` locally; in production the context that goes through the SSH tunnel (see [VPS.md](VPS.md)).
The design behind these procedures is in [DESIGN.md](DESIGN.md).

## The releases

| Release | Namespace | Chart | State it owns | Image tags |
|---|---|---|---|---|
| `woo-store` | `store` | `charts/woo-store` | MariaDB (`data-mariadb-0`), uploads (`wordpress-uploads`) | `wordpress.image.tag`, `wooMcp.image.tag` |
| `supplier-mcp` | `mcp-upstreams` | `charts/mcp-server` + `instances/supplier.yaml` | none | `image.tag` |
| `platform` | `platform` | `charts/platform` | Postgres (`data-postgres-0`) | `gateway.image.tag`, `dashboard.image.tag` |

Locally, `bash scripts/dev-up.sh` upgrades all three to images built from the current commit. In production the
tags are git short SHAs of images that CI pushed to GHCR.

## Upgrade and rollback

### The common pattern

```bash
helm upgrade --install <release> charts/<chart> -n <namespace> -f charts/<chart>/values-<local|prod>.yaml \
  --set-string <tag key>=<sha> --wait --wait-for-jobs --timeout 10m --rollback-on-failure
helm history <release> -n <namespace>
helm rollback <release> <revision> -n <namespace> --wait
```

- **Helm 4 flags.** `--rollback-on-failure` is Helm 4's name for the old `--atomic`, and `--wait` must be given
  explicitly. Together they make Helm wait until every Deployment and StatefulSet of the release is ready and,
  if that does not happen within the timeout, roll the release back to the previous revision. Helm 4's `--wait`
  counts a Job as ready as soon as it has started, so `--wait-for-jobs` makes it wait for the Job to complete
  (the backup-volume check is the only Job in the charts): a failed check then fails the upgrade.
- **`--set-string` for tags**, never `--set`: a short SHA can be all digits, which `--set` turns into a number.
  The charts refuse to render an empty or `latest` tag.
- **No `--reuse-values`.** The values files are the whole truth; a toggle set by hand for a demo (such as the
  supplier's `DEMO_SLOW_TOOL`) is reset by the next upgrade.
- **What `--rollback-on-failure` cannot undo:** database migrations that a new pod already ran before it failed.
  That is why the rules differ per component.

`bash scripts/demo/upgrade-rollback.sh` (add `--pause` when recording) shows this live on the local cluster in
about two and a half minutes: (a) `helm history platform`; (b) a harmless upgrade (the gateway's `LOG_LEVEL`
flips) rolled out without a failed request; (c) a **broken** upgrade (a gateway image tag that does not exist)
with `--wait --timeout 90s --rollback-on-failure`: the new pod never gets Ready, the old one keeps answering,
and Helm 4 rolls the release back by itself; (d) `helm rollback` to the starting revision; (e) a health check;
(f) the store's safe path: `backup-now.sh store`, an upgrade, and a rollback only after checking that the
WordPress image did not change. During b-d it probes `/api/auth/me` and `/mcp` through Traefik every few
seconds and counts the answers. It refuses a context that is not `k3d-*` unless given `--allow-remote`, and it
refuses to roll back if someone else deployed in the meantime. Its header lists exactly what it changes. Step f
turns store backups on and leaves them on (the next `dev-up.sh` turns them off again).

### Gateway and dashboard (release `platform`)

The gateway and the dashboard are stateless; their state is in Postgres. The gateway Deployment uses
`maxSurge: 1, maxUnavailable: 0`, so the new pod must pass its readiness probe before the old one stops and the
MCP endpoint stays up during an upgrade. For those seconds the old and the new gateway share one database.

The gateway applies its SQL migrations (`apps/gateway/drizzle/`) at startup under a Postgres advisory lock.
They are forward-only, so schema changes follow **expand/contract**:

1. *Expand:* a release only adds (tables, nullable columns, indexes). The old code ignores them, so rolling the
   image back is safe even though the schema stays expanded.
2. Ship code that uses the new shape.
3. *Contract:* a later release drops or renames what nothing uses any more. Rolling back across a contract step
   is **not** safe: take a dump before it (`bash scripts/backup/backup-now.sh platform`), and to undo it roll
   back the image and restore that dump (`bash scripts/backup/restore-gateway.sh <dump>`).

Most gateway and dashboard releases change no schema and roll back freely:

```bash
helm history platform -n platform
helm rollback platform <revision> -n platform --wait
```

A gateway restart loses only in-memory state: unanswered chat approvals, rate-limit windows and the login
throttle. MCP requests need no session in either protocol era, so clients just send their next request; open
notification streams end with the old pod.

Two Postgres notes: a minor version bump (`18.6` → `18.7`) is an image change and rolls back freely; a major
version needs `pg_upgrade` or dump and restore, which the chart does not do. The volume size and StorageClass
are fixed at first install (StatefulSet `volumeClaimTemplates` cannot change).

Changing a seed server in `gateway.seedServers` does not change an existing row (a seed is only inserted when
no server ever had its slug, so admins' edits survive upgrades). Edit the server in the dashboard instead.

### MCP servers (woo-mcp in `woo-store`, release `supplier-mcp`)

Both are stateless and roll forward and back freely. With one replica the default rolling update starts the new
pod before stopping the old one, and on SIGTERM the old pod keeps serving for 3 s, then lets running calls
finish (12 s deadline). The gateway reconnects by itself; at worst a check fails and the server shows
Unreachable for a few seconds.

```bash
helm upgrade --install supplier-mcp charts/mcp-server -n mcp-upstreams \
  -f charts/mcp-server/values-local.yaml -f charts/mcp-server/instances/supplier.yaml \
  --set-string image.tag=<sha> --wait --wait-for-jobs --timeout 10m --rollback-on-failure
helm rollback supplier-mcp <revision> -n mcp-upstreams --wait
```

### The store (WordPress image, release `woo-store`)

The store image does **not** roll back freely. On every start the bootstrap init container runs
`wp core update-db` and `wp wc update`, so a new WordPress or WooCommerce version migrates the database the
moment its pod starts, and those migrations are forward-only. If the new pod then fails, `--rollback-on-failure`
puts the old image back on top of the migrated database. The MariaDB image also upgrades its system tables on a
version change (`MARIADB_AUTO_UPGRADE`). So:

1. Back up the database: `bash scripts/backup/backup-now.sh store` (and the uploads if you care about media),
   see [Backups](#backups-and-restore). In production `scripts/vps/deploy.sh` does this step itself whenever
   the WordPress image changes, and prints the rollback and restore commands for that dump.
2. Upgrade: `helm upgrade --install woo-store charts/woo-store -n store -f charts/woo-store/values-<env>.yaml --set-string wordpress.image.tag=<sha> --set-string wooMcp.image.tag=<sha> --wait --wait-for-jobs --timeout 10m --rollback-on-failure`.
3. Check the storefront, `kubectl -n store logs deploy/wordpress -c bootstrap`, and `node scripts/e2e-store.mjs --quick`.
4. If it misbehaves: `helm rollback woo-store <revision> -n store --wait` **first**, then
   `bash scripts/backup/restore-store.sh <the dump from step 1>`. In the other order the new image would
   migrate the restored dump forward again. Never only the image.

WordPress runs one replica with the `Recreate` strategy (its uploads volume is ReadWriteOnce), so a store
upgrade has a short downtime. woo-mcp, the CronJob, resources and NetworkPolicies are stateless and roll back
freely.

### One-off step for clusters installed before chart 0.1.1

Chart versions before 0.1.1 put the chart-version label on the Postgres and MariaDB `volumeClaimTemplates`,
which cannot change, so the first upgrade to 0.1.1 fails with "updates to statefulset spec ... are forbidden".
Run once, then upgrade again (the pod and its PVC are kept and adopted):

```bash
kubectl -n platform delete statefulset postgres --cascade=orphan
kubectl -n store delete statefulset mariadb --cascade=orphan
```

## Backups and restore

Code lives in the images, so only data needs backing up:

| Data | Where | Contains |
|---|---|---|
| Store database | MariaDB database `wordpress`, PVC `data-mariadb-0` | Products, orders, customers, WordPress and WooCommerce settings |
| Media | PVC `wordpress-uploads` | Product images and other uploads |
| Gateway database | Postgres database `gateway`, PVC `data-postgres-0` | Users, API key hashes, servers with encrypted credentials, policies, the audit log |
| Secrets | Secrets in `store`, `platform`, `mcp-upstreams` | The keys the dumps depend on |

**A database dump is useless without its Secrets.** `gateway-internal/credentials-key` decrypts the stored
upstream credentials, `api-key-pepper` is what every API key hash was made with, `woo-store-api` must match the
key hash WooCommerce keeps, and the database passwords live inside the databases. Keep a copy of the Secrets,
but never in the same place as the dumps.

**Nightly backups.** With `backup.enabled=true` (on in both `values-prod.yaml`, off locally) each chart runs
a backup CronJob that dumps its database onto a PVC of its own and keeps the newest 7 dumps:

| Release | CronJob (IST) | Dump | PVC |
|---|---|---|---|
| `woo-store` | `mariadb-backup` (02:00) | `mariadb-dump --single-transaction --routines \| gzip` → `wordpress-<UTC time>.sql.gz` | `mariadb-backups` |
| `platform` | `postgres-backup` (02:15) | `pg_dump -Fc` → `gateway-<UTC time>.dump` | `postgres-backups` |

The dump runs in the database's own image as the app user (MariaDB: `wordpress`, not root; Postgres: `gateway`,
which is the database superuser, see the [threat model](THREAT-MODEL.md#residual-risks)), is written under a hidden
`.partial` name and renamed only after it is checked complete, and the PVC carries
`helm.sh/resource-policy: keep`, so neither `helm uninstall` nor turning backups off deletes the dumps.
Design, gotchas and test results: [scripts/backup/README.md](../scripts/backup/README.md).

**The commands** (inside WSL; every script takes `--context`, default `k3d-urumi`, and `--help`):

```bash
bash scripts/backup/backup-now.sh store|platform|all   # a dump now, from the CronJob's own template
bash scripts/backup/verify.sh store|platform [dump]    # restore into a throwaway server in a no-network pod, count rows
bash scripts/backup/fetch.sh store|platform [dump]     # copy off the cluster to ~/urumi-backups/<context>/<ns>/ (sha256 checked, mode 0600)
bash scripts/backup/restore-store.sh [dump]            # no argument: list the dumps
bash scripts/backup/restore-gateway.sh [dump]
```

On the VPS add `--context urumi-vps` and run them with `KUBECONFIG=~/.kube/urumi-vps.yaml` while
`scripts/vps/tunnel.sh` runs. The scripts need the CronJob, so on the local cluster turn backups on first:

```bash
helm upgrade woo-store charts/woo-store -n store --reset-then-reuse-values --set backup.enabled=true \
  --wait --wait-for-jobs --timeout 10m --rollback-on-failure   # likewise platform charts/platform -n platform
```

The next `scripts/dev-up.sh` turns them off again (it uses only `values-local.yaml`); the PVC and its dumps
stay until you delete it (`kubectl -n store delete pvc mariadb-backups`).

**Restore.** `restore-store.sh` and `restore-gateway.sh` change nothing until you type the namespace name.
Then they stop the writers (store: `wordpress` and `woo-mcp` scaled to 0, `wp-cron` suspended; platform:
`gateway` scaled to 0) and suspend the backup CronJob, take a **safety dump** of the current database (so
the restore itself can be undone), drop and recreate the database, load the dump from a pod with the backup's
network identity, and start the writers again. Both apps migrate forward on start. The data-loss window is
everything written after the dump; the store is down for 1-2 minutes, the gateway for 10-30 seconds. If any
step fails, the writers stay stopped on purpose (an empty database would otherwise make WordPress install a
fresh store and the gateway create a fresh first admin) and the script prints the commands to resume.
Restore drills in throwaway namespaces took 37 s (store) and 31 s (gateway).

After a gateway restore, API keys revoked and users disabled after the dump are active again: revoke and
disable them again.

**Not in the dumps: product images.** They live on the `wordpress-uploads` volume. Copy them by hand:

```bash
kubectl -n store exec deploy/wordpress -c wordpress -- \
  tar -C /srv/wordpress/wp-content -czf - uploads > uploads-$(date +%F).tgz
# restore: kubectl -n store exec -i deploy/wordpress -c wordpress -- tar -C /srv/wordpress/wp-content -xzf - < uploads-<date>.tgz
```

**Off the machine.** With `local-path` storage (locally and on the VPS) the backup PVC sits on the same disk
as the databases: it protects against logical damage (a bad migration, a deleted row, a broken upgrade), not
against losing the disk or the VM. Copy dumps off with `fetch.sh`, and keep the Secrets (above) somewhere
else again. S3 or EBS snapshots would be the next step.

## Observability

### Metrics

The gateway serves Prometheus metrics on port 9091 (`GET /metrics`), Service `gateway-metrics`. The port is never
on the Ingress, and the gateway's NetworkPolicy keeps it closed until `networkPolicy.metricsFrom` names a
scraper (no Prometheus is installed today). Defined in `apps/gateway/src/metrics.ts`:

| Metric | Type | Labels | Meaning |
|---|---|---|---|
| `gateway_tool_calls_total` | counter | `server`, `tool` (exposed name), `status` | Every tool call, by audit status: `ok`, `error`, `timeout`, `unreachable`, `denied` (policy, disabled server or rate limit) |
| `gateway_tool_call_duration_seconds` | histogram (0.05 to 30 s) | `server` | Duration of calls that measure the upstream: `ok`, `error` and `timeout`. Refused calls and fail-fast `unreachable` ones (a few ms, no network) are not observed, as on the Observability page, so an outage does not make p95 look better |
| `gateway_upstream_up` | gauge | `server` | 1 while the server's status is Connected, else 0. It follows the status, so a single timed-out or HTTP 500 check does not flip it (that takes two in a row; a connection failure flips it at once) |
| `gateway_auth_rejections_total` | counter | `reason` | MCP requests answered 401: `missing`, `malformed`, `unknown_key`, `wrong_secret`, `revoked`, `user_disabled`; on the chat's internal listener `chat_token_invalid`, `chat_user_inactive` |

Plus prom-client's default process metrics (CPU, resident memory, heap, event-loop lag). Label values come only
from the catalog and fixed lists, so an unknown tool name sent by a client never creates a new series.

```bash
# look without Prometheus (port-forward bypasses the NetworkPolicy, which is fine for an operator)
kubectl -n platform port-forward svc/gateway-metrics 9091    # then open http://localhost:9091/metrics
```

Useful queries once Prometheus scrapes it:

```promql
# error rate per server (failures only, not policy or rate-limit refusals)
sum by (server) (rate(gateway_tool_calls_total{status=~"error|timeout|unreachable"}[5m]))
  / sum by (server) (rate(gateway_tool_calls_total{status!="denied"}[5m]))
# 95th percentile latency per server
histogram_quantile(0.95, sum by (le, server) (rate(gateway_tool_call_duration_seconds_bucket[5m])))
# servers down right now
gateway_upstream_up == 0
```

### In the dashboard

- **Servers** shows every server's status, the reason when it is unreachable, the protocol era and the last
  check, refreshed every 3 seconds, plus each tool's "Definition changed" and "Suspicious text" flags.
- **Audit log** filters by user, server, status and channel (`mcp` or `chat`); every row has the duration and,
  for failures, a short reason.
- **Observability** (admins only; page `/observability`, data from `GET /api/stats`, refreshed every 3 seconds)
  has one card per server: status and reason with since when, the last 20 status changes with their reasons
  (newest first), calls, error rate, p50 and p95 latency over the last 15 minutes, a calls-per-minute sparkline
  with failed calls in red, errors by status, the last error, the most-used tools and since-start totals. The
  error rate leaves out `denied` calls (they never reached the server), and fail-fast `unreachable` calls are not
  timed, so an outage does not make the latency look better. A tool's own error text is not kept (it can repeat
  the caller's arguments; the audit log has it). The Servers page also shows admins since when an unreachable
  server has been down. These counters are kept in memory and start again from zero when the gateway restarts;
  the audit log and Prometheus are the durable record. Demo: open the page and run
  `kubectl -n mcp-upstreams scale deploy/supplier-mcp --replicas=0`; the card turns red with
  `connection refused` within about 10 s, and recovers within about 20 s of scaling back to 1.

### Logs

Every Node service writes one JSON object per line to stdout: `{"ts", "level", "msg", ...fields}`
(`packages/mcp-common/src/log.ts`). The level is set with `LOG_LEVEL` (`debug`, `info`, `warn`, `error`): values
`gateway.logLevel`, `wooMcp.logLevel`, and `env.LOG_LEVEL` for supplier-mcp. Logs never contain keys,
credentials, tool arguments, prompt text or database parameter values.

| `msg` | Service | Fields and meaning |
|---|---|---|
| `tool call` | gateway | `user`, `via`, `tool`, `status`, `ms`: one line per forwarded call |
| `tool call denied` | gateway | `user`, `tool`, `why`: policy, disabled server or rate limit |
| `MCP request rejected` | gateway | `reason`, `user`, `key` (prefix only): a 401 |
| `upstream status changed` | gateway | `server`, `status`, `reason`, `era` |
| `upstream health check failed` | gateway (`debug`) | `server`, `reason`, `failures`: every failed check, including the ones that do not change the status yet |
| `upstream tool definition changed` | gateway (`warn`) | `server`, `tool`: possible rug pull |
| `upstream tool text reads like instructions to the model` | gateway (`warn`) | `server`, `tool`: the phrase lint matched |
| `tool input schema too large; tool not exposed` and similar | gateway (`warn`) | a tool the catalog refused |
| `chat turn` | gateway | `userId`, `stopReason`, `iterations`, `inputTokens`, `outputTokens`, `ms` (no text) |
| `seed server skipped: ...` | gateway | a seed whose credential variable is empty, or whose URL is not allowed |
| `mcp request` | woo-mcp, supplier-mcp | `mcpMethod`, `mcpName`, `protocol`, `status`, `ms` |

```bash
kubectl -n platform logs deploy/gateway --since=1h | grep '"upstream status changed"'
kubectl -n platform logs deploy/gateway --since=10m | grep '"tool call"' | tail -20
kubectl -n store logs deploy/woo-mcp --since=10m
kubectl -n store logs deploy/wordpress -c bootstrap      # what the store bootstrap did at the last start
```

### Why is a server unreachable?

1. Read the reason on the Servers page (or `statusReason` in `GET /api/servers`). The gateway classifies the
   failure in `apps/gateway/src/upstreams/errors.ts`:

   | Reason | What it usually means | Look at |
   |---|---|---|
   | `connection refused` | No ready pod behind the Service, **or** a NetworkPolicy blocks the path (kube-router refuses blocked connections, so both look the same). For a hosted server: a port other than 443, which the gateway's egress policy does not allow. | `kubectl -n <ns> get pods,endpoints`; the upstream's NetworkPolicy and the gateway's `networkPolicy.upstreams`; `INTERNAL_HOST_ALLOWLIST` |
   | `DNS lookup failed` | Wrong host name, or a Service that does not exist | the URL; `kubectl get svc -A` |
   | `connection reset` | The upstream (or something in between) dropped the connection. Hosted servers do this now and then; the next check runs within 5 s. | the gateway log over a few minutes |
   | `connect timeout`, `host unreachable`, `network unreachable` | The host does not accept connections or cannot be routed to | the URL; the internet egress rule |
   | `upstream rejected the gateway's credential (HTTP 401)` or `(HTTP 403)` | Wrong, expired or rotated credential | re-enter it in the dashboard; for a seed, its Secret, then restart the gateway |
   | `upstream answered HTTP <n>` | A web server answered, but not as an MCP endpoint (often a missing `/mcp` path) or it failed | the URL path; the upstream's own logs |
   | `timed out after 3s` (twice in a row) | The server is up but answers `tools/list` too slowly | the upstream's load and logs |
   | `TLS error (...)` | Certificate problem on a hosted server | the certificate chain |
   | `blocked by the SSRF guard: ...` | The URL is not https, or resolves to a non-public address | the URL; in-cluster servers must be in `gateway.internalHostAllowlist` |
   | `stored credential cannot be decrypted (was CREDENTIALS_KEY changed?)` | `gateway-internal/credentials-key` changed | [Rotating secrets](#rotating-secrets) |
   | `upstream response too large (over 4 MB)` | The tool list itself is huge | the server; its tool allowlist |
   | `protocol error: ...` | Not an MCP server, or an incompatible one | the URL; the upstream's MCP version |

2. Test the path from the gateway's own pod, which has the gateway's network identity (a `kubectl port-forward`
   would bypass the NetworkPolicies and prove nothing):

   ```bash
   kubectl -n platform exec deploy/gateway -- node -e \
     "fetch('http://supplier-mcp.mcp-upstreams.svc.cluster.local:8080/healthz').then(r => console.log(r.status), e => console.log(e.cause?.code))"
   ```

   `200` means the path is open and the server is alive; `ECONNREFUSED` means no ready pod or a policy block.
3. For the history, grep the gateway log for `upstream status changed`, and set `gateway.logLevel=debug` to see
   every failed check. `gateway_upstream_up` gives the same picture over time.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| The cluster disappears a minute after you close the last terminal (Windows) | WSL stops an idle distro and VM | `%UserProfile%\.wslconfig` with `[wsl2] vmIdleTimeout=-1` and `[general] instanceIdleTimeout=-1`, then `wsl --shutdown` once |
| `docker build` fails with `ECONNRESET` during `npm`/`pnpm install` or downloads (WSL) | WSL's network interface has MTU 1280, Docker's bridge 1500, so large downloads inside a bridged build are reset | Build with `--network=host` (`dev-up.sh` does, and retries twice) |
| `*.localhost` URLs work in the browser but not in Node, Claude Code or Inspector (Windows) | Node on Windows does not resolve `*.localhost` subdomains | Use the `*.127-0-0-1.sslip.io` names; offline, add them to the hosts file |
| A NetworkPolicy test passes through `kubectl port-forward` although the policy should block it | port-forward goes through the kubelet and bypasses NetworkPolicies | Test from a real pod (`scripts/e2e-store.mjs` f1 to f3 does) |
| The gateway crash-loops after the first `secrets.sh` run with `BOOTSTRAP_ADMIN_EMAIL: Invalid email address` | An older `secrets.sh` copied the `\r` of a Windows (CRLF) `.env` into the Secrets | Current `secrets.sh` strips it; re-run it and restart the gateway. To check a Secret without printing it: `kubectl -n platform get secret gateway-bootstrap-admin -o go-template='{{index .data "email" \| base64decode}}' \| tr -dc '\r' \| wc -c` must print `0` |
| The gateway log says `invalid gateway configuration: <VAR>: ...` | A required variable is missing or malformed | The message names the variable (never the value); check the Secret it comes from |
| Nobody can log in to a fresh dashboard | `BOOTSTRAP_ADMIN_*` were empty when the users table was created | Set them in `.env`, run `scripts/secrets.sh`, restart the gateway; this works only while no user exists |
| Changing `BOOTSTRAP_ADMIN_PASSWORD` has no effect | The bootstrap admin is created once, when the users table is empty | Expected; see the note at the end of [Rotating secrets](#rotating-secrets) |
| Login answers `429 too_many_attempts` | 5 attempts for that email in 15 minutes | Wait 15 minutes (the counter is in memory: a gateway restart also clears it) |
| `firecrawl` or `mail` is missing from the Servers page | Its key was empty in `.env`, so the seed was skipped | Set the key, run `scripts/secrets.sh`, `kubectl -n platform rollout restart deploy/gateway` |
| Chat answers "a chat reply is already running for you" | One running reply per user | Wait for it or press Stop |
| `helm upgrade` fails with "updates to statefulset spec ... are forbidden" | A `volumeClaimTemplates` field (size, StorageClass, labels) changed | See the [one-off step](#one-off-step-for-clusters-installed-before-chart-011); size and StorageClass need backup, reinstall, restore |
| `dev-up.sh` says `the Docker daemon is not running` | Docker Engine in WSL is stopped | `sudo systemctl start docker` |
| `dev-up.sh` says `no access to the Docker socket` | Your user was just added to the `docker` group, which applies only to new logins | WSL: `wsl --shutdown` from Windows once; Linux: log out and back in (or `newgrp docker`) |
| `dev-up.sh` says `Helm 4 is required` | Helm 3 on the PATH; it has no `--rollback-on-failure` | Install Helm 4.3 (`scripts/setup-wsl-docker.sh` does) |
| k3d cannot create the load balancer | Port 80 or 443 is taken on the host | Stop whatever listens there |
| Changes do not show up after `dev-up.sh` | The images are tagged by commit; uncommitted changes add a `-dirty-<hash>` suffix, so a new edit gives a new tag | Check the image tag in `kubectl -n <ns> get pod -o yaml` |

## Rotating secrets

The charts never see Secret values, so after changing a Secret restart the workloads that read it. Never print a
value: read new ones into a shell variable or generate them in place. `kubectl patch ... stringData` replaces one
key of a Secret and leaves the others alone.

**External secrets (from `.env`).** Edit `.env`, run `bash scripts/secrets.sh`, then
`kubectl -n platform rollout restart deploy/gateway`.

| Secret | Effect of rotating |
|---|---|
| `gateway-llm` (Anthropic key) | The next chat turn uses the new key. |
| `gateway-upstream-seed` (Firecrawl, AgentMail) | The seeded server's stored credential is re-synced from the Secret at startup, but only while the server still points where the seed file says. A server an admin re-pointed keeps the credential the admin entered (re-enter it in the dashboard). |
| `gateway-bootstrap-admin` | Only used while the users table is empty; rotating it does not change an existing admin. |

**Internal secrets (generated by `secrets.sh`).** `secrets.sh` never overwrites these, so rotate them by hand:

```bash
NEW=$(openssl rand -hex 32)
kubectl -n platform patch secret gateway-internal --type merge -p "{\"stringData\":{\"chat-jwt-key\":\"$NEW\"}}"
unset NEW
kubectl -n platform rollout restart deploy/gateway
```

| Secret / key | Consequence | Safe? |
|---|---|---|
| `gateway-internal/chat-jwt-key` | Chat tokens live 5 minutes and are minted per turn | Yes, any time |
| `gateway-internal/session-secret` | Every dashboard session ends, and every pending invite link stops working (invite tokens are hashed with it) | Yes; re-send open invites |
| `gateway-internal/api-key-pepper` | **Every API key stops working**: all stored hashes were made with the old pepper | Only if every user creates new keys |
| `gateway-internal/credentials-key` (base64 of 32 bytes: `openssl rand -base64 32`) | Stored upstream credentials cannot be decrypted (the server shows `stored credential cannot be decrypted`). Seeds are re-encrypted from their Secrets at the next start; admin-added servers need their credential re-entered | With a plan for admin-added servers |
| `woo-mcp-auth/token`, `supplier-mcp-auth/token` | The same value must be in both namespaces (`store` and `platform`, or `mcp-upstreams` and `platform`). Patch both, then restart the MCP server and the gateway (the gateway re-syncs seed credentials at start) | Yes, with a short window of 401s |
| `woo-store-api` (WooCommerce key pair) | The bootstrap upserts the key row from the Secret, so restart WordPress, then woo-mcp | Yes |
| `woo-store-wp/admin-password` | The bootstrap syncs the WordPress admin password from the Secret on the next WordPress start | Yes |
| `woo-store-wp` salts | Every WordPress login cookie becomes invalid | Yes |
| `gateway-postgres/password`, `woo-store-db/password` | The databases keep their own copy of the password from their first start, so change it **inside the database first** (`\password gateway` in `psql`; `ALTER USER` in MariaDB), then the Secret, then restart the client | Only in that order |

**User passwords** (the bootstrap admin's included) live only as scrypt hashes in Postgres and are not secrets
an operator rotates. The product has no password change or reset yet, which is a known gap. Users are only ever
disabled, never deleted (so the audit log stays attributable), which means a disabled user's email address
cannot be invited again.
