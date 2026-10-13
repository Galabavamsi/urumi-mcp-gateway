# woo-mcp

Our own MCP server for the WooCommerce store: six tools over the store's products and orders. It runs in the
`store` namespace next to WordPress, has a ClusterIP Service only, and is reached by nothing but the gateway
(NetworkPolicy plus a bearer token). Clients see its tools as `woo__<tool>`.

It runs on the shared HTTP shell in `packages/mcp-common`, which provides the bearer check, `/healthz`,
`/readyz`, JSON logs, a drain on SIGTERM, and the stateless serving of both protocol eras (2026-07-28 and
legacy 2025-11-25).

## Tools

| Tool | Input | Returns |
|---|---|---|
| `list_products` | `search?`, `sku?` (exact), `status?` (`any` default), `per_page?` (1-50), `page?` | product summaries, newest first, plus `total` across pages |
| `get_product` | `id` | prices, stock, categories, descriptions (HTML stripped, 1,000 characters at most) |
| `create_product` | `name`, `regular_price`, `description?`, `short_description?`, `sku?`, `status?` (`publish` default), `manage_stock?`, `stock_quantity?`, `virtual?` | the new product's id, price, status and permalink |
| `list_orders` | `date?` (`today`, `yesterday` or `YYYY-MM-DD`, a day in the store's time zone), or `after?`/`before?` (ISO 8601), `status?`, `per_page?`, `page?` | orders newest first, with the time window that was searched |
| `get_order` | `id` | status, dates, line items, totals, payment method, customer note, billing name, email, phone and city (never street addresses) |
| `update_order_status` | `id`, `status` (not `refunded`: that would record a real refund), `note?` (private) | previous and new status |

Every result is returned twice, as compact JSON text and as `structuredContent` that matches the tool's
`outputSchema`. The four read tools are annotated read-only; `create_product` is not idempotent and
`update_order_status` is destructive, so the gateway's chat asks before running the latter.

Text that shoppers type (order notes, billing names) is cleaned of invisible characters and capped (500 and 100
characters), and the tool descriptions tell the model it is data, never instructions.

## How it talks to the store

WooCommerce REST API v3 (`/wp-json/wc/v3`), from `WOO_BASE_URL` (the in-cluster `wordpress` Service, plain
HTTP), as the dedicated user `mcp-bot`, whose role has only the 12 capabilities these tools need.

- **OAuth 1.0a, one-legged, HMAC-SHA256** (`src/woo/oauth1.ts`). Over plain HTTP WooCommerce accepts API keys
  only as a signature (Basic auth needs `is_ssl()`), so the consumer secret never crosses the wire.
- The signature base is built from the store's **home URL** (`WOO_HOME_URL` = `WP_HOME`) with scheme `http`,
  exactly as WooCommerce rebuilds it, not from the address we connect to. The test vectors in
  `src/woo/oauth1.vectors.json` were produced by WooCommerce's own PHP.
- **No retries** (`src/woo/client.ts`): `create_product` and `update_order_status` are not idempotent. Every
  failure (timeout, HTTP error, unreachable store) comes back as an `isError` result with a readable reason;
  after a timeout on a write it says the change may have happened and should be checked first.
- "Today" is computed in `STORE_TZ` and sent to WooCommerce as a UTC range with `dates_are_gmt=true`.

The design reasons (why REST and not WP-CLI or SQL, why OAuth 1.0a) are in
[docs/DESIGN.md](../../docs/DESIGN.md#architecture-choices).

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `MCP_AUTH_TOKEN` | (required) | Bearer token the gateway must send. From Secret `woo-mcp-auth/token` |
| `WOO_BASE_URL` | (required) | Where requests go, e.g. `http://wordpress.store.svc.cluster.local:8080` |
| `WOO_HOME_URL` | (required) | The store's public home URL; used only to compute the signature |
| `WOO_CONSUMER_KEY`, `WOO_CONSUMER_SECRET` | (required) | The `mcp-bot` API key pair, from Secret `woo-store-api` |
| `STORE_TZ` | `Asia/Kolkata` | Store time zone for `date` |
| `WOO_TIMEOUT_MS` | `8000` | Per request to WooCommerce, below the gateway's 10 s call timeout |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

Invalid configuration stops the process with one line that says which variable is wrong; the token and the
key pair are never printed.

## Develop

```bash
pnpm --filter @urumi/woo-mcp test        # signer vectors, time windows (DST included), tools, MCP over HTTP in both eras, 401s
pnpm --filter @urumi/woo-mcp typecheck
pnpm --filter @urumi/woo-mcp build       # dist/server.mjs (single esbuild bundle)
```

Deployment: part of the `woo-store` chart (`wooMcp.*` values, `charts/woo-store/README.md`).
