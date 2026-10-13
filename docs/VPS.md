# Production VPS runbook

The same three Helm charts that run on the laptop's k3d cluster, on one AWS EC2 machine with real TLS:

- `https://store.urumi.humanslop.in` is the WooCommerce storefront.
- `https://app.urumi.humanslop.in` serves the dashboard, the gateway API (`/api`) and the MCP endpoint (`/mcp`).

Only values change between the two environments (table in [What changes vs local](#what-changes-vs-local)).
Every step below is a script in `scripts/vps/`. They are safe to re-run, and they never touch the local `k3d-urumi` cluster.

```
 your laptop (WSL)                                      AWS ap-south-1 (Mumbai)
 ┌──────────────────────────┐   SSH :22 (your IP only)  ┌─────────────────────────────────────────┐
 │ kubectl / helm           │══════ tunnel ═══════════► │ EC2 t3.large, Ubuntu 24.04, Elastic IP  │
 │  -> 127.0.0.1:16443      │   (to 127.0.0.1:6443)     │  k3s v1.36.5+k3s1 (one node)            │
 └──────────────────────────┘                           │   Traefik :80 -> 301 to :443 (TLS)      │
 browsers, Claude Code ──── HTTPS :443 ───────────────► │   cert-manager + Let's Encrypt (HTTP-01)│
 Cloudflare DNS: *.urumi A <Elastic IP>, DNS only       │   store / platform / mcp-upstreams      │
                                                        └─────────────────────────────────────────┘
```

| Step | Script | Runs where | Time |
|---|---|---|---|
| 1. Create the machine | `provision-aws.sh up` | your machine (AWS CLI) | ~2 min |
| 2. DNS record | Cloudflare dashboard | browser | ~1 min (+ propagation) |
| 3. Install k3s | `bootstrap-k3s.sh` | on the VPS, over SSH | ~3 min |
| 4. kubeconfig + tunnel | `kubeconfig.sh`, `tunnel.sh` | WSL | seconds |
| 5. Cluster add-ons | `install-addons.sh` | WSL, through the tunnel | ~2 min |
| 6. Images | CI pushes to GHCR | GitHub Actions | per push |
| 7. Deploy | `deploy.sh` | WSL, through the tunnel | ~5 min first time |

## Prerequisites

- **AWS CLI v2** with working credentials for the account. For example, run `aws login` once, then `export AWS_PROFILE=aws-main`.
  - Check with `aws sts get-caller-identity`.
  - The scripts pass `--region ap-south-1` on every call, so an `AWS_REGION` set for something else does not matter.
  - Prefer an IAM Identity Center or IAM user with MFA over the root user for day-to-day CLI work.
  - `provision-aws.sh` runs in WSL, Linux, macOS or Git Bash on Windows. On this laptop the AWS CLI lives on Windows, so run it from Git Bash and copy the key into WSL as it tells you.
- **In WSL:** `kubectl` 1.36, `helm` 4.3 (both from `scripts/setup-wsl-docker.sh`), plus `ssh`, `curl`, `git` and `envsubst` (Ubuntu ships them).
- **Cloudflare** access to the `humanslop.in` zone.
- **Images in GHCR.** CI builds `ghcr.io/galabavamsi/{wordpress,woo-mcp,supplier-mcp,gateway,dashboard}`, tagged with the first 7 hex digits of the commit.
  - While the repository is private, the packages are private too. Then `deploy.sh` needs `GHCR_PULL_TOKEN`: a classic GitHub token with only `read:packages`.
  - The images hold no secrets, so making the packages public removes that step.
- **`.env`** (gitignored) with the same keys as locally: `BOOTSTRAP_ADMIN_EMAIL`, `BOOTSTRAP_ADMIN_PASSWORD`, `ANTHROPIC_API_KEY`, `FIRECRAWL_API_KEY`, `AGENTMAIL_API_KEY`.
  - A key that is missing or empty is reported as "not set (skipped)" and its Secret is left alone.
  - Optional extras for the VPS: `ACME_EMAIL` and `GHCR_PULL_TOKEN` (both listed in `.env.example`).

## Costs and saving credits

| | Per hour | Per day |
|---|---|---|
| t3.large running (on-demand, Mumbai) | $0.0896 | $2.15 |
| Public IPv4 (the Elastic IP; billed while the instance is stopped too) | $0.005 | $0.12 |
| 40 GB gp3 disk ($0.0912/GB-month) | | $0.12 |
| **Running total** | | **≈ $2.4** |
| **Stopped** (disk + IP only) | | **≈ $0.25** |

t3 runs in "unlimited" CPU-credit mode by default: CPU is never throttled. Only a CPU average above the 30% baseline would cost extra ($0.05 per vCPU-hour), and this stack idles far below it.

Stop the machine when you are not demoing or testing:
- `bash scripts/vps/provision-aws.sh stop` stops it.
- `... start` brings it back with the same IP and data. k3s and every pod start by themselves within 1-2 minutes; then restart the tunnel.

## 1. Create the machine

```bash
bash scripts/vps/provision-aws.sh plan   # read-only: what exists, what would be created, the cost
bash scripts/vps/provision-aws.sh up     # creates what is missing (safe to re-run)
```

Everything is tagged `Project=urumi` and named `urumi-vps`. `up` creates:

| Resource | Settings | Why |
|---|---|---|
| Key pair `urumi-vps` (ed25519) | private key saved to `~/.ssh/urumi-vps.pem`, mode 600, never printed | AWS keeps only the public half and cannot hand out the private key again: don't lose the file |
| Security group `urumi-vps` | tcp 80 and 443 from `0.0.0.0/0` and `::/0`; tcp 22 from **your IP/32** only; nothing else | 6443 (the Kubernetes API) is never open; kubectl uses the SSH tunnel |
| Instance `urumi-vps` | t3.large; latest Ubuntu 24.04 amd64 AMI from Canonical's public SSM parameter; 40 GB encrypted gp3 root disk with `DeleteOnTermination=false`; IMDSv2 required with hop limit 1; termination protection; no IAM role | security notes below |
| Elastic IP | associated with the instance | the address, and so the DNS record, survive stop/start and instance replacement |

At the end it prints the IP, the SSH command and the DNS record to add.

- **Your IP changed** (new Wi-Fi, a new day): `bash scripts/vps/provision-aws.sh allow-my-ip` points the SSH rule at your current address.
- **Overview at any time:** `bash scripts/vps/provision-aws.sh status` shows the state, the IP, the SSH rule vs your IP, and what public DNS answers.
- **Key created from Git Bash on Windows:** copy it into WSL once with the `install -m 600 ...` command the script prints. ssh, kubectl and helm run there.

## 2. DNS: one wildcard record, grey cloud

In Cloudflare, zone `humanslop.in`, go to **DNS**, then **Add record**:

| Type | Name | IPv4 address | Proxy status | TTL |
|---|---|---|---|---|
| A | `*.urumi` | the Elastic IP | **DNS only** (grey cloud) | Auto |

This covers `store.urumi.humanslop.in` and `app.urumi.humanslop.in`; the apex site and the Google Workspace MX records are untouched.

**Why DNS only, not the orange-cloud proxy:**
- **Long streams.** Cloudflare's proxy cuts long-lived responses after about 100-125 s. MCP clients hold a `subscriptions/listen` stream open for the live tool list, and the chat streams over SSE, so both would be cut.
- **Simpler TLS.** With grey cloud, Let's Encrypt's HTTP-01 check reaches our Traefik directly, and the certificate browsers see is the one on the VPS. Encryption is end to end, with no Cloudflare origin certificate or SSL mode to configure.

Check with `bash scripts/vps/provision-aws.sh status`. Both hosts must resolve to the Elastic IP before step 7, or Let's Encrypt cannot validate them.

## 3. Install k3s on the VPS

```bash
export VPS_HOST=<elastic-ip>
ssh -i ~/.ssh/urumi-vps.pem ubuntu@$VPS_HOST 'bash -s' < scripts/vps/bootstrap-k3s.sh
```

The script runs as `ubuntu` and calls `sudo` itself. It is safe to re-run.

1. **Safe host hardening.**
   - Automatic **security** updates via unattended-upgrades, with no automatic reboot. After a kernel update, run `sudo reboot` when convenient; k3s and every pod come back on their own.
   - SSH: keys only, no root login, only local port forwarding (all the tunnel needs).
   - The host firewall `ufw` stays **off** on purpose. k3s programs iptables itself (kube-proxy, flannel, and kube-router for NetworkPolicies), and ufw's default "drop forwarded" policy silently breaks pod and Service traffic unless you add rules for 10.42.0.0/16 and 10.43.0.0/16. The two rule sets also fight over the same chains. The AWS security group already filters inbound traffic outside the machine, so ufw would add risk and no protection.
2. **`/etc/rancher/k3s/config.yaml`.**
   - `node-name: urumi-vps`.
   - `write-kubeconfig-mode: "0600"`: the admin kubeconfig is readable by root only.
   - `secrets-encryption: true`: Kubernetes Secrets are AES-encrypted before they reach the datastore on disk.
   - `tls-san: [<public IP>]`. The IP comes from the instance metadata service.
3. **k3s `v1.36.5+k3s1`**, the same build as the local k3d image, installed with the official installer.
   - The installer is fetched from that release's tag and checked against a pinned SHA-256.
   - The installer itself checks the k3s binary against the release's checksum file.
   - It is retried, because GitHub release downloads sometimes fail for a minute.
4. **Waits** until the node, CoreDNS and Traefik are ready, and prints `Secrets encryption at rest: Enabled`.

## 4. kubeconfig and tunnel

```bash
bash scripts/vps/kubeconfig.sh   # -> ~/.kube/urumi-vps.yaml (mode 600), context urumi-vps
bash scripts/vps/tunnel.sh       # its own terminal; Ctrl-C closes it, it reconnects by itself after drops
kubectl --kubeconfig ~/.kube/urumi-vps.yaml get nodes
```

**`kubeconfig.sh`:**
- Copies `/etc/rancher/k3s/k3s.yaml` over SSH (root-only, hence `sudo`).
- Points it at `https://127.0.0.1:16443`, the local end of the tunnel.
- Renames k3s's generic `default` cluster, user and context to `urumi-vps`.

**It is a file of its own:** your `~/.kube/config` (with `k3d-urumi`) is never edited, so nothing points at production by accident. Use it with:
- `export KUBECONFIG=~/.kube/urumi-vps.yaml`, or
- `--kubeconfig ~/.kube/urumi-vps.yaml` on each command.

**`tunnel.sh`** runs `ssh -N -L 127.0.0.1:16443:127.0.0.1:6443` with keepalives every 30 s.
- The local end listens on loopback only.
- The API server's own port is reachable only from the VPS itself.

All later scripts use context `urumi-vps` in `~/.kube/urumi-vps.yaml`, whatever your current context is, and they refuse `k3d-urumi`. `KUBE_CONTEXT` and `KUBECONFIG_FILE` override this (`scripts/vps/common.sh`).

## 5. Cluster add-ons (once)

```bash
bash scripts/vps/install-addons.sh          # ACME_EMAIL optional (environment or .env)
```

1. **Namespaces** `store`, `platform`, `mcp-upstreams`, with the same Pod Security labels as locally (`cluster/namespaces.yaml`).
2. **cert-manager v1.21.2** from `oci://quay.io/jetstack/charts/cert-manager`.
   - CRDs are installed with the chart and kept on uninstall.
   - Requests and limits are set (`cluster/cert-manager/values.yaml`).
   - Its namespace enforces Pod Security `restricted`.
3. **ClusterIssuers** `letsencrypt-staging` and `letsencrypt-prod` (`cluster/cert-manager/cluster-issuers.yaml`).
   - HTTP-01 solver, ingress class `traefik`.
   - The email line is filled from `ACME_EMAIL` or removed. It is optional: since June 2025 Let's Encrypt sends no expiry emails and keeps no account addresses.
4. **Traefik HTTP→HTTPS redirect** (`cluster/traefik-prod.yaml`). k3s's helm-controller re-renders the bundled Traefik with a permanent redirect (301) on the `web` entrypoint, so checkout forms, cookies and API keys never travel in cleartext.

### How HTTP-01 works through the redirect

For each Ingress with the `cert-manager.io/cluster-issuer` annotation and a `tls` block, cert-manager does three things:
1. It starts a solver pod and a temporary Ingress for `http://<host>/.well-known/acme-challenge/<token>`, in the app's namespace.
2. It fetches that URL itself (the "self-check").
3. It asks Let's Encrypt to fetch it.

The redirect sends that request to `https://<host>/.well-known/...` on port 443. That is fine:
- **Let's Encrypt** follows redirects to https on port 443 and does not check the certificate there. It is still Traefik's self-signed default, since the real one is what we are asking for.
- **cert-manager's self-check** does the same.
- **On https the challenge route still matches.** The solver Ingress has no entrypoint annotation, so Traefik serves it on both entrypoints. Its exact path wins over the app's `/` rule.
- **The solver pod is not blocked.** Our default-deny NetworkPolicies select only pods with the chart's release label, and the solver meets the namespaces' Pod Security level.

This was rehearsed end to end with Let's Encrypt's own test CA (Pebble), which validates like Let's Encrypt; see [How this was tested](#how-this-was-tested).

## 6. Images from CI

`.github/workflows/ci.yml` runs on every push and pull request: typecheck, unit and integration tests (against a Postgres
service container), bundle builds, and `helm lint` + `helm template | kubeconform -strict` of every chart with local and prod
values (`.github/scripts/check-charts.sh`). Only on a push to `main`, and only when those pass, it builds the five images for
linux/amd64 and pushes them to `ghcr.io/galabavamsi/<name>:<first 7 hex digits of the commit>` (plus the full SHA; never `latest`).
- It needs no secret: the job token gets `packages: write` for the image job only. Keep **Settings → Actions → General →
  Workflow permissions** on the read-only default.
- The first push creates the five packages as **private** (the repository is private). Either set `GHCR_PULL_TOKEN` for
  `deploy.sh`, or make each package public (package settings → Change visibility). Public packages also publish the Node
  bundles with their source maps, which embed the TypeScript source.
- If a package already exists from an earlier manual push, link it to the repository first (package settings → Manage
  Actions access → add the repository with role Write), or the push fails with 403.
- Check with `gh run list --workflow ci.yml --limit 5` and `gh run view <id> --log-failed`.
- `deploy.sh` verifies, before touching the cluster, that all five tags exist.
  - It uses GHCR's registry API: a pull token from `ghcr.io/token`, then `HEAD /v2/<repo>/manifests/<tag>`.
  - When a tag is missing, it tells you which image and stops.

## 7. Deploy

```bash
bash scripts/vps/deploy.sh                                  # TAG = HEAD's first 7 hex digits
TAG=1a2b3c4 bash scripts/vps/deploy.sh                      # a specific commit CI built
CLUSTER_ISSUER=letsencrypt-staging bash scripts/vps/deploy.sh   # first try with staging certificates
GHCR_PULL_TOKEN=... bash scripts/vps/deploy.sh              # private packages (or put it in .env)
```

1. **Images:** checks that the five GHCR tags exist.
2. **Secrets:** runs `scripts/secrets.sh` with a temporary kubeconfig that contains only the VPS context, so it cannot reach any other cluster.
   - Internal secrets are generated once and kept.
   - `.env` secrets are applied again on every run.
3. **Pull secret (private packages only):** with `GHCR_PULL_TOKEN`, writes Secret `ghcr-pull` (type dockerconfigjson) into `store`, `platform` and `mcp-upstreams`.
   - The token never appears in a process list or in output.
   - A release gets `imagePullSecrets` whenever that Secret exists in its namespace.
4. **Releases:** `helm upgrade --install` of `woo-store`, `supplier-mcp`, then `platform`.
   - Each uses its chart's `values-prod.yaml` with `--set-string` image tags.
   - Each runs with `--wait --timeout 15m --rollback-on-failure`.
   - No `--reuse-values`: the files are the whole truth.
5. **Certificates:** waits until both Certificates are Ready, which takes 30-90 s the first time.
6. **Smoke test:** expects a 301 to https for `http://store…/checkout/`, 200 for `https://store…/shop/` and `https://app…/`, and 401 for `https://app…/api/auth/me`.

`CLUSTER_ISSUER=letsencrypt-staging` switches both Ingresses to untrusted staging certificates, which have generous rate limits. A normal run afterwards switches back, and cert-manager re-issues. Let's Encrypt prod allows 5 failed validations per hostname per hour and 5 identical certificates per week.

The first deploy pulls just under 1 GB of images (WordPress alone is ~325 MB), so expect around 5 minutes.

## Verify

1. **Browser:** open `https://store.urumi.humanslop.in` (padlock, certificate issued by Let's Encrypt) and do a Cash-on-Delivery checkout.
2. **Dashboard:** open `https://app.urumi.humanslop.in` and log in as the bootstrap admin from `.env`.
3. **Claude Code:**
   ```
   claude mcp add --transport http urumi https://app.urumi.humanslop.in/mcp --header "Authorization: Bearer <key>"
   ```
4. **Plain-HTTP redirect:** `curl -sI http://store.urumi.humanslop.in/checkout/` must return `301` with `Location: https://…`.
5. **The end-to-end scripts.** Run them against production with these overrides; the defaults stay the local cluster:

| Variable | Meaning | Local default |
|---|---|---|
| `E2E_STORE_URL` | storefront base URL (older name `STORE_URL` still works) | `http://store.127-0-0-1.sslip.io` |
| `E2E_APP_URL` | dashboard/gateway base URL, `e2e-dod.mjs` only (older name `APP_URL`) | `http://app.127-0-0-1.sslip.io` |
| `E2E_KUBE_CONTEXT` | kubectl/helm context | the current context |
| `E2E_KUBECONFIG` | kubeconfig file (a WSL path when kubectl runs in WSL) | kubectl's default |
| `E2E_WSL=0` | call kubectl/helm directly even on Windows | through WSL on Windows |

From Windows PowerShell (kubectl runs in WSL, where `tunnel.sh` is running):

```powershell
$env:E2E_STORE_URL = 'https://store.urumi.humanslop.in'
$env:E2E_APP_URL = 'https://app.urumi.humanslop.in'
$env:E2E_KUBE_CONTEXT = 'urumi-vps'
$env:E2E_KUBECONFIG = '/home/<wsl-user>/.kube/urumi-vps.yaml'
node scripts/e2e-store.mjs        # 19 checks; creates and deletes one test product and one guest order
node scripts/e2e-dod.mjs          # the Definition of Done; demo accounts go to notes/demo-accounts.app.urumi.humanslop.in.md
```

On Linux or macOS with node and kubectl installed natively, use the same variables without `E2E_WSL`.

On an https store, check `c6` of `e2e-store.mjs` signs its WooCommerce REST calls through a port-forward to the `wordpress` Service, the same plain in-cluster hop woo-mcp uses. The reason: behind Traefik, WooCommerce verifies OAuth signatures with scheme https, while woo-mcp's signer always uses http.

## Day-2 operations

| Task | How |
|---|---|
| Ship a new version | push, wait for CI, `bash scripts/vps/deploy.sh` |
| See releases | `helm --kubeconfig ~/.kube/urumi-vps.yaml --kube-context urumi-vps list -A` |
| Roll back the gateway or an MCP server | `helm … history platform -n platform`, then `helm … rollback platform <revision> -n platform --wait` |
| Back up now / copy off the VPS | `KUBECONFIG=~/.kube/urumi-vps.yaml bash scripts/backup/backup-now.sh all --context urumi-vps`, then `fetch.sh store` and `fetch.sh platform` with the same options |
| Roll back the store | database migrations only go forward: back up before the upgrade; to undo it, `helm … rollback woo-store <revision>` first, then `scripts/backup/restore-store.sh <that dump>` (docs/OPERATIONS.md) |
| Rotate an `.env` secret | edit `.env`, run `deploy.sh` (re-applies it), restart the gateway: `kubectl … -n platform rollout restart deploy/gateway` |
| Your IP changed | `bash scripts/vps/provision-aws.sh allow-my-ip`, then restart `tunnel.sh` |
| Pause to save credits | `provision-aws.sh stop`, and later `start` (same IP and data) |
| Kernel update pending | `ssh … sudo reboot` (pods come back by themselves in ~2 min) |
| Instance replaced, same IP | `ssh-keygen -R <elastic-ip>` (new host key), then steps 3-5 |

## What changes vs local

Everything not listed is identical: templates, NetworkPolicies, probes, security contexts and Secret names.

| Chart / place | Key | Local (`values-local.yaml`, k3d) | Production (`values-prod.yaml`, VPS) |
|---|---|---|---|
| woo-store | `ingress.host` | `store.127-0-0-1.sslip.io` | `store.urumi.humanslop.in` |
| woo-store | `ingress.annotations` | none | `cert-manager.io/cluster-issuer: letsencrypt-prod` |
| woo-store | `ingress.tls.enabled` | `false` | `true` (Secret `woo-store-tls`). This also makes WP_HOME and woo-mcp's `WOO_HOME_URL` `https://store.urumi.humanslop.in`, and the probes send `X-Forwarded-Proto: https` |
| woo-store | `wordpress.image` | `urumi/wordpress:<local tag>` | `ghcr.io/galabavamsi/wordpress:<sha>` |
| woo-store | `wordpress.environmentType` | `local` | `production` |
| woo-store | `wordpress.resources` | 100m/256Mi, limit 1/768Mi | 250m/384Mi, limit 1500m/1536Mi |
| woo-store | `wordpress.persistence` | 1Gi, default class | 5Gi, `local-path` |
| woo-store | `wordpress.bootstrap` / `cron` resources | 50m/128Mi, 25m/96Mi | chart defaults: 100m/192Mi, 50m/128Mi |
| woo-store | `mariadb.resources` | 50m/256Mi, limit 1/768Mi | 100m/384Mi, limit 1/1Gi |
| woo-store | `mariadb.persistence.size` | 1Gi | 10Gi, `local-path` |
| woo-store | `wooMcp.image` / `resources` | `urumi/woo-mcp`, 25m/64Mi, limit 250m/192Mi | `ghcr.io/galabavamsi/woo-mcp`, 50m/96Mi, limit 500m/256Mi |
| woo-store, platform | `backup.enabled` | `false` (default) | `true` (docs/OPERATIONS.md) |
| platform | `ingress.host` | `app.127-0-0-1.sslip.io` | `app.urumi.humanslop.in` |
| platform | `ingress.annotations` / `tls` | none / off | `letsencrypt-prod` / on (Secret `platform-tls`) |
| platform | `gateway.publicBaseUrl` | `http://app.127-0-0-1.sslip.io` | `https://app.urumi.humanslop.in` |
| platform | `gateway.cookieSecure` | `false` | `true` (the chart refuses a mismatch with the URL scheme) |
| platform | `gateway.image` / `resources` | `urumi/gateway`, 50m/128Mi, limit 1/384Mi | `ghcr.io/galabavamsi/gateway`, 100m/192Mi, limit 1/768Mi |
| platform | `dashboard.image` / `resources` | `urumi/dashboard`, 5m/16Mi, limit 100m/64Mi | `ghcr.io/galabavamsi/dashboard`, chart defaults 10m/32Mi, limit 200m/128Mi |
| platform | `postgres.resources` / `persistence` | 50m/128Mi, limit 1/512Mi; 1Gi | chart defaults 100m/256Mi, limit 1/1Gi; 5Gi `local-path` |
| mcp-server (supplier) | `image.registry` / `tag` | `urumi`, `dev` or dev-up's tag | `ghcr.io/galabavamsi`, `<sha>` |
| mcp-server (supplier) | `resources` | 25m/64Mi, limit 250m/192Mi | 50m/96Mi, limit 500m/256Mi |
| all charts | `imagePullSecrets` | `[]` | `[]`; `deploy.sh` adds `ghcr-pull` when that Secret exists |
| cluster | Traefik | defaults (plain http) | HTTP→HTTPS redirect (`cluster/traefik-prod.yaml`) |
| cluster | cert-manager | not installed | v1.21.2 + two Let's Encrypt ClusterIssuers |
| cluster | k3s | k3d (k3s in Docker), API on 127.0.0.1:6550 | k3s systemd service, Secrets encrypted at rest, API only through the SSH tunnel |
| cluster | Secrets | `scripts/secrets.sh` from `.env` | the same script, aimed at the VPS by `deploy.sh` |

### Resource budget (t3.large: 2 vCPU, 8 GiB)

Allocatable memory is about 7.5 GiB: 8 GiB minus the kernel's share and k3s's 100 MiB eviction threshold.

| Pod | CPU request | Memory request | Memory limit |
|---|---|---|---|
| wordpress (its bootstrap init container, 192Mi, runs before it) | 250m | 384Mi | 1536Mi |
| mariadb | 100m | 384Mi | 1Gi |
| woo-mcp | 50m | 96Mi | 256Mi |
| wp-cron (a run of up to 4 minutes, every 5 minutes) | 50m | 128Mi | 768Mi |
| supplier-mcp | 50m | 96Mi | 256Mi |
| gateway | 100m | 192Mi | 768Mi |
| dashboard | 10m | 32Mi | 128Mi |
| postgres | 100m | 256Mi | 1Gi |
| **our workloads** | **710m** | **1568Mi** | **5760Mi** |
| cert-manager (controller, webhook, cainjector) | 30m | 160Mi | 640Mi |
| k3s add-ons (CoreDNS, metrics-server; Traefik and local-path set none) | 200m | 140Mi | 170Mi |
| **node total** | **940m of 2000m (47%)** | **1868Mi ≈ 1.8 GiB of ~7.5 GiB (25%)** | **≈ 6.4 GiB** |

This leaves headroom:
- Requests use a quarter of the memory, so the two backup CronJobs (50m/64Mi each, limit 256Mi, about a minute a night), cert-manager's solver pods during issuance and a rolling update's second pod all fit.
- Even every limit at once (≈ 6.4 GiB) stays under allocatable, so no pod can push the node into memory pressure.
- The rehearsal cluster measured `cpu 890m, memory 1740Mi` requested: the same figures without wp-cron, which was between runs.
- Actual idle use is far lower: about 0.7 GiB for everything (`kubectl top`).

## Security notes

- **The Kubernetes API is never public.**
  - Port 6443 is not in the security group.
  - kubectl reaches the API only through `tunnel.sh`: an SSH local forward, authenticated with your key, from your IP.
  - The local end listens on 127.0.0.1 only.
  - The kubeconfig holds cluster-admin credentials: mode 600, a separate file, never printed.
- **SSH:**
  - Port 22 is open only to your current IP/32; `allow-my-ip` moves it.
  - Key-only login; no passwords, no root login.
  - Only local port forwarding (`AllowTcpForwarding local`).
  - The ed25519 key is generated by AWS and written straight to a mode-600 file.
- **IMDSv2 only, hop limit 1, no IAM role.**
  - The instance metadata service answers only with a session token, which needs a PUT. With hop limit 1, the token reply cannot cross the extra network hop into a pod.
  - So a compromised pod (or an SSRF in the gateway) cannot read instance metadata, let alone credentials.
  - There is no role to steal anyway.
  - The gateway's NetworkPolicy also blocks 169.254.0.0/16, and its SSRF guard blocks the metadata IP.
- **Data at rest:**
  - k3s encrypts Secrets before they reach its datastore (`secrets-encryption: true`).
  - The whole EBS volume is also encrypted (AWS-managed key).
  - The root volume survives an accidental termination (`DeleteOnTermination=false`), and termination protection is on.
- **Security group:**
  - Inbound is only 80, 443 and 22 (yours).
  - Egress is open: image pulls, Let's Encrypt, Anthropic, Firecrawl and AgentMail need it.
  - Inside the cluster, egress is narrowed per pod by the default-deny NetworkPolicies.
- **TLS everywhere:**
  - Let's Encrypt certificates, renewed automatically about 30 days before expiry.
  - Every plain-http request is redirected.
  - The session cookie is `Secure`.
  - (HSTS is not set yet; it would be a Traefik middleware.)
- **Patching:** unattended-upgrades installs security updates daily. Reboots are manual, so a demo is never interrupted.
- **Supply chain:**
  - Every version is pinned: k3s, its installer (by SHA-256), cert-manager, images by git SHA.
  - Images come only from GHCR (our CI), Docker Hub official images and quay.io/jetstack.

## Backups and restore

`backup.enabled: true` in both `values-prod.yaml` turns on the nightly dumps: MariaDB at 02:00 IST (CronJob `mariadb-backup`, PVC
`mariadb-backups`) and Postgres at 02:15 IST (`postgres-backup`, `postgres-backups`), 7 kept each. The PVCs are on the same EBS
disk as the databases, so they cover logical damage only; copy dumps off the machine. How they work, the restore procedure and
the commands are in [OPERATIONS.md](OPERATIONS.md#backups-and-restore) and [scripts/backup/README.md](../scripts/backup/README.md).
The scripts take `--context`; point them at the VPS like this (tunnel running):

```bash
export KUBECONFIG=~/.kube/urumi-vps.yaml
bash scripts/backup/backup-now.sh all --context urumi-vps
bash scripts/backup/fetch.sh store --context urumi-vps       # -> ~/urumi-backups/urumi-vps/store/
bash scripts/backup/fetch.sh platform --context urumi-vps
```

Keep a copy of the Secrets as well, apart from the dumps: a gateway dump is useless without the `gateway-internal` Secret it was
made with. Take a fresh backup and download it before `provision-aws.sh down`, or before a store upgrade that migrates the database.

The upgrade/rollback demo runs against the VPS too; it ships a deliberately broken gateway release, so it asks for
`--allow-remote`:
`KUBECONFIG=~/.kube/urumi-vps.yaml bash scripts/demo/upgrade-rollback.sh --context urumi-vps --allow-remote --app-url https://app.urumi.humanslop.in`.

## Teardown

```bash
bash scripts/vps/provision-aws.sh down
```

1. It lists every resource tagged `Project=urumi` (instance, disk, Elastic IP, security group, key pair).
2. It asks you to type `destroy urumi-vps`.
3. Then it:
   - turns off termination protection;
   - terminates the instance;
   - deletes the kept disk;
   - releases the IP;
   - deletes the security group and the key pair.

Afterwards:
- Remove the Cloudflare `*.urumi` record.
- Optionally remove `~/.ssh/urumi-vps.pem`, `~/.kube/urumi-vps.yaml` and the `known_hosts` entry (`ssh-keygen -R <ip>`).

## Troubleshooting

| Symptom | Look at |
|---|---|
| `deploy.sh`: certificate not Ready | DNS first (`provision-aws.sh status`). Then `kubectl -n store get certificaterequests,orders,challenges` and `kubectl -n store describe challenges`. If the reason mentions rate limits, switch to `CLUSTER_ISSUER=letsencrypt-staging` and wait. If cert-manager's self-check cannot reach the host from inside the cluster (`propagation check failed`) while the URL works from outside, the http01 solver's `waitInsteadOfSelfCheck` option in `cluster-issuers.yaml` skips the self-check |
| Browser shows "TRAEFIK DEFAULT CERT" | normal for a few seconds right after issuance (`deploy.sh` waits for it); if it stays, `kubectl -n store get secret woo-store-tls` and the Traefik logs |
| `tunnel.sh` keeps reconnecting | your IP changed (`provision-aws.sh allow-my-ip`) or the instance is stopped (`status`) |
| `kubeconfig.sh` / ssh: host key changed | the instance was replaced: `ssh-keygen -R <elastic-ip>` |
| `deploy.sh`: "not in GHCR for tag …" | the commit was not pushed or CI is still running (`gh run list`), or the packages are private and `GHCR_PULL_TOKEN` is not set |
| Pods stuck in `ImagePullBackOff` | private packages without `ghcr-pull`, or an expired token: set `GHCR_PULL_TOKEN` and deploy again |

## How this was tested

No AWS resource was created while writing these scripts; `provision-aws.sh plan` (read-only lookups) was run against the account. Everything else was rehearsed locally:

- **Shell scripts:** `scripts/vps/*.sh` pass shellcheck 0.11.0 (`-S style`, sourced files followed).
- **Throwaway k3d cluster** (k3s v1.36.5, separate network and ports). The real `install-addons.sh` and `deploy.sh` were run against it:
  - Hosts came from `BASE_DOMAIN=<node-ip>.sslip.io`.
  - Images were the CI names, imported by hand (`SKIP_IMAGE_CHECK=1`).
  - Issuer: `CLUSTER_ISSUER=pebble`, an in-cluster Pebble, Let's Encrypt's test ACME server. It validates HTTP-01 on port 80 and follows redirects exactly as Let's Encrypt does.
- **Results on the throwaway cluster:**
  - Both certificates were issued through the HTTP→HTTPS redirect.
  - The smoke test passed with TLS verified against Pebble's root.
  - A second `deploy.sh` run was a no-op.
  - `e2e-store.mjs` passed 19/19 over https via `E2E_*` overrides with `E2E_WSL=0`.
  - `e2e-dod.mjs` passed every check that does not need the LLM or the hosted upstream keys, over https with the Secure cookie.
- **Stand-in VPS:** a disposable Ubuntu 24.04 systemd container with sshd. The real `bootstrap-k3s.sh` was run over SSH, followed by `kubeconfig.sh` and `tunnel.sh`. Results:
  - The node became Ready through the tunnel.
  - The sshd settings took effect.
  - A second run was a no-op.
  - Secrets encryption works: a ConfigMap value was found in plain text in the datastore files, a Secret value was not.
