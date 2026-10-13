# Dashboard

React SPA for admins and members of the Urumi MCP gateway: servers, members and invites, API keys,
audit log, chat with the store agent, and member tool policies. It talks only to the gateway REST API
described in [`docs/API.md`](../../docs/API.md), on the same origin.

## Run it

```sh
pnpm --filter @urumi/dashboard dev        # http://localhost:5173, proxies /api and /mcp to the gateway
pnpm --filter @urumi/dashboard typecheck
pnpm --filter @urumi/dashboard test       # vitest, Node environment
pnpm --filter @urumi/dashboard build      # static files in dist/
```

The dev proxy target defaults to `http://app.127-0-0-1.sslip.io` (the local k3d gateway); set
`VITE_PROXY_TARGET` to point elsewhere. The browser only ever sees `localhost:5173`, so the session
cookie works exactly as in production.

Image: `docker build -f docker/dashboard.Dockerfile -t urumi/dashboard:<tag> --network=host .` from the
repo root. nginx-unprivileged, uid 101, port 8080, `GET /healthz`. With `readOnlyRootFilesystem: true`,
mount an `emptyDir` at `/tmp` (required) and, to be safe, at `/var/cache/nginx`.

## Layout

| Path | What it does |
|---|---|
| `src/api/client.ts` | The only `fetch` wrapper: same-origin cookie, `X-Urumi-CSRF: 1` on every non-GET, errors as `ApiError {status, code, message}`, 401 reported to the app |
| `src/api/endpoints.ts`, `types.ts` | One typed function per endpoint in `docs/API.md` |
| `src/api/queries.ts` | TanStack Query keys, retry policy, shared hooks (servers poll every 3 s) |
| `src/auth/session.tsx` | Who is signed in (`GET /api/auth/me` cached under `['me']`), route guards, 401 = signed out |
| `src/chat/sse.ts` | Incremental `text/event-stream` parser (EventSource can't POST) |
| `src/chat/stream.ts` | `POST /api/chat`, reads the body stream, emits typed events |
| `src/chat/transcript.ts` | Transcript data, applying events, building the text-only history |
| `src/pages/*` | One folder or file per page |
| `nginx.conf` | Full nginx config: SPA fallback, cache headers, CSP and other security headers |

## Decisions worth knowing

- **Same origin, cookie session, CSRF header.** No tokens in JavaScript. A custom header can't be sent
  cross-site without a CORS preflight the gateway never allows, so the header proves the request came
  from our own pages.
- **401 means signed out.** Any 401 sets the cached user to `null`; the route guard then shows the
  login page and returns the user to where they were after signing in. Login and the session probe opt
  out (`redirectOn401: false`) because there a 401 is an expected answer.
- **Credentials are write-only.** The server form never shows a stored credential; editing leaves it
  untouched unless a new one is typed (placeholder "unchanged").
- **Full keys are shown once**, together with a ready Claude Code command and Cursor `mcp.json`.
- **Plain-http local cluster.** `crypto.randomUUID` and `navigator.clipboard` exist only in secure
  contexts, so chat ids are a counter and copying falls back to `execCommand('copy')`.
- **Invite tokens stay private.** `Referrer-Policy: no-referrer` and nginx logs the path
  `/invite/[redacted]`.
- **Strict CSP** (`default-src 'self'`, no inline scripts or styles, `frame-ancestors 'none'`). Fonts are
  system fonts, so nothing is loaded from third parties.
- **Accessibility.** Native `<dialog>` for modals (focus trap, Escape, focus return), labelled icon
  buttons, `role="switch"` toggles, visible keyboard focus, status always shown as text and not only as
  colour, reduced motion respected.
