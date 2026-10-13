# gateway

The team MCP gateway. It is an **MCP client** of every registered upstream server (woo, supplier, Firecrawl,
AgentMail, and anything an admin adds) and one **MCP server** for Claude Code, Cursor, Inspector and the built-in
chat agent. It also serves the dashboard's REST API. Contracts: `docs/API.md` (HTTP API) and `docs/CONTRACTS.md`
(env vars, Secrets, seed file, tool exposure rules).

## How one tool call travels

```
POST /mcp  (Authorization: Bearer mgw_<keyId>_<secret>)
  -> auth/mcpAuth.ts       look the key up by keyId, HMAC compare, refuse revoked keys / disabled users (no cache)
  -> mcp/mcpEndpoint.ts    SDK createMcpHandler (2026-07-28 + legacy 2025-11-25), low-level Server, 2 handlers
  -> mcp/toolRouter.ts     THE choke point: lookup -> enabled? -> policy -> rate limit -> audit 'pending' -> call -> cap -> audit done
  -> upstreams/manager.ts  per-server client (lazy, rebuilt after errors), timeout + caller's abort signal
  -> upstreams/upstreamClient.ts -> security/ssrf.ts fetch (connect-time IP check, no redirects) -> upstream
```

The chat agent takes the same path through a second listener on `127.0.0.1:8081`, authenticated with a 5-minute
JWT for the logged-in user (`auth/chatToken.ts`), so its calls get the same policies and audit rows (`via: chat`).

## Module map

| Path | What it does |
|---|---|
| `server.ts` | Entry: config, startup tasks, the three listeners, SIGTERM drain |
| `gateway.ts` | Wires everything together (no sockets; tests build it directly) |
| `config.ts` | Env vars, validated with zod; errors name the variable, never the value |
| `db/` | Drizzle schema, pool, migrations under a Postgres advisory lock |
| `seed/startup.ts` | Bootstrap admin, seed servers (CONTRACTS semantics), default policies once |
| `crypto/` | scrypt passwords, API keys, AES-256-GCM credentials, HMAC helpers |
| `auth/` | Sessions (cookie, sliding 12 h), CSRF header, login throttle, MCP key / chat-token auth |
| `security/ssrf.ts` | URL rules for upstreams + the guarded fetch |
| `upstreams/` | Client per server, health loop, status and reasons, error classification |
| `catalog/` | Exposed names (`<slug>__<tool>`), description cleaning, definition hashes, routing table |
| `policies/policy.ts`, `policies/rateLimit.ts` | Member deny rules (admins unrestricted); per-user tool-call limits |
| `mcp/` | MCP handlers and the tool router; closing open streams on revocation |
| `audit/auditLog.ts` | Audit rows, cursor pagination |
| `api/` | REST routes for the dashboard |
| `metrics.ts`, `http.ts` | Prometheus metrics; listeners |
| `stats/` | In-memory per-server call stats (15-minute window, histogram p50/p95, top tools, last error) and status history, for `GET /api/stats` |
| `chat/` | The chat agent (separate module, mounted at `/api/chat`); `chat/confirm.ts` decides which tools wait for the user's approval |

## Develop and test

```bash
pnpm --filter @urumi/gateway typecheck
pnpm --filter @urumi/gateway test            # unit tests; integration tests skip without a database

# integration tests need Postgres: start a throwaway one inside WSL (Docker lives there)...
bash apps/gateway/scripts/test-db.sh start   # prints TEST_DATABASE_URL=postgres://...@127.0.0.1:55432/postgres
# ...then on Windows:
TEST_DATABASE_URL=postgres://postgres:gateway-test-only@127.0.0.1:55432/postgres pnpm --filter @urumi/gateway test
bash apps/gateway/scripts/test-db.sh stop
```

The integration test (`src/gateway.integration.test.ts`) runs the real gateway against three in-process upstream
MCP servers (bearer, custom-header and no-auth) and checks aggregation, routing, policies, `list_changed` on disable,
dead-upstream fail-fast, 401 + audit for bad and revoked keys, the chat listener, and restart/seeding semantics.

Schema changes: edit `src/db/schema.ts`, then `pnpm --filter @urumi/gateway db:generate` and commit the new SQL in
`drizzle/`. The build (`pnpm --filter @urumi/gateway build`) bundles `dist/server.mjs` and copies `drizzle/` next
to it, because the image contains only `dist/`.
