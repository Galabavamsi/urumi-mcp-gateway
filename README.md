# Urumi MCP gateway: WooCommerce on Kubernetes with a team MCP gateway

A WooCommerce store, an MCP server for it that we wrote ourselves, and a team **MCP gateway** with a React
dashboard and a chat agent, all running on Kubernetes. An admin registers MCP servers once in the dashboard.
Every team member then reaches all of them through **one MCP endpoint** with their own API key, from Claude
Code, Cursor or MCP Inspector, or through the chat agent in the dashboard. Members never see the upstream
servers' credentials, and every tool call is written to an audit log under the user who made it. The same
Helm charts run on a local k3d cluster and on a k3s VPS; only the values files differ.

**Live deployment** (AWS EC2 t3.large in ap-south-1, k3s v1.36.5, Let's Encrypt TLS):
store <https://store.urumi.humanslop.in> · dashboard <https://app.urumi.humanslop.in> ·
MCP endpoint `https://app.urumi.humanslop.in/mcp` (needs an API key from the dashboard).
The instance may be stopped between demos to save credits.

```mermaid
flowchart LR
  subgraph outside["Outside the cluster"]
    browser["Browser: storefront, wp-admin, dashboard"]
    clients["MCP clients: Claude Code, Cursor, Inspector"]
  end
  subgraph k8s["Kubernetes: k3d locally, k3s on the VPS"]
    traefik["Traefik Ingress"]
    subgraph nsstore["namespace store"]
      wp["WordPress + WooCommerce"]
      maria[("MariaDB")]
      cron["wp-cron CronJob"]
      woomcp["woo-mcp (ours)"]
    end
    subgraph nsplatform["namespace platform"]
      dash["dashboard (nginx + React)"]
      gw["gateway: REST API, /mcp, chat agent"]
      pg[("Postgres")]
    end
    subgraph nsup["namespace mcp-upstreams"]
      sup["supplier-mcp (ours)"]
    end
  end
  fc["Firecrawl MCP (hosted)"]
  am["AgentMail MCP (hosted)"]
  llm["Anthropic API (chat model)"]

  browser -->|"store.*"| traefik
  browser -->|"app.*"| traefik
  clients -->|"app.*/mcp with an API key"| traefik
  traefik --> wp
  traefik -->|"/"| dash
  traefik -->|"/api and /mcp"| gw
  wp --> maria
  cron --> maria
  gw --> pg
  gw -->|"bearer token"| woomcp
  woomcp -->|"REST v3, OAuth 1.0a"| wp
  gw -->|"bearer token"| sup
  gw -->|"HTTPS, Bearer key"| fc
  gw -->|"HTTPS, x-api-key"| am
  gw -->|"HTTPS"| llm
```

Only Traefik is reachable from outside. woo-mcp, supplier-mcp, MariaDB and Postgres have ClusterIP Services
and default-deny NetworkPolicies; the MCP servers accept connections only from pods that carry the gateway's
label in the `platform` namespace, and they also require a bearer token. Nothing but the gateway talks to an
upstream MCP server, including the chat agent, which calls the gateway's own MCP endpoint.

More detail:

| Document | What it covers |
|---|---|
| [docs/DESIGN.md](docs/DESIGN.md) | System design and tradeoffs: architecture choices, tool aggregation, routing, failure handling, local vs production, scaling limits |
| [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) | Assets, trust boundaries, the four questions from the brief, residual risks |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Upgrade and rollback, backups, observability, troubleshooting, rotating secrets |
| [docs/VPS.md](docs/VPS.md) | Production setup on AWS EC2 with k3s, cert-manager and GHCR images |
| [docs/API.md](docs/API.md) | The gateway's HTTP API (dashboard REST, chat SSE, MCP endpoint) |
| [docs/CONTRACTS.md](docs/CONTRACTS.md) | Names, ports, labels, env vars and Secrets shared between components and charts |

## Contents

- [Repository layout](#repository-layout)
- [Prerequisites](#prerequisites)
- [Local setup](#local-setup)
- [Place an order and see it in wp-admin](#place-an-order-and-see-it-in-wp-admin)
- [Invite a member and create an API key](#invite-a-member-and-create-an-api-key)
- [Connect an external MCP client](#connect-an-external-mcp-client)
- [Use the chat agent](#use-the-chat-agent)
- [Disable a server, revoke a key, kill a pod, read the audit log](#disable-a-server-revoke-a-key-kill-a-pod-read-the-audit-log)
- [Tool names](#tool-names)
- [Running the tests](#running-the-tests)
- [Production (VPS) setup](#production-vps-setup)
- [Stand-out items attempted](#stand-out-items-attempted)
- [Known limitations](#known-limitations)

## Repository layout

```text
apps/
  gateway/          Hono backend: dashboard REST API (/api), the aggregated MCP endpoint (/mcp), chat agent,
                    upstream health loop, tool policies, rate limits, audit log, Prometheus metrics (:9091)
  dashboard/        React 19 SPA (Vite, TanStack Query, Tailwind), served by nginx-unprivileged
  woo-mcp/          our WooCommerce MCP server: 6 tools over the WooCommerce REST API v3, signed with OAuth 1.0a
  supplier-mcp/     a second in-cluster MCP server (a supplier catalog), used for the name-collision and pod-kill demos
packages/
  mcp-common/       shared HTTP shell for our MCP servers: both protocol eras, bearer check, probes, drain, JSON logs
images/wordpress/   our WordPress image: WordPress 7.1.3, WooCommerce 11.2.1, Storefront 4.6.2, WP-CLI, bootstrap script
charts/
  woo-store/        WordPress, MariaDB, wp-cron, woo-mcp, Ingress, NetworkPolicies (one store per namespace)
  platform/         gateway, dashboard, Postgres, Ingress, NetworkPolicies
  mcp-server/       a generic chart for one in-cluster MCP server (instances/supplier.yaml deploys supplier-mcp)
cluster/            k3d cluster config, namespaces with Pod Security labels; production: Traefik HTTP-to-HTTPS
                    redirect, cert-manager values and the Let's Encrypt ClusterIssuers (cert-manager/)
docker/             Dockerfiles for the Node services and the dashboard
scripts/            setup-wsl-docker.sh, dev-up.sh, secrets.sh, e2e-store.mjs, e2e-dod.mjs, build-app.mjs
  backup/           back up now, verify, fetch and restore the two databases (README.md inside)
  demo/             upgrade-rollback.sh: the live Helm 4 upgrade and rollback demo
  vps/              production: provision the EC2 machine, install k3s, kubeconfig + SSH tunnel, add-ons, deploy
.github/            CI: tests, chart validation, and the five images pushed to GHCR (workflows/ci.yml)
docs/               the documents above; PLAN.md is the original build plan, kept for history (the code and
                    these documents are authoritative where they differ)
```

Every chart and app has its own README with the details: [charts/platform](charts/platform/README.md),
[charts/woo-store](charts/woo-store/README.md), [charts/mcp-server](charts/mcp-server/README.md),
[apps/gateway](apps/gateway/README.md), [apps/dashboard](apps/dashboard/README.md),
[apps/woo-mcp](apps/woo-mcp/README.md) (its tools and how it talks to the store),
[apps/supplier-mcp](apps/supplier-mcp/README.md).

## Prerequisites

| Tool | Version used | Where it runs |
|---|---|---|
| Docker Engine | 29.x | Linux (on Windows: inside WSL Ubuntu) |
| k3d | 5.9.0 (creates k3s `v1.36.5-k3s1`) | same as Docker |
| kubectl | 1.36.5 | same as Docker |
| Helm | 4.3.0 | same as Docker |
| git, curl, openssl | any recent | same as Docker (`scripts/secrets.sh` uses openssl) |
| Node.js | 24 | where you run tests and the end-to-end scripts |
| pnpm | 9.15.0 (`npm install -g pnpm@9.15.0`) | same as Node |
| Claude Code CLI | optional | only for check d9 of `scripts/e2e-dod.mjs` and the client example below |

**Windows (how this project is developed).** Docker, k3d, kubectl and Helm run inside WSL Ubuntu with Docker
Engine, not Docker Desktop. Node, pnpm and the end-to-end scripts run on Windows; the scripts call kubectl
through `wsl.exe -d Ubuntu --exec ...` by themselves. If your distro is not named `Ubuntu` (for example
`Ubuntu-24.04`), set `$env:WSL_DISTRO='<name>'` before running the end-to-end scripts.

1. If Docker Desktop is installed, first turn off its WSL integration for this distro (Docker Desktop >
   Settings > Resources > WSL integration) and quit it: the setup script refuses to run otherwise, because two
   Docker engines would fight over the same `docker` CLI and socket. Docker Desktop is avoided only because it
   does not start on the author's laptop (Windows error 1920, see [docs/PLAN.md](docs/PLAN.md)); running this
   project on Docker Desktop's engine is untested. Then install WSL with Ubuntu, open an Ubuntu terminal and run
   `bash /mnt/<drive>/<path-to-repo>/scripts/setup-wsl-docker.sh`.
   It installs Docker Engine from Docker's apt repository and the pinned kubectl, Helm (both checksum-verified)
   and k3d versions. Then run `wsl --shutdown` once from Windows so the `docker` group membership applies.
2. Keep WSL running while you work. By default WSL stops the distro shortly after the last `wsl.exe` exits,
   which stops the cluster. Put this in `%UserProfile%\.wslconfig` and run `wsl --shutdown` once:

   ```ini
   [wsl2]
   vmIdleTimeout=-1
   [general]
   instanceIdleTimeout=-1
   ```

3. The repo can live on a Windows drive (for example `D:\job\urumi-assignment`, which WSL sees as
   `/mnt/d/job/urumi-assignment`). `.gitattributes` keeps shell scripts on LF line endings.

**Linux.** Install Docker Engine, k3d 5.9, kubectl 1.36 and Helm 4.3 (on Ubuntu, `scripts/setup-wsl-docker.sh`
does exactly that; then log out and back in so the `docker` group membership applies). Everything else is the
same; the end-to-end scripts call `kubectl` directly when they are not on Windows.

**macOS.** Not tested. It should work with Docker Desktop or Colima, but `scripts/dev-up.sh` uses GNU tools
(`sha1sum`, `xargs -r`) when the working tree has uncommitted changes, so install GNU coreutils/findutils or
commit first.

## Local setup

### 1. Fill in `.env`

```bash
cp .env.example .env      # .env is gitignored; scripts/secrets.sh turns it into Kubernetes Secrets
```

`.env` holds only the secrets that come from outside. All internal secrets (database passwords, WordPress salts,
the WooCommerce API key pair, the internal MCP tokens, the gateway's pepper and encryption keys) are generated
randomly by `scripts/secrets.sh` the first time, straight into Kubernetes Secrets; they are never written to a
file or printed.

| Variable | What it is for | If you leave it empty |
|---|---|---|
| `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD` | The first dashboard admin. Created only while the gateway's users table is empty. Use a password of at least 10 characters. | The gateway starts, logs a warning, and nobody can log in to the dashboard. Changing these later does **not** change an existing admin (see [OPERATIONS.md](docs/OPERATIONS.md#rotating-secrets)). |
| `ANTHROPIC_API_KEY` | The chat agent's model (Claude Haiku 5.5 by default). | The gateway starts; every chat turn ends with an error message. The MCP endpoint is not affected. |
| `FIRECRAWL_API_KEY` | Credential of the seeded `firecrawl` upstream (web search and scraping). | That seed is skipped (one log line) and the server is not registered. |
| `AGENTMAIL_API_KEY` | Credential of the seeded `mail` upstream (sends email from one AgentMail inbox). | Same: the `mail` server is not registered. |

The brief asks for at least three upstream servers. With both hosted keys empty you get only `woo` and
`supplier`; add a third in the dashboard (any Streamable HTTP server reachable over public HTTPS) or set one
of the keys. In `scripts/e2e-dod.mjs`, check d3 reports a hosted seed that is not registered as a note and
fails only when fewer than three servers are registered; every other check runs without the hosted keys. The
chat checks (d6, d7, d7b and the chat part of d11) need `ANTHROPIC_API_KEY`.

A `.env` saved with Windows line endings is fine: `secrets.sh` strips the `\r` before creating Secrets.

### 2. Bring everything up

Inside WSL (or a Linux shell), from the repo root:

```bash
bash scripts/dev-up.sh
# from Windows PowerShell instead:  wsl.exe -d Ubuntu -- bash /mnt/<drive>/<path-to-repo>/scripts/dev-up.sh
```

The script is safe to re-run; every step checks before it acts:

1. creates the k3d cluster `urumi` from `cluster/k3d-local.yaml` (or starts it if it is stopped);
2. applies the namespaces (`cluster/namespaces.yaml`) and runs `scripts/secrets.sh`;
3. builds the five images (`urumi/{wordpress,woo-mcp,supplier-mcp,gateway,dashboard}`), tagged with the git
   commit (plus `-dirty-<hash>` for uncommitted changes), with `docker build --network=host`, and imports them
   into the cluster;
4. installs or upgrades three Helm releases with `--wait --wait-for-jobs --timeout 10m --rollback-on-failure`:
   `woo-store` (namespace `store`), `supplier-mcp` (`mcp-upstreams`) and `platform` (`platform`);
5. checks through Traefik that the shop answers 200, the dashboard 200 and `/api/auth/me` 401.

The first run takes a while (the WordPress image is the big one). Then install the Node dependencies on the
machine where you will run the tests and end-to-end scripts (on Windows: in PowerShell, not WSL):

```bash
pnpm install
```

### 3. Open it

| What | URL |
|---|---|
| Storefront | <http://store.127-0-0-1.sslip.io/> (shop: `/shop/`) |
| WooCommerce admin | <http://store.127-0-0-1.sslip.io/wp-admin/> (user `admin`) |
| Dashboard | <http://app.127-0-0-1.sslip.io/> |
| MCP endpoint for clients | `http://app.127-0-0-1.sslip.io/mcp` |

**Why sslip.io.** `sslip.io` is a public wildcard DNS service: a name that contains an IP address resolves to
that address, so `*.127-0-0-1.sslip.io` resolves to `127.0.0.1`, where k3d publishes Traefik's port 80. The
URLs are stable (the hosts are fixed in the `values-local.yaml` files), need no hosts-file edits or admin
rights, and resolve in browsers, curl and Node, which matters for MCP clients: MCP Inspector and our end-to-end
scripts run on Node, and Claude Code was tested against these names. `*.localhost` names were rejected because
Node on Windows does not resolve them. sslip.io needs
working internet DNS; offline, add `127.0.0.1 store.127-0-0-1.sslip.io app.127-0-0-1.sslip.io` to your hosts
file and nothing else changes.

**First login.** Log in to the dashboard with `BOOTSTRAP_ADMIN_EMAIL` and `BOOTSTRAP_ADMIN_PASSWORD` from
`.env`. The Servers page lists `woo` first, then `supplier`, `firecrawl` and `mail`, each with its status
(Connected, Unreachable with a reason, Disabled) and its tools.

## Place an order and see it in wp-admin

1. Open <http://store.127-0-0-1.sslip.io/shop/>, open a product and click **Add to cart**.
2. Open the cart and go to checkout. Fill in the billing details (guest checkout is on; shipping is disabled,
   so no shipping address is asked for), choose **Cash on delivery** and place the order.
3. Read the WordPress admin password. Inside WSL:

   ```bash
   kubectl -n store get secret woo-store-wp -o go-template='{{index .data "admin-password" | base64decode}}' | clip.exe
   ```

   `clip.exe` copies it to the Windows clipboard without showing it; on Linux, drop `| clip.exe` (it is then
   printed to your terminal) or pipe to your clipboard tool.
4. Log in at <http://store.127-0-0-1.sslip.io/wp-admin/> as `admin` and open **WooCommerce → Orders**. The
   order is there with status *Processing* and payment method *Cash on delivery*.

Order emails are not sent: there is no mail relay, and the store's NetworkPolicies deny all egress.

## Invite a member and create an API key

**Invite (admin).** Dashboard → **Members** → enter the email and choose the role (`member` or `admin`) →
**Create invite link**. The gateway does not send email; it shows an invite link
(`<dashboard>/invite/<token>`, single use, valid 72 hours). Open it in another browser profile or a private
window, enter a name and a password of at least 10 characters, and the new user is logged in.

**API key (any user).** Dashboard → **My API keys** → enter a name (for example "Laptop, Claude Code") →
**Create key**. The full key (`mgw_<id>_<secret>`) is shown **once**, together with a ready-to-paste Claude
Code command and a Cursor `mcp.json` snippet. The gateway stores only an HMAC of it. Revoking a key on the same
page takes effect on the very next request. Admins can also issue and revoke keys for a member from
**Members**.

## Connect an external MCP client

Every client needs only two things: the gateway URL (`http://app.127-0-0-1.sslip.io/mcp` locally) and an API
key, sent as `Authorization: Bearer <key>`. The client sees the tools of every enabled server that the user's
role allows. Claude Code is exercised by the end-to-end check d9; the Cursor and Inspector setups below follow
those tools' documented configuration and are not part of the automated checks.

### Claude Code

```bash
claude mcp add --transport http urumi http://app.127-0-0-1.sslip.io/mcp --header "Authorization: Bearer mgw_..."
```

In Claude Code, `/mcp` shows the `urumi` server as connected; the tools appear as
`mcp__urumi__<server>__<tool>`, for example `mcp__urumi__woo__list_orders`. Try *"What orders came in
today?"* and a two-server prompt such as *"Look at the supplier catalog and tell me which products we don't
sell in our store yet."* (`supplier__list_products`, then `woo__list_products`). Claude Code negotiates the
2026-07-28 protocol and keeps a `subscriptions/listen` stream open, so when an admin disables a server the
gateway pushes `tools/list_changed` to it at once (and refuses calls to that server's tools either way).

### Cursor

Add this to `.cursor/mcp.json` in a project, or `~/.cursor/mcp.json` for all projects:

```json
{
  "mcpServers": {
    "urumi": {
      "url": "http://app.127-0-0-1.sslip.io/mcp",
      "headers": { "Authorization": "Bearer mgw_..." }
    }
  }
}
```

Cursor speaks the older 2025-11-25 protocol, which has no push channel in the gateway's stateless mode, so
after an admin disables a server Cursor shows the change only when it reconnects or re-lists. Calls to a
disabled server's tools are refused by the gateway either way.

### MCP Inspector

Inspector needs Node 22.19 or newer.

```bash
export URUMI_KEY=mgw_...   # your key from My API keys
# CLI: list the tools, then call one
npx @modelcontextprotocol/inspector@2.10.1 --cli http://app.127-0-0-1.sslip.io/mcp \
  --transport http --header "Authorization: Bearer $URUMI_KEY" --method tools/list
npx @modelcontextprotocol/inspector@2.10.1 --cli http://app.127-0-0-1.sslip.io/mcp \
  --transport http --header "Authorization: Bearer $URUMI_KEY" \
  --method tools/call --tool-name woo__list_orders --tool-arg date=today

# UI: starts a local web page; choose the Streamable HTTP transport, enter the URL and add the
# Authorization header with your key.
npx @modelcontextprotocol/inspector@2.10.1
```

A missing, wrong or revoked key gets HTTP 401 with `WWW-Authenticate: Bearer error="invalid_token"` and no
`resource_metadata`, so clients do not try to start an OAuth login against the gateway.

## Use the chat agent

Dashboard → **Chat**. The agent (Claude Haiku 5.5 by default, `gateway.llmModel` in the platform values)
answers with the same tools the logged-in user would get in Claude Code, through the gateway's own MCP
endpoint, so its calls appear in the audit log under that user with channel `chat`.

- *"Create a product named 'Desk Lamp' priced 349"* runs `woo__create_product`; the product is on the
  storefront right away.
- *"What orders came in today?"* runs `woo__list_orders {"date":"today"}`; "today" is the store's day in
  `Asia/Kolkata`.
- Each tool call is shown as a card with its arguments, a preview of the result and its duration.

**Approval step.** Before any tool that can change or delete existing data or send data out of our systems,
the reply pauses and shows the pending calls with **Approve and run** and **Decline**. Today that is
`woo__update_order_status`, `mail__send_message` and every `firecrawl__*` tool. Read-only tools and
`woo__create_product` (it only adds a product in our own store) run without asking. The paused calls are
stored on the gateway for 5 minutes; the browser only answers yes or no for them, so neither the page nor text
the model wrote can change what runs. Sending a new message abandons an unanswered approval.

Limits: one running reply per user, at most 8 model calls per reply, at most 50 messages of 10,000 characters
in the history the browser resends. Members do not get `woo__create_product`, `woo__update_order_status` or
`mail__send_message` by default (see **Tool policies**), so try the write examples as an admin or relax the
policy first.

## Disable a server, revoke a key, kill a pod, read the audit log

The brief's "team and control" checks, by hand. `node scripts/e2e-dod.mjs` does the same automatically
(checks d10 to d14).

1. **Disable a server (admin).** Dashboard → **Servers** → switch off **Supplier catalog** (the switch is
   labelled "Disable Supplier catalog"). Its tools leave `tools/list` and every call to them is refused
   (audited as `denied`). Clients holding a `subscriptions/listen` stream (Claude Code, the MCP SDK) get
   `tools/list_changed` at once; the chat agent sees the change at the start of its next reply; Cursor when it
   re-lists. Switch it back on afterwards.
2. **Revoke a key.** **My API keys** (or, as an admin, **Members** → the user's API keys) → **Revoke**. The next
   MCP request with that key gets HTTP 401 with `WWW-Authenticate: Bearer error="invalid_token"`, and the Audit
   log shows it as **Key rejected** under that user.
3. **Kill a pod** (inside WSL):

   ```bash
   kubectl -n mcp-upstreams delete pod -l app.kubernetes.io/name=supplier-mcp
   ```

   The Deployment starts a replacement at once. Until it is Ready, the health check (every 5 s) or the next
   call finds no pod and the Servers page shows supplier as **Unreachable** ("connection refused"); the e2e
   check d13 measured about 10 s from the delete until supplier answered calls again. That window is short, so
   to hold the server down long enough to look around:

   ```bash
   kubectl -n mcp-upstreams scale deploy/supplier-mcp --replicas=0   # Unreachable within about 10 s; woo__* keeps working
   kubectl -n mcp-upstreams scale deploy/supplier-mcp --replicas=1   # Connected again within about 20 s
   ```

   While it is down its tools stay listed (the list does not flap during a restart), and a call fails at once
   with `supplier: unreachable (connection refused)`.
4. **Audit log.** Every call, including denied, rate-limited and rejected ones. Filter by **User** (admins
   only), **Server**, **Status** and **Via** (MCP clients or Chat); each row has the duration and, for a
   failure, a short reason. Members see only their own rows.
5. **Observability (admins).** One card per server: the status history with reasons (the outage from step 3 is
   there), calls, error rate and p50/p95 latency over the last 15 minutes. Details in
   [OPERATIONS.md](docs/OPERATIONS.md#observability).

## Tool names

The gateway exposes every upstream tool as `<slug>__<tool>`, where the slug is the server's short name chosen
by the admin (2 to 12 characters: a lower-case letter, then lower-case letters, digits or dashes; it cannot
contain `__` and never changes). `woo` and `supplier` both have a tool called `list_products`; clients see
`woo__list_products` and `supplier__list_products`. The tool part is reduced to `[A-Za-z0-9_-]`, and a name
longer than 48 characters is shortened to its first 41 characters plus `_` and 6 hex characters of a SHA-256,
which leaves room for client prefixes such as Claude Code's `mcp__urumi__` within the common 64-character
limit. Calls are routed through a lookup table (exposed name → server id and original name), never by
splitting the name. Each description starts with `[<slug>]`, so a model always knows where a tool comes from.
Details: [DESIGN.md](docs/DESIGN.md#tool-aggregation-and-naming).

## Running the tests

On Windows, run the `pnpm` and `node` commands in PowerShell from the repo root (after `pnpm install`), and
every `bash ...` command inside WSL (an Ubuntu terminal), where Docker, kubectl and Helm are.

| Command | What it proves |
|---|---|
| `pnpm -r typecheck` | Every package type-checks |
| `pnpm -r test` | Unit and in-process tests: the gateway (catalog, naming, SSRF guard, policies, rate limits, approvals, chat loop against a scripted model), woo-mcp (OAuth 1.0a signer against vectors from WooCommerce's own PHP, time windows, both protocol eras), supplier-mcp, mcp-common, the dashboard (SSE parser, API client, transcript). The gateway's integration test is skipped without a database. |
| `bash apps/gateway/scripts/test-db.sh start` (where Docker runs), then `TEST_DATABASE_URL=postgres://postgres:gateway-test-only@127.0.0.1:55432/postgres pnpm --filter @urumi/gateway test` (PowerShell: `$env:TEST_DATABASE_URL='postgres://postgres:gateway-test-only@127.0.0.1:55432/postgres'; pnpm --filter @urumi/gateway test`), then `bash apps/gateway/scripts/test-db.sh stop` | The gateway against a real Postgres 18.6 (throwaway, on tmpfs) and three in-process upstream MCP servers (bearer, custom header, no auth): aggregation, routing, policies, `list_changed` on disable, dead-upstream fail-fast, 401 and audit rows for bad and revoked keys, the chat listener, restart and seeding semantics |
| `node scripts/e2e-store.mjs` (`--quick` skips the pod restarts) | 20 checks on the live cluster: storefront, its store notice banner and guest COD checkout; woo-mcp's six tools over real MCP in both protocol eras; the mcp-bot key is refused customers and settings; both MCP servers return 401 without the bearer token; NetworkPolicies tested from real pods (only gateway pods in `platform` reach the MCP servers, nothing outside the store reaches WordPress or MariaDB); PHP in uploads is refused; pod kill and scale to 0; data survives `helm upgrade` and restarts. It deletes its own test data. |
| `node scripts/e2e-dod.mjs` (`--keep-users`, `--no-claude-code`) | The brief's Definition of Done, 16 checks with two users created through the real invite flow: A (admin) uses the dashboard chat with the real model, B (member) uses the MCP SDK in both protocol eras and the real Claude Code CLI with only the URL and a key. It covers the COD order, product creation from chat, "orders today", the approval step, a two-server prompt, revoke → 401, disable → `list_changed` and tools gone in both places, supplier scaled to 0 → Unreachable while woo keeps working (and `GET /api/stats` records the outage with its reason), pod deletion, and audit attribution. Cost: about one US cent of Claude Haiku plus one Claude Code prompt. It cleans up after itself; with `--keep-users` A and B stay, and their generated passwords are in `notes/demo-accounts.local.md` (gitignored, created if missing). |

The end-to-end scripts read the Secrets they need into memory with kubectl and never print them. Both also
run against the VPS with `E2E_STORE_URL`, `E2E_APP_URL`, `E2E_KUBE_CONTEXT` and `E2E_KUBECONFIG`
([VPS.md](docs/VPS.md#verify)).

| Also | What it proves |
|---|---|
| `bash .github/scripts/check-charts.sh` (inside WSL; needs helm and kubeconform) | Every chart lints with `--strict` and renders, with local and prod values, into manifests that pass `kubeconform -strict` against the Kubernetes 1.36.5 schemas |
| `bash scripts/demo/upgrade-rollback.sh` (inside WSL) | Helm 4 upgrade, a broken upgrade rolled back automatically by `--rollback-on-failure` while the gateway keeps answering, a manual rollback, and the store's backup-first path ([OPERATIONS.md](docs/OPERATIONS.md#upgrade-and-rollback)) |
| `bash scripts/backup/backup-now.sh all`, then `verify.sh store` / `verify.sh platform` (inside WSL) | A dump of each database is complete and restores into a throwaway server in a pod with no network, which reports every table and its row count (needs `backup.enabled`, see [OPERATIONS.md](docs/OPERATIONS.md#backups-and-restore)) |

**CI.** `.github/workflows/ci.yml` runs the typecheck, all tests (the gateway's integration test against a
Postgres service container), the bundle builds and the chart check on every push to `main`, on every pull
request and on manual dispatch. On a push to `main` it then builds the five images and pushes them to GHCR,
tagged with the commit's first 7 hex digits. Every action is pinned to a commit SHA.

## Production (VPS) setup

The production target is one **AWS EC2 t3.large** (Ubuntu 24.04, `ap-south-1`) with an Elastic IP, running
**k3s v1.36.5+k3s1**, the same Kubernetes build as the local k3d cluster, so Traefik, local-path storage and the
NetworkPolicy controller behave the same. The full runbook is [docs/VPS.md](docs/VPS.md); every step is a script
in `scripts/vps/`:

```bash
bash scripts/vps/provision-aws.sh plan    # read-only: what exists, what would be created, the cost
bash scripts/vps/provision-aws.sh up      # key pair, Session-Manager-only IAM role, security group (80/443 only), t3.large,
                                          # Elastic IP, and the SSH host key pinned from the console output (no trust on first use)
# Cloudflare: A record *.urumi -> the Elastic IP, DNS only (grey cloud)
bash scripts/vps/bootstrap.sh             # over ssh through AWS Session Manager: k3s, Secrets encryption, SSH hardening
bash scripts/vps/kubeconfig.sh            # ~/.kube/urumi-vps.yaml, context urumi-vps, server 127.0.0.1:16443
bash scripts/vps/tunnel.sh                # in its own terminal: the SSH tunnel to the API (neither 6443 nor 22 is public)
bash scripts/vps/install-addons.sh        # namespaces, cert-manager, Let's Encrypt issuers, HTTP->HTTPS redirect
bash scripts/vps/deploy.sh                # GHCR tags exist? Secrets, three Helm releases, certificates, HTTPS smoke test
```

In short:

- **DNS:** a Cloudflare wildcard record `*.urumi.humanslop.in` → the Elastic IP, DNS-only (grey cloud). Hosts:
  `store.urumi.humanslop.in` and `app.urumi.humanslop.in`.
- **TLS:** cert-manager with Let's Encrypt (HTTP-01 through Traefik), requested by the
  `cert-manager.io/cluster-issuer: letsencrypt-prod` annotation in `values-prod.yaml`;
  `cluster/traefik-prod.yaml` makes Traefik redirect all plain HTTP to HTTPS.
- **Images:** `ghcr.io/galabavamsi/{wordpress,woo-mcp,supplier-mcp,gateway,dashboard}:<git short sha>`, built
  by GitHub Actions; tags are passed with `--set-string`.
- **Access:** kubectl and Helm from the laptop through an SSH tunnel, and the ssh itself runs through AWS Systems
  Manager Session Manager: the security group opens only 80 and 443, so neither the Kubernetes API (6443) nor
  sshd (22) is reachable from the internet, and a new network or IP needs no rule change. Secrets are created with the same `scripts/secrets.sh` through that tunnel.
- **Same charts, `values-prod.yaml`:** each chart has one. The differences (hosts, TLS, `COOKIE_SECURE=true`,
  image registry, storage class and sizes) are listed in [DESIGN.md](docs/DESIGN.md#what-changes-for-production).

`deploy.sh` runs, in effect (after checking that `charts/` is committed and matches the image commit, and,
when the WordPress image changes, taking a dump of the store database first, because WordPress and
WooCommerce migrate it forward on start):

```bash
FLAGS="--wait --wait-for-jobs --timeout 15m --rollback-on-failure"
helm upgrade --install woo-store charts/woo-store -n store -f charts/woo-store/values-prod.yaml \
  --set-string wordpress.image.tag=$SHA --set-string wooMcp.image.tag=$SHA $FLAGS
helm upgrade --install supplier-mcp charts/mcp-server -n mcp-upstreams -f charts/mcp-server/values-prod.yaml \
  -f charts/mcp-server/instances/supplier.yaml --set-string image.tag=$SHA $FLAGS
helm upgrade --install platform charts/platform -n platform -f charts/platform/values-prod.yaml \
  --set-string gateway.image.tag=$SHA --set-string dashboard.image.tag=$SHA $FLAGS
```

While the GHCR packages are private, each command also gets `--set 'imagePullSecrets[0].name=ghcr-pull'`
(`deploy.sh` creates that Secret from `GHCR_PULL_TOKEN`); without it the pods end in `ImagePullBackOff`.

Status: **deployed** on 2026-10-14 with these steps, at that time still over direct ssh to port 22.
`provision-aws.sh up` created the EC2 instance (Elastic IP, security group with SSH from one IP only, SSH host
key pinned from the console output),
`bootstrap.sh` installed k3s with secrets encryption, `install-addons.sh` added cert-manager and the HTTPS
redirect, and `deploy.sh` installed the three releases from CI's images (both Let's Encrypt certificates issued
on the first attempt). Against the live hosts, `scripts/e2e-store.mjs` passed **19/19** and
`scripts/e2e-dod.mjs` passed **16/16**, including the real Claude Code CLI connecting to
`https://app.urumi.humanslop.in/mcp` with only a member's API key. The same evening ssh moved to Session
Manager: `provision-aws.sh up` added the `urumi-vps-ssm` role to the running instance, ssh, `kubeconfig.sh`
and the tunnel were checked through it, and `provision-aws.sh close-ssh` removed the port-22 rule.

Rebuilt on 2026-10-29. Everything had been deleted on 2026-10-28 with `provision-aws.sh down`, and the same
scripts rebuilt it from nothing:
- A new instance and a new Elastic IP. AWS refused to give back the old address.
- `bootstrap.sh`, `install-addons.sh` and `deploy.sh` of commit `92b0062`. That commit also turns on the store's
  demo-store banner (`store.notice` in `values-prod.yaml`): the shop looks real but never ships an order.
- Both Let's Encrypt certificates were issued once the DNS record pointed at the new address.
- Against the live hosts, `scripts/e2e-store.mjs` passed **20/20** and `scripts/e2e-dod.mjs` passed **16/16**,
  again including the real Claude Code CLI.

## Stand-out items attempted

| Item from the brief | Status | Where |
|---|---|---|
| Production-like VPS deployment | Done. Live at `store.urumi.humanslop.in` / `app.urumi.humanslop.in` on EC2 + k3s with Let's Encrypt TLS, CI-built GHCR images and nightly backups; every step scripted (provisioning, k3s bootstrap, SSH-tunnel kubeconfig, cert-manager, deploy with pre-upgrade dump and smoke test), and both end-to-end suites pass against it | `scripts/vps/`, `charts/*/values-prod.yaml`, `cluster/`, `.github/workflows/ci.yml`, [docs/VPS.md](docs/VPS.md) |
| Tool permissions | Done. Per-role deny rules (server or `*`, tool or `*`); denied tools are hidden from `tools/list` and refused on `tools/call` (audited as `denied`). Default: members cannot create products, change order status or send email. Plus the chat approval step before destructive or outbound tools. | `apps/gateway/src/policies/policy.ts`, `apps/gateway/src/mcp/toolRouter.ts`, Tool policies page (`apps/dashboard/src/pages/PoliciesPage.tsx`), `apps/gateway/src/chat/confirm.ts`, `apps/gateway/src/chat/approvals.ts` |
| OAuth on the gateway | Not attempted. API keys only; the 401 deliberately carries no `resource_metadata` so clients don't start OAuth discovery. | — |
| Handling many tools | Not attempted. Only per-server tool allowlists (Firecrawl exposes 3 of its tools, AgentMail 1). | `toolAllowlist` in `charts/platform/values.yaml` |
| Hosted MCP servers by image | Not attempted as a dashboard feature. `charts/mcp-server` is a generic chart that deploys any MCP server image with Secret references, limits and a default-deny NetworkPolicy, but an operator installs it with Helm. | `charts/mcp-server/` |
| Security hardening | Done: SSRF guard (https only, every resolved address must be public, checked again at connect time, no redirects, in-cluster hosts only from an allowlist); default-deny NetworkPolicies in all three charts; every container non-root with a read-only root filesystem, all capabilities dropped and seccomp `RuntimeDefault`; no component talks to the Kubernetes API, so no service-account token is mounted anywhere; upstream credentials AES-256-GCM encrypted at rest; tool definitions from upstreams cleaned and capped | `apps/gateway/src/security/ssrf.ts`, `charts/*/templates/networkpolicies.yaml`, `charts/mcp-server/templates/networkpolicy.yaml`, `apps/gateway/src/crypto/secretBox.ts`, `apps/gateway/src/catalog/`, [THREAT-MODEL.md](docs/THREAT-MODEL.md) |
| Scaling | Partly: per-user rate limits (60 tool calls per minute, 10 per minute per third-party server). The gateway runs as one replica; multi-replica was not attempted. | `apps/gateway/src/policies/rateLimit.ts`, [DESIGN.md](docs/DESIGN.md#scaling-limits) |
| Observability | Done: Prometheus metrics on port 9091 (tool calls by server, tool and status; latency per server; upstream up/down; auth rejections), a precise reason for every unreachable server and failed call, JSON logs, and an admin **Observability** page with each server's status history, 15-minute calls, error rate, p50/p95 latency, a sparkline, top tools and the last error | `apps/gateway/src/metrics.ts`, `apps/gateway/src/upstreams/errors.ts`, `apps/gateway/src/stats/`, `GET /api/stats`, `apps/dashboard/src/pages/observability/`, [OPERATIONS.md](docs/OPERATIONS.md#observability) |
| Upgrades and rollback | Done: a live demo script (a good upgrade, a broken one that Helm 4 rolls back by itself while the gateway keeps answering, a manual rollback, the store's backup-first path); the production `deploy.sh` dumps the store before every WordPress image change and prints the undo commands; expand/contract migrations for the gateway; nightly database dumps with verify, fetch and restore scripts (restore drills tested) | `scripts/demo/upgrade-rollback.sh`, `scripts/vps/deploy.sh`, `scripts/backup/`, `charts/*/templates/backup-*.yaml`, [OPERATIONS.md](docs/OPERATIONS.md#upgrade-and-rollback) |
| Bonus: multi-store provisioning | Not attempted. The `woo-store` chart is already a per-namespace unit, which is the starting point, but there is no provisioning from the dashboard. | — |

## Known limitations

- **One gateway replica.** Pending chat approvals, rate limits, the login throttle and the `list_changed`
  fan-out live in memory, so a second replica would need shared state first
  ([DESIGN.md](docs/DESIGN.md#scaling-limits)).
- **Legacy-protocol clients (Cursor) get no push** when tools change; they see it after a reconnect.
  Server-side rejection does not depend on the client.
- **The wp-cron CronJob has no probes**, because Jobs cannot have them; it has requests, limits and an
  `activeDeadlineSeconds`. Every long-running container has probes.
- **No automated browser tests for the dashboard.** The end-to-end scripts drive the same HTTP API the
  dashboard uses.
- **Store upgrades roll forward only.** WordPress and WooCommerce migrate the database on start, so a store
  image rollback needs the backup taken before the upgrade ([OPERATIONS.md](docs/OPERATIONS.md#upgrade-and-rollback)).
- **WordPress runs one replica with `Recreate`** (its uploads volume is ReadWriteOnce), so a store upgrade has a
  short downtime.
- **The audit log stores a hash of the arguments, not the arguments** (privacy). It shows that a user changed
  an order's status, usually not which order; WooCommerce's own order notes have that. The exception is a
  failed call: its row keeps the error text (up to 300 characters, from the upstream), which can repeat an
  argument such as an order ID.
- **Hosted upstreams can flap.** A single connection reset from a hosted server marks it Unreachable at once;
  the next check runs within 5 s and usually clears it.
- **Chat cost per turn is dominated by tool schemas.** Firecrawl's schemas are large, so every model call reads
  about 10,000 input tokens; an answer that needs one tool takes two model calls, about 22,000 (the gateway's
  `chat turn` log lines). Answers are not streamed token by token.
- **Local storage is a single node's disk** (`local-path`, also on the VPS), and the nightly dumps sit on that
  same disk: they protect against logical damage, not against losing the disk. Copying them off is manual
  (`scripts/backup/fetch.sh`), and product images (the uploads volume) are not in the dumps.
- **No password change or reset** in the dashboard yet, and users are disabled rather than deleted (so the audit
  log stays attributable), which means a disabled user's email cannot be invited again.
- **No license chosen yet** (no LICENSE file); the author keeps the copyright.
