# Gateway HTTP API

Served by the gateway on the dashboard's origin (`app.<baseDomain>`): `/api/*` for the dashboard, `/mcp` for MCP clients.
JSON in/out. Errors: HTTP status + `{ "error": { "code": "snake_case", "message": "human readable" } }`.

## Authentication
- **Dashboard (humans):** session cookie `urumi_session` (HttpOnly, SameSite=Lax, Secure per `COOKIE_SECURE`), 12 h sliding expiry.
  Every non-GET `/api` request must send header `X-Urumi-CSRF: 1` (a custom header cannot be sent cross-site without a CORS preflight, which
  the gateway never allows) — otherwise 403 `csrf_required`.
- **MCP clients:** `Authorization: Bearer mgw_<keyId>_<secret>` on `/mcp` only. `/api` never accepts API keys; `/mcp` never accepts cookies.
- Roles: `admin` (manage servers, members, keys, policies; sees all audit) and `member` (uses tools, manages own keys, sees own audit).

## Auth & invites
| Method & path | Who | Body → Response |
|---|---|---|
| `POST /api/auth/login` | anyone | `{email, password}` → `{user}` + cookie; 401 `invalid_credentials` |
| `POST /api/auth/logout` | user | → 204 |
| `GET /api/auth/me` | user | → `{user}` or 401 |
| `GET /api/invites/:token` | anyone | → `{email, role, expiresAt}`; 404 if unknown/used/expired |
| `POST /api/invites/:token/accept` | anyone | `{name, password}` (password ≥ 10 chars) → `{user}` + cookie |
| `POST /api/invites` | admin | `{email, role}` → `{id, email, role, inviteUrl, expiresAt}` (link shown to the admin to share; valid 72 h, single use) |
| `GET /api/invites` | admin | → pending invites `[{id, email, role, createdAt, expiresAt}]` |
| `DELETE /api/invites/:id` | admin | → 204 |

`user` = `{id, email, name, role, status: 'active'|'disabled', createdAt, lastSeenAt}`.

## Users
| `GET /api/users` | admin | → `[user]` |
|---|---|---|
| `PATCH /api/users/:id` | admin | `{role?, status?}` → `{user}`; 409 `last_admin` if it would leave no active admin. Disabling a user also revokes their keys and sessions. |

## API keys
| Method & path | Who | Body → Response |
|---|---|---|
| `GET /api/keys` | user | own keys; admin may pass `?userId=<id>` or `?userId=all` → `[{id, name, prefix, userId, userEmail, createdAt, lastUsedAt, revokedAt}]` (`prefix` = `mgw_<keyId>_…`) |
| `POST /api/keys` | user | `{name, userId?}` (`userId` admin-only, to issue for a member) → `{key: "mgw_…"(full, shown once), …keyFields}` |
| `DELETE /api/keys/:id` | owner or admin | revoke → 204 (immediate: the next MCP request with it gets 401) |

## Upstream servers
`server` = `{id, slug, name, url, authType: 'none'|'bearer'|'header', headerName, hasCredential, enabled, managed, timeoutMs, toolAllowlist: string[]|null,
 status: 'connected'|'unreachable'|'disabled'|'connecting', statusReason, protocolEra: 'modern'|'legacy'|null, lastCheckedAt, lastOkAt,
 tools: [{name, exposedName, description, hash, exposed: boolean, allowedForMe: boolean}], createdAt, updatedAt}`.
Credentials are **write-only**: never returned, only `hasCredential`.

| Method & path | Who | Body → Response |
|---|---|---|
| `GET /api/servers` | user | → `[server]` (members see the same list; `allowedForMe` reflects policies) |
| `POST /api/servers` | admin | `{slug, name, url, authType, headerName?, credential?, timeoutMs?, toolAllowlist?}` → `server`; 422 `url_not_allowed` (SSRF guard) / `invalid_slug` / `slug_taken` |
| `PATCH /api/servers/:id` | admin | any of `{name, url, authType, headerName, credential, timeoutMs, toolAllowlist, enabled}` (`credential: ""` clears, omitted keeps; slug is immutable) → `server` |
| `DELETE /api/servers/:id` | admin | soft delete → 204 (its tools disappear; audit history keeps the slug snapshot) |
| `POST /api/servers/:id/refresh` | admin | reconnect + re-list tools now → `server` |

Changes to servers (enable/disable/delete/edit) or their tool lists trigger `notifications/tools/list_changed` to MCP clients holding a listen stream.

## Tool policies (stand-out: tool permissions)
`policy` = `{id, role: 'member', server: '<slug>'|'*', tool: '<originalToolName>'|'*', effect: 'deny'}`. Admins are never restricted.
Default seed: members denied `woo/create_product` and `woo/update_order_status` (read-only store access for members).
| `GET /api/policies` | user | → `[policy]` |
|---|---|---|
| `PUT /api/policies` | admin | `[{role, server, tool, effect}]` (replace all) → `[policy]` |

Denied tools are **hidden from `tools/list`** for that user and **rejected** on `tools/call` (audit status `denied`).

## Audit log
`entry` = `{id, ts, userId, userEmail, via: 'mcp'|'chat', apiKeyPrefix, serverSlug, tool, exposedName, status: 'ok'|'error'|'timeout'|'unreachable'|'denied'|'auth_rejected', durationMs, error}`.
| `GET /api/audit` | user | query `userId?, serverSlug?, status?, via?, limit (≤200, default 50), before (id cursor)` → `{items:[entry], nextBefore}`; members only ever get their own rows |
|---|---|---|

Argument values are never stored (only a SHA-256 `argsHash`, not returned by the API).

## Misc
| `GET /api/config` | user | → `{mcpUrl, storeUrl, model, storeTz}` |
|---|---|---|
| `GET /healthz` | — | liveness (process up) |
| `GET /readyz` | — | readiness (Postgres reachable; never depends on upstream health) |

## Chat (Server-Sent Events)
`POST /api/chat` (user, CSRF header) with `{messages: [{role: 'user'|'assistant', content: string}]}` — the client keeps the visible transcript
(text only) and sends it each turn; the last message must be `user`. Response `Content-Type: text/event-stream`, events:

| event | data |
|---|---|
| `tools` | `{count, names: string[]}` — tool snapshot for this turn (after policy filtering) |
| `text` | `{text}` — assistant text block (may arrive several times) |
| `tool_call` | `{id, name, args}` — `name` is the exposed name |
| `tool_result` | `{id, name, ok, durationMs, preview}` — preview ≤ 2000 chars; `ok:false` includes the error text |
| `done` | `{stopReason, iterations, usage: {inputTokens, outputTokens}}` |
| `error` | `{message}` (then the stream ends) |

The chat agent runs inside the gateway pod, is an MCP client of the gateway's **internal** loopback listener, and authenticates with a
5-minute HS256 JWT `{sub: userId, act: 'chat-agent', aud: 'urumi-gateway-internal'}` — so its calls pass the same policy and audit path
as external clients and are recorded with `via: 'chat'` under the logged-in user. Max 8 tool iterations per turn.

## MCP endpoint
`POST /mcp` — Streamable HTTP, dual-era (2026-07-28 stateless + 2025-11-25 legacy fallback). Missing/invalid/revoked key → HTTP 401 with
`WWW-Authenticate: Bearer error="invalid_token"` (no `resource_metadata`, so clients don't start OAuth discovery) and an `auth_rejected` audit row
(attributed to the key's owner when the key id is known). `tools/list` returns the caller's allowed tools from enabled servers (cached
catalogs; unreachable servers' tools stay listed and fail fast); `tools/call` routes through the single `callTool()` choke point.
