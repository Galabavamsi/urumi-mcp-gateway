#!/usr/bin/env bash
# Idempotent store bootstrap. Runs as an initContainer (same image as the web container) on EVERY
# pod start, before Apache. On an empty database it builds a fully configured store; on an existing
# one it only corrects what drifted from the desired state, so a re-run is a no-op. Each step logs
# one line. No code is downloaded or written: plugins and themes are already in the image, these
# steps only change database state.
#
# Desired state comes from env vars rendered by the Helm chart (charts/woo-store):
#   WORDPRESS_DB_*                          DB connection (the same vars wp-config.php reads)
#   WP_HOME                                 public store URL
#   WP_ADMIN_USER, WP_ADMIN_EMAIL, WP_ADMIN_PASSWORD
#   WOO_CONSUMER_KEY, WOO_CONSUMER_SECRET   REST API key of the mcp-bot user
#   STORE_*                                 name, address, currency, timezone, seed products
set -Eeuo pipefail

LIB=/usr/local/lib/urumi
started=$(date +%s)

log() { printf '[bootstrap] %s\n' "$*"; }
trap 'log "FAILED at line $LINENO"' ERR

# Runs a WP-CLI command and logs only its final "Success: ..." line; on failure prints everything
# and stops the bootstrap.
wp_logged() {
  local label=$1 out
  shift
  out=$(wp "$@" 2>&1) || { printf '%s\n' "$out" >&2; return 1; }
  out=${out##*$'\n'}
  log "$label: ${out#Success: }"
}

: "${WP_HOME:?}" "${STORE_NAME:?}" "${WP_ADMIN_USER:?}" "${WP_ADMIN_EMAIL:?}" "${WP_ADMIN_PASSWORD:?}"

# 1. Wait until the WordPress DB user can log in (MariaDB may still be initialising).
php "$LIB/wait-for-db.php"

# 2. WordPress core tables and the admin user, only on an empty database.
if wp core is-installed; then
  log "wordpress: already installed"
else
  # No --admin_password on purpose: WP-CLI then generates a random throwaway one (and --quiet hides
  # the line that would print it). Step 6 sets the real password from the Secret, so the secret
  # never appears in a process list (argv) or in a log.
  wp core install --quiet --skip-email \
    --url="$WP_HOME" --title="$STORE_NAME" \
    --admin_user="$WP_ADMIN_USER" --admin_email="$WP_ADMIN_EMAIL"
  log "wordpress: installed at $WP_HOME (admin user '$WP_ADMIN_USER')"
fi

# 3. Plugin and theme: the code is in the image already; this only switches them on in the DB.
#    Activating WooCommerce runs its installer (tables, default options, shop/cart/checkout pages).
if wp plugin is-active woocommerce; then
  log "plugin woocommerce: already active"
else
  wp plugin activate woocommerce --quiet
  log "plugin woocommerce: activated"
fi

if wp theme is-active storefront; then
  log "theme storefront: already active"
else
  wp theme activate storefront --quiet
  log "theme storefront: activated"
fi

# 4. Database migrations after an image upgrade: WordPress core first, then WooCommerce. Both are
#    no-ops when the schema already matches the code in the image. They are forward-only, which is
#    why the chart README says to back up the database before upgrading the store image.
wp_logged "core database" core update-db
wp_logged "woocommerce database" wc update

# 5. HPOS (orders in WooCommerce's own tables). New shops normally get it from a hook that fires on
#    the first wp-admin visit, which a WP-CLI install never makes, so use WooCommerce's CLI command.
if [ "$(wp option get woocommerce_custom_orders_table_enabled 2>/dev/null || true)" = yes ]; then
  log "HPOS: already enabled"
else
  wp wc hpos enable --quiet
  log "HPOS: enabled"
fi

# 6. Everything else in a single WordPress load: store settings, checkout, pages, users, API key,
#    seed products, and a final verification that fails the pod if the store is not usable.
wp eval-file "$LIB/configure-store.php"

log "done in $(( $(date +%s) - started ))s"
