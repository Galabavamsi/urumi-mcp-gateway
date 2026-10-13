# Component contracts

Single source of truth for names, ports, labels, env vars and Secrets shared between components and Helm charts.
Change this file first when changing an interface.

## Namespaces (created by `cluster/namespaces.yaml`, never by charts)
| Namespace | Holds |
|---|---|
| `store` | WordPress+WooCommerce (`wordpress`), MariaDB (`mariadb`), our `woo-mcp` |
| `platform` | `gateway` backend, `dashboard`, `postgres` |
| `mcp-upstreams` | `supplier-mcp` (and any future in-cluster MCP servers) |

## Common labels
Every pod: `app.kubernetes.io/name: <component>`, `app.kubernetes.io/instance: <release>`, `app.kubernetes.io/part-of: urumi`.
**Gateway pods** additionally carry `app.kubernetes.io/component: gateway`. Upstream MCP NetworkPolicies allow ingress only from
pods matching `{namespace: platform} AND {app.kubernetes.io/component: gateway}`.

## Secrets (created by `scripts/secrets.sh`; charts reference them via `existingSecret`)
| Namespace | Secret | Keys |
|---|---|---|
| store | `woo-store-db` | `root-password`, `password` (MariaDB user `wordpress`, database `wordpress`) |
| store | `woo-store-wp` | `admin-password`, `auth-key`, `secure-auth-key`, `logged-in-key`, `nonce-key`, `auth-salt`, `secure-auth-salt`, `logged-in-salt`, `nonce-salt` |
| store | `woo-store-api` | `consumer-key` (`ck_` + 40 hex), `consumer-secret` (`cs_` + 40 hex) — WooCommerce REST key of the `mcp-bot` user (role `urumi_mcp_bot`: products and orders only, no deletes, settings or customers) |
| store + platform | `woo-mcp-auth` | `token` — bearer the gateway sends to woo-mcp (same value in both namespaces) |
| mcp-upstreams + platform | `supplier-mcp-auth` | `token` — bearer the gateway sends to supplier-mcp |
| platform | `gateway-postgres` | `password` |
| platform | `gateway-internal` | `api-key-pepper`, `credentials-key` (base64, 32 bytes, AES-256-GCM), `chat-jwt-key`, `session-secret` |
| platform | `gateway-bootstrap-admin` | `email`, `password` (from `.env`) |
| platform | `gateway-llm` | `anthropic-api-key` (from `.env`) |
| platform | `gateway-upstream-seed` | `firecrawl-api-key`, `agentmail-api-key` (from `.env`) |
| store + platform + mcp-upstreams | `ghcr-pull` | VPS only, and only while the GHCR packages are private: type `kubernetes.io/dockerconfigjson` with a classic `read:packages` token. Created by `scripts/vps/deploy.sh` from `GHCR_PULL_TOKEN` (environment or `.env`), never by the charts; `deploy.sh` passes `imagePullSecrets[0].name=ghcr-pull` to a release whenever the Secret exists in its namespace (`values-prod.yaml` keeps `imagePullSecrets: []`) |
| store, platform | `woo-store-tls`, `platform-tls` | VPS only: TLS certificates written by cert-manager (ClusterIssuer `letsencrypt-prod` or `letsencrypt-staging`, `cluster/cert-manager/cluster-issuers.yaml`) for the Ingresses' `tls.secretName`; never created by hand |

## Services (ClusterIP unless noted)
| Service | Namespace | Port | Reached by |
|---|---|---|---|
| `wordpress` | store | 8080 | Traefik (Ingress `store.<baseDomain>`), woo-mcp, wp-cron CronJob |
| `mariadb` | store | 3306 | wordpress pods only |
| `woo-mcp` | store | 8080 (`POST /mcp`, `GET /healthz`, `GET /readyz`) | gateway pods only |
| `supplier-mcp` | mcp-upstreams | 8080 (same endpoints) | gateway pods only |

## Container images
| Image (local tag) | Built from | Runs as |
|---|---|---|
| `urumi/wordpress:<tag>` | `images/wordpress/` (FROM `wordpress:7.1.3-php8.3-apache`, WooCommerce + Storefront + WP-CLI baked in, Apache on :8080) | uid 33 (www-data) |
| `urumi/woo-mcp:<tag>` | `docker/node-service.Dockerfile --build-arg APP=woo-mcp` | uid 1000 (node) |
| `urumi/supplier-mcp:<tag>` | `docker/node-service.Dockerfile --build-arg APP=supplier-mcp` | uid 1000 (node) |
| `urumi/gateway:<tag>` | `docker/node-service.Dockerfile --build-arg APP=gateway` | uid 1000 (node) |
| `urumi/dashboard:<tag>` | `docker/dashboard.Dockerfile` (nginx-unprivileged) | uid 101 (nginx) |

