# Urumi store image: the official WordPress image (Apache + mod_php) with WooCommerce, the Storefront
# theme and WP-CLI baked in.
#
# Design rules (see charts/woo-store/README.md):
#   * Code is immutable. WordPress core, plugins, themes and wp-config.php are copied in at BUILD time
#     and owned by root, so the web server (uid 33) can read but never modify them. The stock image
#     instead copies core into a volume and writes wp-config.php at container start; we skip that.
#   * Only wp-content/uploads is persistent (a PVC in Kubernetes) and writable, and Apache never runs
#     PHP from it (apache/000-default.conf).
#   * Runs as www-data (uid/gid 33). Apache listens on 8080 because a non-root process cannot bind :80.
#   * Every download is pinned to a version AND a checksum, so a rebuild gives the same bytes.
#
# Build (inside WSL):  docker build -t urumi/wordpress:dev images/wordpress
ARG WORDPRESS_IMAGE=wordpress:7.1.3-php8.3-apache

# ---------------------------------------------------------------------------------------------------
# Stage 1: assemble the docroot (downloads happen here, never at runtime).
# ---------------------------------------------------------------------------------------------------
FROM ${WORDPRESS_IMAGE} AS assemble

# wordpress.org does not publish checksums for plugin/theme zips, so these SHA-256 values were
# computed from the official downloads on 2026-10-13 (trust on first use). If the zip on the server
# ever changes, the build fails instead of silently shipping different code.
ARG WOOCOMMERCE_VERSION=11.2.1
ARG WOOCOMMERCE_SHA256=5317434cb381b5fdc7c1dd6ee258324f08c390976aaf8d1199f2a0e9a3ab8586
ARG STOREFRONT_VERSION=4.6.2
ARG STOREFRONT_SHA256=163b5bf217dad76a823432d8c01598ab3dc3f15cbdd69067b98f5a6ddf05c1c4
# WP-CLI publishes a .sha512 next to every release phar; this is the value from
# https://github.com/wp-cli/wp-cli/releases/download/v2.12.0/wp-cli-2.12.0.phar.sha512
ARG WP_CLI_VERSION=2.12.0
ARG WP_CLI_SHA512=be928f6b8ca1e8dfb9d2f4b75a13aa4aee0896f8a9a0a1c45cd5d2c98605e6172e6d014dda2e27f88c98befc16c040cbb2bd1bfa121510ea5cdf5f6a30fe8832

USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /build
RUN set -eux; \
    curl -fsSL -o woocommerce.zip "https://downloads.wordpress.org/plugin/woocommerce.${WOOCOMMERCE_VERSION}.zip"; \
    echo "${WOOCOMMERCE_SHA256}  woocommerce.zip" | sha256sum -c -; \
    curl -fsSL -o storefront.zip "https://downloads.wordpress.org/theme/storefront.${STOREFRONT_VERSION}.zip"; \
    echo "${STOREFRONT_SHA256}  storefront.zip" | sha256sum -c -; \
    curl -fsSL -o wp-cli.phar "https://github.com/wp-cli/wp-cli/releases/download/v${WP_CLI_VERSION}/wp-cli-${WP_CLI_VERSION}.phar"; \
    echo "${WP_CLI_SHA512}  wp-cli.phar" | sha512sum -c -; \
    \
    docroot=/usr/src/wordpress; \
    unzip -q woocommerce.zip -d "$docroot/wp-content/plugins/"; \
    unzip -q storefront.zip -d "$docroot/wp-content/themes/"; \
    # Drop bundled extras we never activate (less code = less attack surface). twentytwentyfive
    # stays as WordPress's default-theme fallback.
    rm -rf "$docroot/wp-content/plugins/akismet" "$docroot/wp-content/plugins/hello.php" \
           "$docroot/wp-content/themes/twentytwentythree" "$docroot/wp-content/themes/twentytwentyfour"; \
    # The image's wp-config-docker.php reads every setting from WORDPRESS_* env vars at runtime
    # (DB credentials, salts, WORDPRESS_CONFIG_EXTRA), so it can be the real wp-config.php.
    cp "$docroot/wp-config-docker.php" "$docroot/wp-config.php"; \
    # Ownership is the immutability guarantee: code belongs to root and is not writable by anyone
    # else, so the web server (uid 33) can read it but never change it. The only directory uid 33
    # owns is uploads, the mount point of the persistent volume.
    mkdir -p "$docroot/wp-content/uploads"; \
    chown -R root:root "$docroot"; \
    chmod -R go-w "$docroot"; \
    chown www-data:www-data "$docroot/wp-content/uploads"

