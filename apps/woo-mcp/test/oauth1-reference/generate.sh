#!/usr/bin/env bash
# Regenerates apps/woo-mcp/src/woo/oauth1.vectors.json: OAuth 1.0a signatures computed and verified by
# WooCommerce's own PHP code (see reference.php). Run it where Docker is (on this project: inside WSL):
#   bash apps/woo-mcp/test/oauth1-reference/generate.sh
# Only needed again when WooCommerce changes its REST authentication or we change the vectors.
set -euo pipefail

WP_IMAGE="wordpress:7.1.3-php8.3-apache" # same WordPress/PHP the store image is built from
WC_TAG="11.2.0"                            # WooCommerce release whose authentication code we check against

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$here/../../src/woo/oauth1.vectors.json"
wc_dir="$(mktemp -d)"
trap 'rm -rf "$wc_dir"' EXIT

# Just the two WooCommerce files on the signing path, from the tagged release.
for file in class-wc-rest-authentication.php wc-rest-functions.php; do
  curl -fsSL "https://raw.githubusercontent.com/woocommerce/woocommerce/${WC_TAG}/plugins/woocommerce/includes/${file}" \
    -o "$wc_dir/$file"
done
chmod 755 "$wc_dir" # mktemp makes it 0700; the container reads it as www-data (uid 33)

# --network none: the PHP side needs nothing from the network; inputs are mounted read-only.
docker run --rm --network none --user 33:33 -e WC_TAG="$WC_TAG" \
  -v "$here:/work:ro" -v "$wc_dir:/wc:ro" \
  "$WP_IMAGE" php /work/reference.php >"$out.tmp"
mv "$out.tmp" "$out"
echo "wrote $out (WordPress image $WP_IMAGE, WooCommerce $WC_TAG)"