Locally images are loaded with `k3d image import <img> -c urumi` and `imagePullPolicy: IfNotPresent` (never `:latest`).
In production the registry prefix is `ghcr.io/galabavamsi/` (replacing `urumi/`) and the tag is the first 7 hex digits of the git commit
(`${GITHUB_SHA::7}`): `ghcr.io/galabavamsi/{wordpress,woo-mcp,supplier-mcp,gateway,dashboard}`. CI (`.github/workflows/ci.yml`, job
`images`, pushes to `main` only) pushes exactly these five names, each also tagged with the full SHA, never `latest`.
Pass tags with `--set-string` (a short SHA can be all digits).

## woo-mcp environment
| Var | Example | Meaning |
|---|---|---|
| `MCP_AUTH_TOKEN` | (Secret `woo-mcp-auth/token`) | Required bearer on `/mcp` |
| `WOO_BASE_URL` | `http://wordpress.store.svc.cluster.local:8080` | Where requests are SENT (in-cluster, plain HTTP) |
| `WOO_HOME_URL` | `http://store.127-0-0-1.sslip.io` | The store's public home URL (= `WP_HOME`). WooCommerce builds the OAuth 1.0a signature base from its home URL host with scheme `http` (because the in-cluster hop is not TLS), not from the Host we connect to |
| `WOO_CONSUMER_KEY` / `WOO_CONSUMER_SECRET` | (Secret `woo-store-api`) | OAuth 1.0a one-legged, HMAC-SHA256 |
| `STORE_TZ` | `Asia/Kolkata` | Store timezone; "today" is computed in this zone |
| `WOO_TIMEOUT_MS` | `8000` | Per request to WooCommerce |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` (packages/mcp-common) |

## supplier-mcp environment
| Var | Default | Meaning |
|---|---|---|
| `MCP_AUTH_TOKEN` | (Secret `supplier-mcp-auth/token`) | Required bearer on `/mcp`, at least 16 characters |
| `CATALOG_PATH` | unset | Optional JSON catalog file (mounted from a ConfigMap); the built-in catalog otherwise |
| `PORT` | `8080` | Listen port |
| `LOG_LEVEL` | `info` | As above |
| `DEMO_SLOW_TOOL` | `false` | `true` adds `slow_lookup {seconds}` (gateway timeout demo) |
| `DEMO_POISONED_DESCRIPTION` | `false` | `true` appends a labelled prompt-injection text to `check_stock`'s description (threat-model demo) |

## Platform (namespace `platform`, chart `charts/platform`, release `platform`)
| Service | Port | Reached by |
|---|---|---|
| `gateway` | 8080 (`/api/*`, `/mcp`, `/healthz`, `/readyz`) | Traefik (Ingress `app.<baseDomain>` paths `/api` and `/mcp`) |
| `gateway-metrics` | 9091 (`/metrics`) | in-cluster only (never on the Ingress) |
| `dashboard` | 8080 (static SPA via nginx-unprivileged) | Traefik (Ingress `app.<baseDomain>` path `/`) |
| `postgres` | 5432 | gateway pods only |

Gateway pods carry `app.kubernetes.io/component: gateway` (the label upstream NetworkPolicies trust).
Ingress host: local `app.127-0-0-1.sslip.io`, production `app.urumi.humanslop.in`. MCP URL for clients: `<PUBLIC_BASE_URL>/mcp`.

Images: `urumi/gateway:<tag>` (`docker/node-service.Dockerfile --build-arg APP=gateway`; uid 1000, read-only root filesystem), `urumi/dashboard:<tag>` (`docker/dashboard.Dockerfile`; nginx-unprivileged as uid 101 on :8080, read-only root filesystem with an **emptyDir at `/tmp` (required)**), Postgres `postgres:18.6-trixie` pinned (uid 999, PVC mounted at `/var/lib/postgresql`).

### gateway environment
| Var | Source / example | Meaning |
|---|---|---|
| `PORT` | `8080` | Public HTTP listener (`/api`, `/mcp`, health) |
| `INTERNAL_MCP_PORT` | `8081` | Loopback-only (127.0.0.1) MCP listener used by the chat agent; accepts only chat JWTs |
| `METRICS_PORT` | `9091` | Prometheus `/metrics` |
| `PGHOST` / `PGPORT` / `PGDATABASE` / `PGUSER` | `postgres` / `5432` / `gateway` / `gateway` | Postgres connection |
| `PGPASSWORD` | Secret `gateway-postgres/password` | |
| `API_KEY_PEPPER` | Secret `gateway-internal/api-key-pepper` | HMAC-SHA256 key for hashing API keys |
| `CREDENTIALS_KEY` | Secret `gateway-internal/credentials-key` | base64 32 bytes, AES-256-GCM for upstream credentials at rest |
| `CHAT_JWT_KEY` | Secret `gateway-internal/chat-jwt-key` | HS256 key for the chat agent's 5-minute on-behalf-of tokens |
| `SESSION_SECRET` | Secret `gateway-internal/session-secret` | HMAC key for session-token hashing |
| `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` | Secret `gateway-bootstrap-admin` | First admin, created only when the users table is empty |
| `ANTHROPIC_API_KEY` | Secret `gateway-llm/anthropic-api-key` | Chat agent LLM |
| `LLM_MODEL` | `claude-haiku-5-5` | |
| `PUBLIC_BASE_URL` | `http://app.127-0-0-1.sslip.io` | Shown in the UI (MCP URL, invite links) |
| `COOKIE_SECURE` | `false` local / `true` prod | Session cookie `Secure` flag |
| `STORE_TZ` | `Asia/Kolkata` | Chat system prompt ("today") |
| `SEED_SERVERS_FILE` | `/config/servers.json` (ConfigMap) | Upstreams pre-registered at startup (see below) |
| `STORE_URL` | optional, e.g. `http://store.127-0-0-1.sslip.io` | Storefront link in `/api/config`; default = `PUBLIC_BASE_URL` with `app.` replaced by `store.` |
| `SEED_WOO_TOKEN` | Secret `woo-mcp-auth/token` | Credential for seed `woo` |
| `SEED_SUPPLIER_TOKEN` | Secret `supplier-mcp-auth/token` | Credential for seed `supplier` |
| `SEED_FIRECRAWL_KEY` / `SEED_AGENTMAIL_KEY` | Secret `gateway-upstream-seed` (optional) | Credentials for seeds `firecrawl`, `mail` |
| `INTERNAL_HOST_ALLOWLIST` | `woo-mcp.store.svc.cluster.local,supplier-mcp.mcp-upstreams.svc.cluster.local` | The only cluster-internal hosts an upstream URL may point at (SSRF guard); everything else must be public HTTPS |
| `HEALTH_INTERVAL_MS` / `DEFAULT_CALL_TIMEOUT_MS` | `5000` / `10000` | Upstream health loop / per-call timeout default |
| `LOG_LEVEL` | `info` | |

### Seed file (`servers.json`, rendered from Helm values)
```json
[
  { "slug": "woo", "name": "WooCommerce store", "url": "http://woo-mcp.store.svc.cluster.local:8080/mcp",
    "auth": { "type": "bearer", "secretEnv": "SEED_WOO_TOKEN" }, "timeoutMs": 10000 },
  { "slug": "supplier", "name": "Supplier catalog", "url": "http://supplier-mcp.mcp-upstreams.svc.cluster.local:8080/mcp",
    "auth": { "type": "bearer", "secretEnv": "SEED_SUPPLIER_TOKEN" }, "timeoutMs": 10000 },
  { "slug": "firecrawl", "name": "Firecrawl", "url": "https://mcp.firecrawl.dev/v2/mcp",
    "auth": { "type": "bearer", "secretEnv": "SEED_FIRECRAWL_KEY" }, "timeoutMs": 30000,
    "toolAllowlist": ["firecrawl_scrape", "firecrawl_search", "firecrawl_map"] },
  { "slug": "mail", "name": "AgentMail (urumi@agentmail.to)", "url": "https://mcp.agentmail.to/mcp",
    "auth": { "type": "header", "headerName": "x-api-key", "secretEnv": "SEED_AGENTMAIL_KEY" }, "timeoutMs": 30000,
    "toolAllowlist": ["send_message"] }
]
```
Seeding semantics: a seed is inserted only if no row (including soft-deleted ones) has that slug, so an admin's delete or edit survives restarts.
Each `secretEnv` must match `^SEED_[A-Z0-9_]+# Component contracts

Single source of truth for names, ports, labels, env vars and Secrets shared between components and Helm charts.
Change this file first when changing an interface.

## Namespaces (created by `cluster/namespaces.yaml`, never by charts)
| Namespace | Holds |
|---|---|
| `store` | WordPress+WooCommerce (`wordpress`), MariaDB (`mariadb`), our `woo-mcp` |
| `platform` | `gateway` backend, `dashboard`, `postgres` |
| `mcp-upstreams` | `supplier-mcp` (and any future in-cluster MCP servers) |

## Common labels
Every pod: `app.kubernetes.io/name: <component>`, `app.kubernetes.io/instance: <release>`, `app.kubernetes.io/part-of: urumi`.
**Gateway pods** additionally carry `app.kubernetes.io/component: gateway`. Upstream MCP NetworkPolicies allow ingress only from
pods matching `{namespace: platform} AND {app.kubernetes.io/component: gateway}`.

## Secrets (created by `scripts/secrets.sh`; charts reference them via `existingSecret`)
| Namespace | Secret | Keys |
|---|---|---|
| store | `woo-store-db` | `root-password`, `password` (MariaDB user `wordpress`, database `wordpress`) |
| store | `woo-store-wp` | `admin-password`, `auth-key`, `secure-auth-key`, `logged-in-key`, `nonce-key`, `auth-salt`, `secure-auth-salt`, `logged-in-salt`, `nonce-salt` |
| store | `woo-store-api` | `consumer-key` (`ck_` + 40 hex), `consumer-secret` (`cs_` + 40 hex) — WooCommerce REST key of the `mcp-bot` user (role `urumi_mcp_bot`: products and orders only, no deletes, settings or customers) |
| store + platform | `woo-mcp-auth` | `token` — bearer the gateway sends to woo-mcp (same value in both namespaces) |
| mcp-upstreams + platform | `supplier-mcp-auth` | `token` — bearer the gateway sends to supplier-mcp |
| platform | `gateway-postgres` | `password` |
| platform | `gateway-internal` | `api-key-pepper`, `credentials-key` (base64, 32 bytes, AES-256-GCM), `chat-jwt-key`, `session-secret` |
| platform | `gateway-bootstrap-admin` | `email`, `password` (from `.env`) |
| platform | `gateway-llm` | `anthropic-api-key` (from `.env`) |
| platform | `gateway-upstream-seed` | `firecrawl-api-key`, `agentmail-api-key` (from `.env`) |
| store + platform + mcp-upstreams | `ghcr-pull` | VPS only, and only while the GHCR packages are private: type `kubernetes.io/dockerconfigjson` with a classic `read:packages` token. Created by `scripts/vps/deploy.sh` from `GHCR_PULL_TOKEN` (environment or `.env`), never by the charts; `deploy.sh` passes `imagePullSecrets[0].name=ghcr-pull` to a release whenever the Secret exists in its namespace (`values-prod.yaml` keeps `imagePullSecrets: []`) |
| store, platform | `woo-store-tls`, `platform-tls` | VPS only: TLS certificates written by cert-manager (ClusterIssuer `letsencrypt-prod` or `letsencrypt-staging`, `cluster/cert-manager/cluster-issuers.yaml`) for the Ingresses' `tls.secretName`; never created by hand |

## Services (ClusterIP unless noted)
| Service | Namespace | Port | Reached by |
|---|---|---|---|
| `wordpress` | store | 8080 | Traefik (Ingress `store.<baseDomain>`), woo-mcp, wp-cron CronJob |
| `mariadb` | store | 3306 | wordpress pods only |
| `woo-mcp` | store | 8080 (`POST /mcp`, `GET /healthz`, `GET /readyz`) | gateway pods only |
| `supplier-mcp` | mcp-upstreams | 8080 (same endpoints) | gateway pods only |

## Container images
| Image (local tag) | Built from | Runs as |
|---|---|---|
| `urumi/wordpress:<tag>` | `images/wordpress/` (FROM `wordpress:7.1.3-php8.3-apache`, WooCommerce + Storefront + WP-CLI baked in, Apache on :8080) | uid 33 (www-data) |
| `urumi/woo-mcp:<tag>` | `docker/node-service.Dockerfile --build-arg APP=woo-mcp` | uid 1000 (node) |
| `urumi/supplier-mcp:<tag>` | `docker/node-service.Dockerfile --build-arg APP=supplier-mcp` | uid 1000 (node) |
| `urumi/gateway:<tag>` | `docker/node-service.Dockerfile --build-arg APP=gateway` | uid 1000 (node) |
| `urumi/dashboard:<tag>` | `docker/dashboard.Dockerfile` (nginx-unprivileged) | uid 101 (nginx) |

Locally images are loaded with `k3d image import <img> -c urumi` and `imagePullPolicy: IfNotPresent` (never `:latest`).
In production the registry prefix is `ghcr.io/galabavamsi/` (replacing `urumi/`) and the tag is the first 7 hex digits of the git commit
(`${GITHUB_SHA::7}`): `ghcr.io/galabavamsi/{wordpress,woo-mcp,supplier-mcp,gateway,dashboard}`. CI (`.github/workflows/ci.yml`, job
`images`, pushes to `main` only) pushes exactly these five names, each also tagged with the full SHA, never `latest`.
Pass tags with `--set-string` (a short SHA can be all digits).

## woo-mcp environment
| Var | Example | Meaning |
|---|---|---|
| `MCP_AUTH_TOKEN` | (Secret `woo-mcp-auth/token`) | Required bearer on `/mcp` |
| `WOO_BASE_URL` | `http://wordpress.store.svc.cluster.local:8080` | Where requests are SENT (in-cluster, plain HTTP) |
| `WOO_HOME_URL` | `http://store.127-0-0-1.sslip.io` | The store's public home URL (= `WP_HOME`). WooCommerce builds the OAuth 1.0a signature base from its home URL host with scheme `http` (because the in-cluster hop is not TLS), not from the Host we connect to |
| `WOO_CONSUMER_KEY` / `WOO_CONSUMER_SECRET` | (Secret `woo-store-api`) | OAuth 1.0a one-legged, HMAC-SHA256 |
| `STORE_TZ` | `Asia/Kolkata` | Store timezone; "today" is computed in this zone |
| `WOO_TIMEOUT_MS` | `8000` | Per request to WooCommerce |
| `LOG_LEVEL` | `info` | `debug` \| `info` \| `warn` \| `error` (packages/mcp-common) |

## supplier-mcp environment
| Var | Default | Meaning |
|---|---|---|
| `MCP_AUTH_TOKEN` | (Secret `supplier-mcp-auth/token`) | Required bearer on `/mcp`, at least 16 characters |
| `CATALOG_PATH` | unset | Optional JSON catalog file (mounted from a ConfigMap); the built-in catalog otherwise |
| `PORT` | `8080` | Listen port |
| `LOG_LEVEL` | `info` | As above |
| `DEMO_SLOW_TOOL` | `false` | `true` adds `slow_lookup {seconds}` (gateway timeout demo) |
| `DEMO_POISONED_DESCRIPTION` | `false` | `true` appends a labelled prompt-injection text to `check_stock`'s description (threat-model demo) |

## Platform (namespace `platform`, chart `charts/platform`, release `platform`)
| Service | Port | Reached by |
|---|---|---|
| `gateway` | 8080 (`/api/*`, `/mcp`, `/healthz`, `/readyz`) | Traefik (Ingress `app.<baseDomain>` paths `/api` and `/mcp`) |
| `gateway-metrics` | 9091 (`/metrics`) | in-cluster only (never on the Ingress) |
| `dashboard` | 8080 (static SPA via nginx-unprivileged) | Traefik (Ingress `app.<baseDomain>` path `/`) |
| `postgres` | 5432 | gateway pods only |

Gateway pods carry `app.kubernetes.io/component: gateway` (the label upstream NetworkPolicies trust).
Ingress host: local `app.127-0-0-1.sslip.io`, production `app.urumi.humanslop.in`. MCP URL for clients: `<PUBLIC_BASE_URL>/mcp`.

Images: `urumi/gateway:<tag>` (`docker/node-service.Dockerfile --build-arg APP=gateway`; uid 1000, read-only root filesystem), `urumi/dashboard:<tag>` (`docker/dashboard.Dockerfile`; nginx-unprivileged as uid 101 on :8080, read-only root filesystem with an **emptyDir at `/tmp` (required)**), Postgres `postgres:18.6-trixie` pinned (uid 999, PVC mounted at `/var/lib/postgresql`).

### gateway environment
| Var | Source / example | Meaning |
|---|---|---|
| `PORT` | `8080` | Public HTTP listener (`/api`, `/mcp`, health) |
| `INTERNAL_MCP_PORT` | `8081` | Loopback-only (127.0.0.1) MCP listener used by the chat agent; accepts only chat JWTs |
| `METRICS_PORT` | `9091` | Prometheus `/metrics` |
| `PGHOST` / `PGPORT` / `PGDATABASE` / `PGUSER` | `postgres` / `5432` / `gateway` / `gateway` | Postgres connection |
| `PGPASSWORD` | Secret `gateway-postgres/password` | |
| `API_KEY_PEPPER` | Secret `gateway-internal/api-key-pepper` | HMAC-SHA256 key for hashing API keys |
| `CREDENTIALS_KEY` | Secret `gateway-internal/credentials-key` | base64 32 bytes, AES-256-GCM for upstream credentials at rest |
| `CHAT_JWT_KEY` | Secret `gateway-internal/chat-jwt-key` | HS256 key for the chat agent's 5-minute on-behalf-of tokens |
| `SESSION_SECRET` | Secret `gateway-internal/session-secret` | HMAC key for session-token hashing |
| `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` | Secret `gateway-bootstrap-admin` | First admin, created only when the users table is empty |
| `ANTHROPIC_API_KEY` | Secret `gateway-llm/anthropic-api-key` | Chat agent LLM |
| `LLM_MODEL` | `claude-haiku-5-5` | |
| `PUBLIC_BASE_URL` | `http://app.127-0-0-1.sslip.io` | Shown in the UI (MCP URL, invite links) |
| `COOKIE_SECURE` | `false` local / `true` prod | Session cookie `Secure` flag |
| `STORE_TZ` | `Asia/Kolkata` | Chat system prompt ("today") |
| `SEED_SERVERS_FILE` | `/config/servers.json` (ConfigMap) | Upstreams pre-registered at startup (see below) |
| `STORE_URL` | optional, e.g. `http://store.127-0-0-1.sslip.io` | Storefront link in `/api/config`; default = `PUBLIC_BASE_URL` with `app.` replaced by `store.` |
| `SEED_WOO_TOKEN` | Secret `woo-mcp-auth/token` | Credential for seed `woo` |
| `SEED_SUPPLIER_TOKEN` | Secret `supplier-mcp-auth/token` | Credential for seed `supplier` |
| `SEED_FIRECRAWL_KEY` / `SEED_AGENTMAIL_KEY` | Secret `gateway-upstream-seed` (optional) | Credentials for seeds `firecrawl`, `mail` |
| `INTERNAL_HOST_ALLOWLIST` | `woo-mcp.store.svc.cluster.local,supplier-mcp.mcp-upstreams.svc.cluster.local` | The only cluster-internal hosts an upstream URL may point at (SSRF guard); everything else must be public HTTPS |
| `HEALTH_INTERVAL_MS` / `DEFAULT_CALL_TIMEOUT_MS` | `5000` / `10000` | Upstream health loop / per-call timeout default |
| `LOG_LEVEL` | `info` | |

### Seed file (`servers.json`, rendered from Helm values)
```json
[
  { "slug": "woo", "name": "WooCommerce store", "url": "http://woo-mcp.store.svc.cluster.local:8080/mcp",
    "auth": { "type": "bearer", "secretEnv": "SEED_WOO_TOKEN" }, "timeoutMs": 10000 },
  { "slug": "supplier", "name": "Supplier catalog", "url": "http://supplier-mcp.mcp-upstreams.svc.cluster.local:8080/mcp",
    "auth": { "type": "bearer", "secretEnv": "SEED_SUPPLIER_TOKEN" }, "timeoutMs": 10000 },
  { "slug": "firecrawl", "name": "Firecrawl", "url": "https://mcp.firecrawl.dev/v2/mcp",
    "auth": { "type": "bearer", "secretEnv": "SEED_FIRECRAWL_KEY" }, "timeoutMs": 30000,
    "toolAllowlist": ["firecrawl_scrape", "firecrawl_search", "firecrawl_map"] },
  { "slug": "mail", "name": "AgentMail (urumi@agentmail.to)", "url": "https://mcp.agentmail.to/mcp",
    "auth": { "type": "header", "headerName": "x-api-key", "secretEnv": "SEED_AGENTMAIL_KEY" }, "timeoutMs": 30000,
    "toolAllowlist": ["send_message"] }
]
```
 (the gateway refuses others, so a seed file can never read a core variable such as `API_KEY_PEPPER`).
Exception: a seed's **credential** is re-synced from its env var on every start (the Secret is the source of truth, so rotation = update Secret + restart),
but only while the row still points where the seed says (same URL, auth type and header name). A seed server an admin re-pointed keeps the
credential the admin entered, and the start logs `seed server was re-pointed by an admin; credential not re-synced`.
A seed whose `secretEnv` is unset/empty is skipped with a log line.

### Tool exposure rules
Exposed name = `<slug>__<toolName>` (slug `^[a-z][a-z0-9-]{1,11}$`, immutable; tool name sanitized to `[A-Za-z0-9_-]`; total ≤ 48 chars,
overflow → first 41 chars + `_` + 6 hex of sha256). Routing uses a lookup table `exposedName → (serverId, originalName)`, never string splitting.
Description shown to models = `[<slug>] ` + upstream description with control/zero-width/bidi/tag characters removed, capped at 1500 chars.
Input schema = the upstream's own, with every `description` (cap 1500) and `title` (cap 200) string inside it cleaned the same way; names,
`enum`, `const`, `default` and `pattern` values are never changed (the upstream validates against them). A tool is **not exposed** (warning
logged with server and tool name only) when its schema is over 32 KB of JSON or still holds invisible characters after cleaning.
Annotations = only `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint` (booleans) and a cleaned `title`. Hints are trusted
only from in-cluster servers (host in `INTERNAL_HOST_ALLOWLIST`); every third-party tool gets `readOnlyHint: false, destructiveHint: true,
openWorldHint: true`. The chat agent asks the user before any tool whose hints say destructive or outbound (`apps/gateway/src/chat/confirm.ts`).
A description or schema text with phrases typical of prompt injection is flagged (`suspicious` in the API, a warning in the log), not removed.

## Backups (`backup.enabled`, charts `woo-store` and `platform`; off locally, on in `values-prod.yaml`)
| Release / namespace | CronJob (schedule, IST) | PVC (kept by Helm) | Dump file name |
|---|---|---|---|
| `woo-store` / `store` | `mariadb-backup` (02:00) | `mariadb-backups` | `wordpress-YYYYMMDDTHHMMSSZ.sql.gz` (mariadb-dump, gzip) |
| `platform` / `platform` | `postgres-backup` (02:15) | `postgres-backups` | `gateway-YYYYMMDDTHHMMSSZ.dump` (pg_dump `-Fc`) |

`app.kubernetes.io/name` values the backups use (the NetworkPolicies key on them, so nothing else may carry them):
- `mariadb-backup`, `postgres-backup`: the backup pods' network identity. `backup-networkpolicy.yaml` opens exactly these pods → the
  database port (+ DNS); the restore pod of `scripts/backup/restore-*.sh` carries it on purpose.
- `mariadb-backup-volume`, `postgres-backup-volume`: the one-shot volume-check Job (`*-backup-volume-<hash>`); no network.
- `backup-tools`: helper pods of `scripts/backup/*.sh` (verify, fetch); no network.

The dumps log in as the app user (`woo-store-db/password`, `gateway-postgres/password`), never as root. Scripts: `scripts/backup/README.md`.

## NetworkPolicy behaviour on k3s (kube-router)
A blocked connection is **refused** (ECONNREFUSED in a few ms), not dropped, so callers never wait for a
timeout. A Service with zero ready pods is refused the same way, so "blocked" and "down" look identical
from the client side; the gateway's health checks must report which one it is.
Verified by `scripts/e2e-store.mjs` checks (f) and (g).

## Store defaults (values)
Country `IN:KA`, currency `INR`, timezone `Asia/Kolkata`, store name `Urumi Demo Store`, Storefront theme, Cash on Delivery enabled,
shipping disabled (`woocommerce_ship_to_countries=disabled`), guest checkout on, HPOS enabled, coming-soon mode off.
Local host `store.127-0-0-1.sslip.io`; production `store.urumi.humanslop.in`.
