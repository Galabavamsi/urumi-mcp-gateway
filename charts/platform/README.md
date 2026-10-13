# platform chart

The team MCP platform in namespace `platform` (release `platform`): the gateway backend, the dashboard,
the gateway's Postgres, one Ingress and the NetworkPolicies around them. Names, ports, labels, env vars
and Secrets follow `docs/CONTRACTS.md` ("Platform", "gateway environment", "Seed file").

| Object | Kind | Notes |
|---|---|---|
| `gateway` | Deployment (1 replica, rolling: new pod ready before the old one stops) + Service `:8080` | Image `urumi/gateway` (`docker/node-service.Dockerfile --build-arg APP=gateway`), uid 1000. `/api` (dashboard REST), `/mcp` (MCP endpoint), `/healthz` (liveness, startup), `/readyz` (readiness: Postgres reachable, never upstream health). Pods carry `app.kubernetes.io/component: gateway`, the label the upstream NetworkPolicies trust. |
| `gateway-metrics` | Service `:9091` | Prometheus `/metrics`. In-cluster only: never on the Ingress, and closed by NetworkPolicy unless `networkPolicy.metricsFrom` names a scraper. |
| `gateway-seed-servers` | ConfigMap | `servers.json` (the upstreams registered at startup), mounted read-only at `/config`. Rendered from `gateway.seedServers`; a checksum annotation rolls the gateway when it changes. |
| `dashboard` | Deployment + Service `:8080` | Image `urumi/dashboard` (nginx-unprivileged serving the React build), uid 101. Probes on `/healthz`. |
| `postgres` | StatefulSet + Service `:5432` | `postgres:18.6-trixie`, uid 999, data on a `volumeClaimTemplate` mounted at `/var/lib/postgresql`. `pg_isready` probes. |
| `app` | Ingress | `app.<domain>`: `/api` and `/mcp` → gateway, `/` → dashboard (Traefik). |
| `platform-*` | NetworkPolicy ×5 | Default deny, then one allow per path (below). |

Every container runs as non-root with a read-only root filesystem (writable `emptyDir`s only where the
program needs them), no privilege escalation, all capabilities dropped, seccomp `RuntimeDefault`, no
service-account token, and requests and limits. Images must be pinned: an empty or `latest` tag fails the
render.

The chart never creates Secrets or namespaces (`scripts/secrets.sh` does both).

## Install

```bash
# local (k3d), inside WSL from the repo root: build, load, install (scripts/dev-up.sh does all of this)
TAG=$(git rev-parse --short HEAD)
docker build --network=host -f docker/node-service.Dockerfile --build-arg APP=gateway -t urumi/gateway:$TAG .
docker build --network=host -f docker/dashboard.Dockerfile -t urumi/dashboard:$TAG .
k3d image import urumi/gateway:$TAG urumi/dashboard:$TAG -c urumi
helm upgrade --install platform charts/platform -n platform -f charts/platform/values-local.yaml \
  --set-string gateway.image.tag=$TAG --set-string dashboard.image.tag=$TAG \
  --wait --timeout 10m --rollback-on-failure

# production (k3s on the VPS): images from GHCR, tagged with the git SHA
helm upgrade --install platform charts/platform -n platform -f charts/platform/values-prod.yaml \
  --set-string gateway.image.tag=$SHA --set-string dashboard.image.tag=$SHA \
  --wait --timeout 10m --rollback-on-failure
```

`--set-string`, not `--set`: a short SHA can be all digits, which `--set` turns into a number.

To bring up only Postgres and the NetworkPolicies (e.g. before the gateway image exists), add
`--set gateway.enabled=false --set dashboard.enabled=false`. No image tags are needed then.

`values.yaml` holds the defaults. The environment files override only what differs:

| | `values-local.yaml` | `values-prod.yaml` |
|---|---|---|
| Host | `app.127-0-0-1.sslip.io` | `app.urumi.humanslop.in` |
| `PUBLIC_BASE_URL` | `http://app.127-0-0-1.sslip.io` | `https://app.urumi.humanslop.in` |
| `COOKIE_SECURE` | `false` | `true` |
| TLS | off | cert-manager (`cert-manager.io/cluster-issuer: letsencrypt-prod`) + `tls` block, Secret `platform-tls` |
| Images | `urumi/{gateway,dashboard}:<tag>` (via `k3d image import`) | `ghcr.io/galabavamsi/{gateway,dashboard}:<sha>` (plus `imagePullSecrets` if the packages are private) |
| Postgres volume | 1Gi, default StorageClass | 5Gi, `storageClass: local-path` |
| Resources | small requests | `values.yaml` defaults |

