# woo-store chart

One WooCommerce store in one namespace. The chart is the "tenant unit": a second store is a second
release in a second namespace.

| Object | Kind | Notes |
|---|---|---|
| `wordpress` | Deployment (1 replica, `Recreate`) + Service `:8080` + Ingress | Image `images/wordpress`: WordPress 7.1.3, WooCommerce 11.2.1, Storefront 4.6.2 and WP-CLI 2.12.0 baked in. Apache runs as uid 33 on 8080. An init container (`bootstrap`) configures the store before Apache starts. |
| `wordpress-uploads` | PVC (RWO) | `wp-content/uploads` only. Code is immutable in the image. |
| `mariadb` | StatefulSet + Service `:3306` | `mariadb:11.8.9`, runs as uid 999, data on a `volumeClaimTemplate`. |
| `wp-cron` | CronJob (every 5 min) | `wp cron event run --due-now`. Replaces WP-Cron's HTTP loopback, which cannot work in-cluster (`DISABLE_WP_CRON`). |
| `woo-mcp` | Deployment + Service `:8080` | Our MCP server (`apps/woo-mcp`). Only if `wooMcp.enabled` (default `true`). |
| `<release>-*` | NetworkPolicy ×6 | Default deny, then one allow per path (below). |

The chart never creates Secrets or namespaces. `scripts/secrets.sh` creates both (names in
`docs/CONTRACTS.md`), and the chart refers to the Secrets by name (`secrets.*` values).

## Install

```bash
# local (k3d): build the image, load it into the cluster, install
docker build -t urumi/wordpress:dev images/wordpress
k3d image import urumi/wordpress:dev -c urumi
helm upgrade --install woo-store charts/woo-store -n store -f charts/woo-store/values-local.yaml \
  --wait --timeout 10m --rollback-on-failure

# production (k3s on the VPS): images from GHCR, tagged with the git SHA
helm upgrade --install woo-store charts/woo-store -n store -f charts/woo-store/values-prod.yaml \
  --set wordpress.image.tag=$SHA --set wooMcp.image.tag=$SHA \
  --wait --timeout 10m --rollback-on-failure
```

`values.yaml` holds the defaults. The environment files override only what differs:

| | `values-local.yaml` | `values-prod.yaml` |
|---|---|---|
| Host / home URL | `http://store.127-0-0-1.sslip.io` | `https://store.urumi.humanslop.in` |
| TLS | off | cert-manager (`cert-manager.io/cluster-issuer: letsencrypt-prod`) + `tls` block |
| Images | `urumi/wordpress:dev`, `urumi/woo-mcp:dev` (via `k3d image import`) | `ghcr.io/galabavamsi/urumi-{wordpress,woo-mcp}:<sha>`. The tag is required at deploy time; empty or `latest` fails the render. |
| Storage | 1Gi each, default StorageClass | uploads 5Gi, MariaDB 10Gi, `storageClass: local-path` |
| Resources | small requests | values.yaml defaults |
| `WP_ENVIRONMENT_TYPE` | `local` | `production` |

To lint the prod file, pass the tags too:
`helm lint charts/woo-store -f charts/woo-store/values-prod.yaml --set wordpress.image.tag=x --set wooMcp.image.tag=x`.

## Bootstrap (init container, every pod start)

`urumi-bootstrap.sh` (in the image) makes the database match the values. On an empty database it
builds the store. Otherwise every step finds nothing to change, so a restart costs about 2 s. Each
step logs one line (`kubectl -n store logs deploy/wordpress -c bootstrap`):

1. Wait until the WordPress DB user can log in.
2. `wp core install` if WordPress is not installed yet.
3. Activate WooCommerce and Storefront.
4. Run the DB migrations (`wp core update-db`, `wp wc update`).
5. Enable HPOS with `wp wc hpos enable`.
6. Run `configure-store.php` in a single WordPress load:
   - store settings: name, Bengaluru address `IN:KA`, INR, `Asia/Kolkata`;
   - coming-soon off, shipping disabled, guest checkout on;
   - Cash on Delivery on, including for orders that need no shipping;
   - onboarding hidden; shop/cart/checkout/my-account pages present;
   - admin password synced from the Secret;
   - `mcp-bot` (shop_manager) and its REST API key from Secret `woo-store-api`. The key is upserted in place, so rotation is safe;
   - the 4 seed products created if their SKUs are missing;
   - a final check that HPOS is active, the store is public and COD is on.

Two steps must be explicit because a WP-CLI install never makes the first wp-admin visit. That
visit fires WooCommerce's "newly installed" hooks, which would otherwise turn on coming-soon mode
and HPOS.

## Network policies

Every pod of the release starts with no traffic in or out. These paths are then allowed:

| From | To | Port |
|---|---|---|
| Traefik (`kube-system`, `app.kubernetes.io/name=traefik`) | wordpress | 8080 |
| woo-mcp pods of this release | wordpress | 8080 |
| wordpress (incl. bootstrap), wp-cron | mariadb | 3306 |
| `platform` namespace **and** `app.kubernetes.io/component=gateway` | woo-mcp | 8080 |
| every pod of the release | kube-dns | 53 |

The rules have some limits:

- Kubelet probes come from the node and are always allowed.
- kube-router needs a few seconds before it applies policies to a brand-new pod. woo-mcp therefore also requires a bearer token.
- cert-manager's HTTP-01 solver pods (prod) carry none of this release's labels, so these policies do not restrict them.
- Nothing in the store may reach the internet. WordPress has `WP_HTTP_BLOCK_EXTERNAL` set, so outbound calls fail instantly instead of hanging wp-admin. Outgoing mail is off (`sendmail_path=/bin/false`) until an SMTP relay is added.

## Upgrades and rollback

```bash
helm history woo-store -n store
helm rollback woo-store <revision> -n store --wait
```

The stateless parts roll back freely: the woo-mcp image, the CronJob, resources and policies.

**The store image does not roll back freely.** A new WordPress or WooCommerce version migrates the
database on the next pod start (bootstrap step 4), and those migrations are forward-only. Rolling
the image back afterwards would run old code against a newer schema. So **back up before upgrading
the store image**:

```bash
kubectl -n store exec mariadb-0 -- sh -c \
  'MYSQL_PWD="$MARIADB_PASSWORD" mariadb-dump -u wordpress --single-transaction wordpress' > woo-store-$(date +%F).sql
# restore: kubectl -n store exec -i mariadb-0 -- sh -c 'MYSQL_PWD="$MARIADB_PASSWORD" mariadb -u wordpress wordpress' < file.sql
```

If an upgraded store misbehaves, restore the dump together with the old image. Do not just roll
back the image.

## Other operations

- **Rotating a Secret.** The chart does not see Secret contents. After changing one, run `kubectl -n store rollout restart deploy/wordpress deploy/woo-mcp`. The bootstrap then re-syncs the admin password and the API key.
- **Uninstalling.** `helm uninstall` keeps the data: the uploads PVC has `helm.sh/resource-policy: keep` and the MariaDB PVC is retained. Reinstalling the same release picks both up again. To really wipe the store, also run `kubectl -n store delete pvc wordpress-uploads data-mariadb-0`.
- **Readiness probe.** `/wp-login.php` loads WordPress and queries the DB, so the pod leaves the Service while the DB is down. Liveness is a TCP check, so a DB outage does not restart WordPress.
