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
| store | `woo-store-api` | `consumer-key` (`ck_` + 40 hex), `consumer-secret` (`cs_` + 40 hex) — WooCommerce REST key of the `mcp-bot` shop_manager user |
| store + platform | `woo-mcp-auth` | `token` — bearer the gateway sends to woo-mcp (same value in both namespaces) |
| mcp-upstreams + platform | `supplier-mcp-auth` | `token` — bearer the gateway sends to supplier-mcp |
| platform | `gateway-postgres` | `password` |
| platform | `gateway-internal` | `api-key-pepper`, `credentials-key` (base64, 32 bytes, AES-256-GCM), `chat-jwt-key`, `session-secret` |
| platform | `gateway-bootstrap-admin` | `email`, `password` (from `.env`) |
| platform | `gateway-llm` | `anthropic-api-key` (from `.env`) |
| platform | `gateway-upstream-seed` | `firecrawl-api-key`, `agentmail-api-key` (from `.env`) |

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

Locally images are loaded with `k3d image import <img> -c urumi` and `imagePullPolicy: IfNotPresent` (never `:latest`).
In production the registry prefix is `ghcr.io/galabavamsi/` and tags are git SHAs.

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

## NetworkPolicy behaviour on k3s (kube-router)
A blocked connection is **refused** (ECONNREFUSED in a few ms), not dropped, so callers never wait for a
timeout. A Service with zero ready pods is refused the same way, so "blocked" and "down" look identical
from the client side; the gateway's health checks must report which one it is.
Verified by `scripts/e2e-store.mjs` checks (f) and (g).

## Store defaults (values)
Country `IN:KA`, currency `INR`, timezone `Asia/Kolkata`, store name `Urumi Demo Store`, Storefront theme, Cash on Delivery enabled,
shipping disabled (`woocommerce_ship_to_countries=disabled`), guest checkout on, HPOS enabled, coming-soon mode off.
Local host `store.127-0-0-1.sslip.io`; production `store.urumi.humanslop.in`.