# ---------------------------------------------------------------------------------------------------
# Stage 2: runtime image.
# ---------------------------------------------------------------------------------------------------
FROM ${WORDPRESS_IMAGE}

ARG WOOCOMMERCE_VERSION=11.2.1
ARG STOREFRONT_VERSION=4.6.2
ARG WP_CLI_VERSION=2.12.0
LABEL org.opencontainers.image.title="urumi-wordpress" \
      org.opencontainers.image.description="WordPress 7.1.3 + WooCommerce ${WOOCOMMERCE_VERSION} + Storefront ${STOREFRONT_VERSION} + WP-CLI ${WP_CLI_VERSION}, non-root Apache on :8080" \
      org.opencontainers.image.source="https://github.com/Galabavamsi/urumi-mcp-gateway"

# The docroot is /srv/wordpress, not the stock /var/www/html. The base image declares /var/www/html
# a VOLUME, and containerd (k3s) turns an image VOLUME into a read-write mount that it fills with a
# copy of the image's files on EVERY container start: 187 MB per start (every 5 minutes for wp-cron),
# writable, and outside readOnlyRootFilesystem. A Dockerfile cannot drop an inherited VOLUME, so we
# leave it empty: remove the base image's 1777 wp-content skeleton and make it root-owned 0755.
# (BuildKit, Docker's default builder, keeps RUN changes inside a declared VOLUME.)
RUN rm -rf /var/www/html/wp-content \
 && chown root:root /var/www/html \
 && chmod 0755 /var/www/html
# COPY --from keeps the ownership and modes set in the assemble stage.
COPY --from=assemble /usr/src/wordpress/ /srv/wordpress/

# WP-CLI phar plus a tiny wrapper that gives CLI runs more memory than web requests.
COPY --from=assemble /build/wp-cli.phar /usr/local/lib/wp-cli/wp-cli.phar
COPY bin/wp /usr/local/bin/wp

# Apache: listen on 8080, docroot /srv/wordpress (no PHP in uploads), small prefork pool, no
# keep-alive, quiet probe logging, no version banner.
COPY apache/ports.conf /etc/apache2/ports.conf
COPY apache/000-default.conf /etc/apache2/sites-available/000-default.conf
COPY apache/mpm_prefork.conf /etc/apache2/mods-available/mpm_prefork.conf
COPY apache/zz-urumi.conf /etc/apache2/conf-available/zz-urumi.conf

# PHP: start from the production php.ini, then our overrides (memory, upload size, opcache).
COPY php/zz-urumi.ini /usr/local/etc/php/conf.d/zz-urumi.ini

# Store bootstrap (run as an initContainer with this same image).
COPY bin/urumi-bootstrap.sh /usr/local/bin/urumi-bootstrap.sh
COPY lib/ /usr/local/lib/urumi/

RUN set -eux; \
    cp "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini"; \
    a2enconf zz-urumi; \
    chmod 0755 /usr/local/bin/wp /usr/local/bin/urumi-bootstrap.sh; \
    chmod 0644 /usr/local/lib/wp-cli/wp-cli.phar /usr/local/lib/urumi/*; \
    # Fail the build, not the pod, on a broken Apache config.
    apache2ctl -t; \
    # Sanity check that the phar runs (the build runs as root, hence --allow-root just here).
    wp --allow-root --path=/srv/wordpress --version

# Numeric user so Kubernetes' runAsNonRoot check can verify it without resolving a name.
USER 33:33
# WP-CLI finds WordPress from the working directory: the bootstrap and wp-cron call `wp` without --path.
WORKDIR /srv/wordpress
EXPOSE 8080

# Bypass the stock docker-entrypoint.sh: its only jobs (copy core into the volume, generate
# wp-config.php) were done at build time, so the container starts Apache directly.
ENTRYPOINT []
CMD ["apache2-foreground"]