The chart refuses two easy mistakes in these values: a `publicBaseUrl` with a path or trailing slash (the
gateway appends `/mcp` to it), and a `cookieSecure` that does not match the URL's scheme (a `Secure` cookie
is dropped on plain http, so nobody could log in; a non-`Secure` one on https could leak over plain http).

To lint the prod file, pass the tags too:
`helm lint charts/platform -f charts/platform/values-prod.yaml --set-string gateway.image.tag=x --set-string dashboard.image.tag=x`.

## Secrets

All are created by `scripts/secrets.sh` and only referenced here by name (`secrets.*` and
`gateway.seedSecretEnv` in the values). Internal ones are generated once and never overwritten; external
ones are copied from the gitignored `.env` on every run.

| Secret | Keys → gateway env | Kind | If missing |
|---|---|---|---|
| `gateway-postgres` | `password` → `PGPASSWORD` (and Postgres' `POSTGRES_PASSWORD`) | internal | pods do not start |
| `gateway-internal` | `api-key-pepper`, `credentials-key`, `chat-jwt-key`, `session-secret` → `API_KEY_PEPPER`, `CREDENTIALS_KEY`, `CHAT_JWT_KEY`, `SESSION_SECRET` | internal | gateway does not start |
| `woo-mcp-auth`, `supplier-mcp-auth` | `token` → `SEED_WOO_TOKEN`, `SEED_SUPPLIER_TOKEN` | internal (same value as in `store` / `mcp-upstreams`) | gateway does not start |
| `gateway-bootstrap-admin` | `email`, `password` → `BOOTSTRAP_ADMIN_*` | from `.env` | gateway starts (`optional: true`); no first admin is created |
| `gateway-llm` | `anthropic-api-key` → `ANTHROPIC_API_KEY` | from `.env` | gateway starts; chat is unavailable |
| `gateway-upstream-seed` | `firecrawl-api-key`, `agentmail-api-key` → `SEED_FIRECRAWL_KEY`, `SEED_AGENTMAIL_KEY` | from `.env` | gateway starts; that seed is skipped (logged) |

The first admin is created from `gateway-bootstrap-admin` only while the users table is empty.

**Rotating.** The chart does not see Secret contents, so after changing one run
`kubectl -n platform rollout restart deploy/gateway`. Seed credentials are re-read on every start (the
Secret is the source of truth). The **Postgres password is different**: Postgres stores it inside the
database at first start, so changing `gateway-postgres` alone locks the gateway out. Change it in both
places:

```bash
kubectl -n platform exec -it postgres-0 -- psql -U gateway -d gateway -c '\password gateway'
# then put the same value into Secret gateway-postgres and restart the gateway
```

## Seed servers

`gateway.seedServers` renders to `/config/servers.json`, exactly the example in `docs/CONTRACTS.md`:
`woo` and `supplier` (in-cluster, bearer token), `firecrawl` (Bearer) and `mail` (AgentMail, `x-api-key`
header), the last two with tool allowlists. The file holds only names, URLs and the *name* of the env var
with each credential. Every `auth.secretEnv` must appear in `gateway.seedSecretEnv` (the render fails
otherwise, instead of the gateway silently skipping the seed), and those variable names must start with
`SEED_` so a seed can never replace a core variable such as `PGPASSWORD`.

A seed is inserted only if no row has its slug, so an admin's edit or delete in the dashboard survives
restarts and upgrades. Changing a seed's URL in the values therefore does not change an existing row.

## Network policies

Every pod of the release starts with no traffic in or out. These paths are then allowed:

| From | To | Port |
|---|---|---|
| Traefik (`kube-system`, `app.kubernetes.io/name=traefik`) | gateway, dashboard | 8080 |
| pods labelled `app.kubernetes.io/component=gateway` in `platform` | postgres | 5432 |
| gateway | woo-mcp (`store`, `app.kubernetes.io/name=woo-mcp`) | 8080 |
| gateway | supplier-mcp (`mcp-upstreams`, `app.kubernetes.io/name=supplier-mcp`) | 8080 |
| gateway | any public IP (Anthropic, Firecrawl, AgentMail, admin-added HTTPS upstreams) | 443 |
| `networkPolicy.metricsFrom` peers (none by default) | gateway | 9091 |
| every pod of the release | kube-dns | 53 |

The internet rule is `0.0.0.0/0` minus `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `100.64.0.0/10`,
`169.254.0.0/16` and `127.0.0.0/8`. That carve-out also covers the cluster's pod and Service networks, the
node itself and the cloud metadata endpoint `169.254.169.254`. It is a second layer under the gateway's own
SSRF guard, which resolves and checks every upstream URL at connect time and allows only the hosts in
`INTERNAL_HOST_ALLOWLIST` inside the cluster. Both lists are values; keep `gateway.internalHostAllowlist`
and `networkPolicy.upstreams` in step when adding an in-cluster server.

Verified on the k3d cluster from real pods (kubectl port-forward bypasses policies, so it proves nothing):

| Probe pod | Target | Result |
|---|---|---|
| `platform`, no labels | `postgres:5432` | refused |
| `platform`, `component=gateway` | `postgres:5432` | open (`pg_isready`: accepting connections) |
| `default`, `component=gateway` | `postgres:5432` | refused (the label alone is not enough outside `platform`) |
| gateway's labels | postgres, woo-mcp, supplier-mcp, `api.anthropic.com:443`, `mcp.firecrawl.dev:443`, `mcp.agentmail.to:443` | open |
| gateway's labels | `wordpress.store:8080`, `mariadb.store:3306`, the Kubernetes API, `169.254.169.254:80`, `example.com:80` | refused |
| dashboard's labels | postgres, woo-mcp, `api.anthropic.com:443` | refused (DNS still resolves) |

The rules have some limits:

- Kubelet probes come from the node and are always allowed.
- kube-router needs a few seconds before it applies policies to a brand-new pod, and connections that are already open survive a newly applied policy. Postgres therefore also requires a password for every network connection (`scram-sha-256`), and the upstreams require a bearer token.
- Any pod in `platform` labelled `component=gateway` gets the gateway's access. Only cluster admins can create pods there; that label is the gateway's network identity, which is why the `mcp-server` chart refuses it.
- A blocked connection is refused within about a second, not dropped, so it looks the same as a Service with no ready pods. The gateway's health checks tell the two apart.
- cert-manager's HTTP-01 solver pods (prod) carry none of this release's labels, so these policies do not restrict them.

## Postgres details

- **Volume path.** Postgres 18 images keep `PGDATA` at `/var/lib/postgresql/18/docker`, so the PVC is mounted at `/var/lib/postgresql`. Mounting it at `.../data`, as with older images, makes the container exit.
- **Shutdown.** Kubernetes stops containers with SIGTERM, which Postgres treats as a *smart* shutdown: it waits for every client to disconnect, and the gateway's connection pool never does. A `preStop` hook asks for a *fast* shutdown instead (`pg_ctl stop --mode=fast --no-wait`): open transactions roll back, a checkpoint is written, and the next start needs no crash recovery.
- **Probes.** `pg_isready` over TCP with `-U gateway -d gateway`. Without them it would use the OS user `postgres`, a role this database does not have.
- **Backups.** `kubectl -n platform exec postgres-0 -- pg_dump -U gateway gateway > gateway-$(date +%F).sql`; restore with `kubectl -n platform exec -i postgres-0 -- psql -U gateway -d gateway < file.sql`.

## Upgrades and rollback

```bash
helm history platform -n platform
helm rollback platform <revision> -n platform --wait
```

The gateway runs its **forward migrations at startup** (under a Postgres advisory lock, so two pods never
migrate at once). During a rolling upgrade the old and the new gateway run side by side against the same
database for a few seconds, and after a rollback the old code runs against the newer schema. So schema
changes should be **expand/contract**:

1. *Expand* (release N): only add things (new tables, nullable columns, new indexes). Old code ignores them.
2. Ship code that uses the new shape.
3. *Contract* (a later release, once nothing needs the old shape): drop or rename the old things.

A release without schema changes (most gateway and dashboard releases) rolls back freely. A release that
only expanded the schema also rolls back safely. Rolling back across a *contract* step is not safe: back
up first (above) and restore the dump together with the old image.

Postgres itself: a minor version bump (`18.6` → `18.7`) is an image change and rolls back freely. A major
version (`19`) needs `pg_upgrade` or dump/restore and is not done by this chart.

## Other operations

- **Volume size is fixed at first install.** A StatefulSet's `volumeClaimTemplates` cannot be changed, so editing `postgres.persistence.*` afterwards makes `helm upgrade` fail with "updates to statefulset spec ... are forbidden" (local-path volumes cannot grow anyway). To move to a bigger volume: back up, uninstall, delete the PVC, reinstall, restore.
- **Uninstalling.** `helm uninstall platform -n platform` keeps the data: the Postgres PVC is retained (`persistentVolumeClaimRetentionPolicy: Retain`) and a reinstall picks it up again. To really wipe it, also run `kubectl -n platform delete pvc data-postgres-0`.
- **Readiness.** `/readyz` checks Postgres only. An unreachable upstream MCP server must never take the whole gateway out of the Service; the dashboard shows it as Unreachable instead.
- **Metrics.** `kubectl -n platform port-forward svc/gateway-metrics 9091` and open `http://localhost:9091/metrics` (port-forward bypasses the NetworkPolicy, which is fine for an admin).
