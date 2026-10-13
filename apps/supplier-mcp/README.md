# supplier-mcp

A small, read-only MCP server for a **wholesale supplier catalog**. It is the second in-cluster upstream
behind the gateway, used for three things:

- the cross-server demo ("find supplier products we don't sell yet and add one to the store");
- the tool-name collision demo (`list_products` exists here **and** on woo-mcp);
- the pod-kill demo.

It runs on the shared HTTP shell in `packages/mcp-common`, which provides the bearer check, `/healthz`,
`/readyz`, JSON logs, and the stateless serving of both protocol eras (2026-07-28 and legacy 2025-11-25).

## Tools

| Tool | Input | Returns |
|---|---|---|
| `list_products` | `search?`, `category?` | `{count, products[]}`: supplier items with `unit_cost_inr` (the wholesale cost, not retail), `moq`, `stock`, `lead_time_days` |
| `get_product` | `sku` | one item, or a tool error for an unknown SKU |
| `check_stock` | `sku`, `quantity?` (defaults to the MOQ) | `available`, `reason`, `stock`, `moq`, `lead_time_days`, `unit_cost_inr` |
| `slow_lookup` | `seconds` (1-120) | **demo only** (`DEMO_SLOW_TOOL=true`): sleeps, to show the gateway's timeout |

Every result is returned twice, as compact JSON text and as `structuredContent` that matches the declared
`outputSchema`. All tools are annotated read-only and idempotent.

The built-in catalog (`src/catalog.ts`) has the supplier versions of the four store products: same names,
`SUP-` SKUs instead of `URU-`, and wholesale costs below the store price. It also has six items the store does not sell yet.

## Configuration

| Env | Default | Meaning |
|---|---|---|
| `MCP_AUTH_TOKEN` | (required, 16+ chars) | Bearer token the gateway must send. Comes from Secret `supplier-mcp-auth/token` |
| `CATALOG_PATH` | built-in catalog | A JSON array of items (for example mounted from a ConfigMap). It is validated at startup |
| `PORT` | `8080` | Listen port |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `DEMO_SLOW_TOOL` | `false` | Adds `slow_lookup` |
| `DEMO_POISONED_DESCRIPTION` | `false` | Adds a labelled prompt-injection instruction to `check_stock`'s description, for the threat-model demo |

Invalid configuration stops the process with a clear log line. Examples: a missing token, a bad catalog file, or `DEMO_SLOW_TOOL=yes`.

## Develop

```bash
pnpm --filter @urumi/supplier-mcp test       # unit tests + MCP-over-HTTP tests (legacy and auto eras, 401s)
pnpm --filter @urumi/supplier-mcp typecheck
pnpm --filter @urumi/supplier-mcp build      # dist/server.mjs (single esbuild bundle)
```

Deployment: see `charts/mcp-server/README.md`.
