<?php
/**
 * Bootstrap step 6: store configuration, run as `wp eval-file configure-store.php`.
 *
 * Everything here happens inside ONE WordPress + WooCommerce load, which is much faster than one
 * `wp` process per setting. Each step compares the desired state (env vars rendered by the Helm
 * chart) with the database and writes only the difference, so re-running is a no-op. Each step
 * prints exactly one log line.
 */

use Automattic\WooCommerce\Utilities\OrderUtil;

if ( ! defined( 'WP_CLI' ) || ! class_exists( 'WooCommerce' ) ) {
	fwrite( STDERR, "configure-store.php must run via `wp eval-file` with WooCommerce active\n" );
	exit( 1 );
}

// Identifies the API key row this script owns, so rotation replaces it and never touches keys
// that a human created in wp-admin.
const URUMI_API_KEY_DESCRIPTION = 'woo-mcp (managed by urumi-bootstrap from Secret woo-store-api)';
const URUMI_BOT_LOGIN           = 'mcp-bot';
const URUMI_BOT_ROLE            = 'urumi_mcp_bot';

/**
 * Exactly what woo-mcp's six tools need, and nothing else. (shop_manager, the obvious choice, can also
 * delete orders and products, change WooCommerce and payment settings, run system-status tools and
 * list/create/edit customers: the REST API key would carry all of that.)
 *   list_products, get_product   read_private_products (drafts and private products too)
 *   create_product               publish_products (WooCommerce's REST "create" check) + edit_products
 *   list_orders, get_order       read_private_shop_orders
 *   update_order_status          edit_shop_order, which under HPOS needs edit_others_shop_orders plus
 *                                edit_published_ or edit_private_shop_orders depending on the status
 *   order note                   publish_shop_orders (the REST "create" check for notes)
 */
const URUMI_BOT_CAPS = array(
	'read',
	'read_private_products',
	'edit_products',
	'edit_others_products',
	'edit_published_products',
	'publish_products',
	'read_private_shop_orders',
	'edit_shop_orders',
	'edit_others_shop_orders',
	'edit_published_shop_orders',
	'edit_private_shop_orders',
	'publish_shop_orders',
);

/** Capabilities the bot must never have; urumi_verify() fails the pod if it does. */
const URUMI_BOT_FORBIDDEN_CAPS = array( 'manage_woocommerce', 'list_users', 'edit_users', 'create_customers', 'delete_shop_orders', 'delete_products' );

function urumi_log( string $step, string $message ): void {
	WP_CLI::log( sprintf( '[bootstrap] %s: %s', $step, $message ) );
}

function urumi_env( string $name, ?string $default = null ): string {
	$value = getenv( $name );
	if ( false === $value || '' === $value ) {
		if ( null === $default ) {
			WP_CLI::error( "missing required env var {$name}" );
		}
		return $default;
	}
	return $value;
}

/**
 * Sets each option to its desired value. update_option() itself skips unchanged values and returns
 * true only when it wrote something, which is exactly the "what changed" list we want to log.
 */
function urumi_ensure_options( string $step, array $desired ): void {
	$changed = array();
	foreach ( $desired as $name => $value ) {
		if ( update_option( $name, $value ) ) {
			$changed[] = $name;
		}
	}
	urumi_log( $step, $changed ? 'updated ' . implode( ', ', $changed ) : 'unchanged' );
}

/**
 * home/siteurl rows in the database. At runtime the WP_HOME/WP_SITEURL constants (wp-config) win
 * and get_option() returns them, so read and write the stored rows directly. Keeping them in sync
 * means a database dump restored elsewhere does not point at a stale host.
 */
function urumi_ensure_site_url( string $url ): void {
	global $wpdb;
	$changed = array();
	foreach ( array( 'home', 'siteurl' ) as $name ) {
		$stored = $wpdb->get_var( $wpdb->prepare( "SELECT option_value FROM {$wpdb->options} WHERE option_name = %s", $name ) );
		if ( $stored !== $url ) {
			$wpdb->update( $wpdb->options, array( 'option_value' => $url ), array( 'option_name' => $name ) );
			$changed[] = $name;
		}
	}
	wp_cache_delete( 'alloptions', 'options' );
	urumi_log( 'site url', ( $changed ? 'updated ' . implode( ', ', $changed ) . ' to ' : 'unchanged ' ) . $url );
}

function urumi_ensure_permalinks(): void {
	$structure = '/%postname%/';
	if ( get_option( 'permalink_structure' ) === $structure ) {
		urumi_log( 'permalinks', "unchanged {$structure}" );
		return;
	}
	global $wp_rewrite;
	$wp_rewrite->set_permalink_structure( $structure );
	// Soft flush: regenerate the rules stored in the database only. The .htaccess that routes every
	// request to index.php is already baked into the (read-only) image.
	flush_rewrite_rules( false );
	urumi_log( 'permalinks', "set to {$structure}" );
}

function urumi_ensure_cod(): void {
	$gateways = WC()->payment_gateways()->payment_gateways();
	if ( ! isset( $gateways['cod'] ) ) {
		WP_CLI::error( 'Cash on Delivery gateway not registered' );
	}
	$cod     = $gateways['cod'];
	$changed = array();
	// enable_for_virtual matters because shipping is disabled: an order that needs no shipping counts
	// as "virtual" to the COD gateway, which then hides itself unless this is "yes".
	foreach ( array( 'enabled' => 'yes', 'enable_for_virtual' => 'yes' ) as $key => $value ) {
		if ( $cod->get_option( $key ) !== $value ) {
			$cod->update_option( $key, $value );
			$changed[] = $key;
		}
	}
	urumi_log( 'cash on delivery', $changed ? 'updated ' . implode( ', ', $changed ) : 'unchanged (enabled)' );
}

/**
 * Hide the onboarding wizard and setup task list: the store is configured by this script, and its
 * suggestions would call woocommerce.com, which this pod cannot reach anyway.
 */
function urumi_skip_onboarding(): void {
	$profile = get_option( 'woocommerce_onboarding_profile', array() );
	$profile = is_array( $profile ) ? $profile : array();
	if ( empty( $profile['skipped'] ) && empty( $profile['completed'] ) ) {
		$profile['skipped'] = true;
	}
	$hidden = (array) get_option( 'woocommerce_task_list_hidden_lists', array() );
	urumi_ensure_options(
		'onboarding',
		array(
			'woocommerce_onboarding_profile'           => $profile,
			'woocommerce_task_list_hidden_lists'       => array_values( array_unique( array_merge( $hidden, array( 'setup', 'extended' ) ) ) ),
			'woocommerce_show_marketplace_suggestions' => 'no',
			'woocommerce_allow_tracking'               => 'no',
		)
	);
}

/** Shop, cart, checkout and my-account pages: WooCommerce creates them on install; recreate if deleted. */
function urumi_ensure_pages(): void {
	$keys    = array( 'shop', 'cart', 'checkout', 'myaccount' );
	$missing = array_filter( $keys, fn( $key ) => 'publish' !== get_post_status( wc_get_page_id( $key ) ) );
	if ( $missing ) {
		WC_Install::create_pages(); // Creates only the pages whose option/post is missing.
	}
	$ids = array();
	foreach ( $keys as $key ) {
		$id = wc_get_page_id( $key );
		if ( 'publish' !== get_post_status( $id ) ) {
			WP_CLI::error( "WooCommerce page '{$key}' is missing and could not be created" );
		}
		$ids[] = "{$key}=#{$id}";
	}
	$checkout = has_block( 'woocommerce/checkout', wc_get_page_id( 'checkout' ) ) ? 'checkout block' : 'classic checkout';
	urumi_log( 'pages', ( $missing ? 'created ' . implode( ', ', $missing ) . '; ' : '' ) . implode( ' ', $ids ) . " ({$checkout})" );
}

/** The Secret is the source of truth for the admin password, so rotating it there rotates it here. */
function urumi_ensure_admin_password(): void {
	$login    = urumi_env( 'WP_ADMIN_USER', 'admin' );
	$password = urumi_env( 'WP_ADMIN_PASSWORD' );
	$admin    = get_user_by( 'login', $login );
	if ( ! $admin ) {
		WP_CLI::error( "admin user '{$login}' not found" );
	}
	if ( wp_check_password( $password, $admin->user_pass, $admin->ID ) ) {
		urumi_log( 'admin user', "'{$login}' password matches Secret" );
		return;
	}
	wp_set_password( $password, $admin->ID );
	urumi_log( 'admin user', "'{$login}' password updated from Secret" );
}

/** Creates the bot role, or brings its capabilities back to exactly URUMI_BOT_CAPS. */
function urumi_ensure_bot_role(): void {
	$role = get_role( URUMI_BOT_ROLE );
	if ( ! $role ) {
		add_role( URUMI_BOT_ROLE, 'MCP bot (woo-mcp)', array_fill_keys( URUMI_BOT_CAPS, true ) );
		urumi_log( 'mcp-bot role', 'created ' . URUMI_BOT_ROLE . ' with ' . count( URUMI_BOT_CAPS ) . ' capabilities' );
		return;
	}
	$added   = array_diff( URUMI_BOT_CAPS, array_keys( array_filter( $role->capabilities ) ) );
	$removed = array_diff( array_keys( $role->capabilities ), URUMI_BOT_CAPS );
	foreach ( $added as $cap ) {
		$role->add_cap( $cap );
	}
	foreach ( $removed as $cap ) {
		$role->remove_cap( $cap );
	}
	$changes = array_merge( array_map( fn( $cap ) => "+{$cap}", $added ), array_map( fn( $cap ) => "-{$cap}", $removed ) );
	urumi_log( 'mcp-bot role', $changes ? 'updated ' . implode( ' ', $changes ) : 'unchanged (' . count( URUMI_BOT_CAPS ) . ' capabilities)' );
}

/**
 * The bot user that woo-mcp acts as, with the role above: products and orders only, no deletes, no
 * customers, no settings. Its password is random and never used: it only ever authenticates with
 * the REST API key below.
 */
function urumi_ensure_bot_user(): int {
	$bot = get_user_by( 'login', URUMI_BOT_LOGIN );
	if ( ! $bot ) {
		$id = wp_insert_user(
			array(
				'user_login'   => URUMI_BOT_LOGIN,
				'user_pass'    => wp_generate_password( 64, true, true ),
				'user_email'   => 'mcp-bot@store.invalid',
				'display_name' => 'MCP bot (woo-mcp)',
				'role'         => URUMI_BOT_ROLE,
			)
		);
		if ( is_wp_error( $id ) ) {
			WP_CLI::error( 'could not create mcp-bot: ' . $id->get_error_message() );
		}
		urumi_log( 'mcp-bot user', "created #{$id} with role " . URUMI_BOT_ROLE );
		return $id;
	}
	// Also migrates stores whose bot was created as shop_manager by an earlier version of this script.
	if ( array( URUMI_BOT_ROLE ) !== array_values( $bot->roles ) ) {
		$bot->set_role( URUMI_BOT_ROLE );
		urumi_log( 'mcp-bot user', "#{$bot->ID} role reset to " . URUMI_BOT_ROLE );
	} else {
		urumi_log( 'mcp-bot user', "#{$bot->ID} unchanged (" . URUMI_BOT_ROLE . ')' );
	}
	return $bot->ID;
}

/**
 * Upserts the woo-mcp REST API key from the Secret, in the same format WooCommerce's own
 * "Add key" screen writes:
 *   consumer_key    = wc_api_hash( ck ) = HMAC-SHA256( ck, 'wc-api' ); only the hash is stored
 *   consumer_secret = cs in plaintext; it is the HMAC key that OAuth 1.0a signatures are checked with
 *   truncated_key   = last 7 chars of ck, so a human can recognise the key in wp-admin
 * Exactly one managed row exists afterwards. Rotation (new Secret values) updates that row in
 * place, so the old key stops working the moment the new one starts.
 */
function urumi_ensure_api_key( int $user_id ): void {
	global $wpdb;
	$ck = urumi_env( 'WOO_CONSUMER_KEY' );
	$cs = urumi_env( 'WOO_CONSUMER_SECRET' );
	if ( ! preg_match( '/^ck_[0-9a-f]{40}$/', $ck ) || ! preg_match( '/^cs_[0-9a-f]{40}$/', $cs ) ) {
		WP_CLI::error( 'WOO_CONSUMER_KEY/WOO_CONSUMER_SECRET must be ck_/cs_ followed by 40 hex characters' );
	}

	$table   = $wpdb->prefix . 'woocommerce_api_keys';
	$desired = array(
		'user_id'         => (string) $user_id,
		'description'     => URUMI_API_KEY_DESCRIPTION,
		'permissions'     => 'read_write',
		'consumer_key'    => wc_api_hash( $ck ),
		'consumer_secret' => $cs,
		'truncated_key'   => substr( $ck, -7 ),
	);
	$managed = $wpdb->get_results(
		$wpdb->prepare(
			"SELECT key_id, user_id, description, permissions, consumer_key, consumer_secret, truncated_key FROM {$table} WHERE description = %s ORDER BY key_id",
			URUMI_API_KEY_DESCRIPTION
		),
		ARRAY_A
	);

	if ( ! $managed ) {
		$wpdb->insert( $table, $desired );
		urumi_log( 'api key', "created read_write key ...{$desired['truncated_key']} for user #{$user_id}" );
		return;
	}

	$row = array_shift( $managed );
	// More than one managed row can only come from manual edits; keep exactly one valid key.
	foreach ( $managed as $extra ) {
		$wpdb->delete( $table, array( 'key_id' => $extra['key_id'] ) );
	}
	$key_id = $row['key_id'];
	unset( $row['key_id'] );
	if ( $row === $desired ) {
		urumi_log( 'api key', "unchanged ...{$desired['truncated_key']}" . ( $managed ? ' (removed ' . count( $managed ) . ' duplicate rows)' : '' ) );
		return;
	}
	// New key material: also clear the used-nonce list that belonged to the old key.
	$wpdb->update( $table, $desired + array( 'nonces' => null ), array( 'key_id' => $key_id ) );
	urumi_log( 'api key', "rotated key #{$key_id} to ...{$desired['truncated_key']}" );
}

// --- The shop's own content: catalog, photos, pages, menu --------------------------------------------
// Seeded from images/wordpress/seed (baked into the image, read-only): catalog.json, the photos in
// images/ (credits in CREDITS.md) and the page templates. Every item is applied ONCE in the store's
// life and remembered in an option (autoload off: only the bootstrap reads them, and each is saved
// right after its item, so a crash part-way never duplicates anything). After that the item belongs to
// the merchant: one they edit is never overwritten, one they delete is never brought back. A new item
// in a later image's catalog is still applied once. Orders are never read or written here.

const URUMI_SEED_DIR = '/usr/local/share/urumi/seed';

function urumi_catalog(): array {
	$file    = URUMI_SEED_DIR . '/catalog.json';
	$catalog = is_readable( $file ) ? json_decode( (string) file_get_contents( $file ), true ) : null;
	if ( ! is_array( $catalog ) || empty( $catalog['products'] ) || empty( $catalog['categories'] ) || empty( $catalog['hero']['image'] ) ) {
		WP_CLI::error( "{$file} is missing or is not a valid catalog" );
	}
	return $catalog;
}

/** Adds one value to a list option (autoload off), saving at once. */
function urumi_remember( string $option, string $value ): void {
	$list = (array) get_option( $option, array() );
	if ( ! in_array( $value, $list, true ) ) {
		$list[] = $value;
		update_option( $option, $list, false );
	}
}

/**
 * Imports one seed photo into the media library, once (option urumi_seed_media: file => attachment ID).
 * Returns the attachment ID, or 0 if the photo was imported before and has since been deleted.
 * $meta maps file => title and alt text; $imported collects what this run imported, for the log.
 */
function urumi_seed_photo( string $file, array $meta, array &$imported ): int {
	$media = (array) get_option( 'urumi_seed_media', array() );
	if ( isset( $media[ $file ] ) ) {
		return 'attachment' === get_post_type( (int) $media[ $file ] ) ? (int) $media[ $file ] : 0;
	}
	require_once ABSPATH . 'wp-admin/includes/file.php';
	require_once ABSPATH . 'wp-admin/includes/media.php';
	require_once ABSPATH . 'wp-admin/includes/image.php';
	// media_handle_sideload() moves its input into uploads (and makes the thumbnails), so hand it a copy:
	// the seed directory is part of the read-only image.
	$tmp = wp_tempnam( $file );
	if ( ! copy( URUMI_SEED_DIR . '/images/' . $file, $tmp ) ) {
		WP_CLI::error( "could not read seed photo {$file}" );
	}
	$id = media_handle_sideload( array( 'name' => $file, 'tmp_name' => $tmp ), 0, null, array( 'post_title' => $meta[ $file ]['title'] ?? $file ) );
	if ( is_wp_error( $id ) ) {
		wp_delete_file( $tmp );
		WP_CLI::error( "could not import seed photo {$file}: " . $id->get_error_message() );
	}
	update_post_meta( $id, '_wp_attachment_image_alt', $meta[ $file ]['alt'] ?? '' );
	$media[ $file ] = $id;
	update_option( 'urumi_seed_media', $media, false );
	$imported[] = $file;
	return $id;
}

/**
 * Product categories, each created once (option urumi_seeded_categories), with its photo and its place
 * in the catalog order (the homepage's "Shop by Category"). A category the merchant already made with
 * the same slug is used as it is. Returns slug => term ID for the categories that exist.
 */
function urumi_seed_categories( array $categories, array $meta, array &$imported ): array {
	$seeded  = (array) get_option( 'urumi_seeded_categories', array() );
	$ids     = array();
	$created = array();
	foreach ( $categories as $position => $category ) {
		$term = get_term_by( 'slug', $category['slug'], 'product_cat' );
		if ( $term ) {
			$ids[ $category['slug'] ] = (int) $term->term_id;
		} elseif ( ! in_array( $category['slug'], $seeded, true ) ) {
			$result = wp_insert_term( $category['name'], 'product_cat', array( 'slug' => $category['slug'], 'description' => $category['description'] ) );
			if ( is_wp_error( $result ) ) {
				WP_CLI::error( "could not create category {$category['slug']}: " . $result->get_error_message() );
			}
			$term_id = (int) $result['term_id'];
			update_term_meta( $term_id, 'order', $position + 1 ); // WooCommerce's own sort key for categories
			$photo = urumi_seed_photo( $category['image'], $meta, $imported );
			if ( $photo ) {
				update_term_meta( $term_id, 'thumbnail_id', $photo );
			}
			$ids[ $category['slug'] ] = $term_id;
			$created[]                = $category['slug'];
		}
		urumi_remember( 'urumi_seeded_categories', $category['slug'] );
	}
	urumi_log( 'catalog categories', ( $created ? 'created ' . implode( ', ', $created ) : 'none created' ) . '; ' . count( $ids ) . ' of ' . count( $categories ) . ' present' );
	return $ids;
}

/** True if the product is still exactly what an earlier bootstrap seeded (one of the original four). */
function urumi_is_untouched_seed( WC_Product $product, array $entry ): bool {
	return isset( $entry['original']['short_description'] )
		&& $product->get_name() === $entry['name']
		&& $product->get_regular_price() === (string) $entry['regular_price']
		&& $product->get_short_description() === $entry['original']['short_description']
		&& '' === $product->get_description()
		&& 0 === (int) $product->get_image_id();
}

/** Writes one catalog entry into a product (new, or one of the untouched original four) and saves it. */
function urumi_apply_catalog_entry( WC_Product_Simple $product, array $entry, array $category_ids, array $meta, array &$imported ): void {
	$product->set_name( $entry['name'] );
	$product->set_sku( $entry['sku'] );
	$product->set_regular_price( (string) $entry['regular_price'] ); // WooCommerce stores prices as strings.
	$product->set_sale_price( isset( $entry['sale_price'] ) ? (string) $entry['sale_price'] : '' );
	$product->set_short_description( $entry['short_description'] );
	$product->set_description( $entry['description'] );
	if ( isset( $category_ids[ $entry['category'] ] ) ) {
		$product->set_category_ids( array( $category_ids[ $entry['category'] ] ) );
	}
	$product->set_weight( (string) ( $entry['weight'] ?? '' ) );
	$product->set_featured( ! empty( $entry['featured'] ) );
	if ( isset( $entry['stock'] ) ) {
		// Saving with stock management on and 0 left marks the product out of stock.
		$product->set_manage_stock( true );
		$product->set_stock_quantity( (int) $entry['stock'] );
	}
	if ( ! empty( $entry['listed'] ) ) {
		$product->set_date_created( $entry['listed'] . 'T10:00:00+05:30' ); // "New In" sorts by this date
	}
	$photo = urumi_seed_photo( $entry['image'], $meta, $imported );
	if ( $photo ) {
		$product->set_image_id( $photo );
	}
	$product->set_status( 'publish' );
	$product->save();
	if ( $photo && 0 === (int) get_post_field( 'post_parent', $photo ) ) {
		wp_update_post( array( 'ID' => $photo, 'post_parent' => $product->get_id() ) ); // "Uploaded to" in the media library
	}
}

/**
 * The catalog's products. Each SKU is applied once (option urumi_catalog_skus):
 *  - no product has the SKU: created, unless it was seeded before and the merchant has since trashed the
 *    product or changed its SKU (option urumi_seeded_skus, kept from the earlier four-product seeding);
 *  - one of the four products earlier versions seeded, still exactly as seeded: completed with its
 *    photo, category, descriptions, weight and listing date (its name, SKU and price do not change);
 *  - any other product with the SKU belongs to the merchant and is left alone.
 */
function urumi_seed_catalog_products( array $products, array $category_ids, array $meta, array &$imported ): void {
	$applied   = (array) get_option( 'urumi_catalog_skus', array() );
	$seeded    = (array) get_option( 'urumi_seeded_skus', array() );
	$created   = array();
	$completed = array();
	$left      = array();
	foreach ( $products as $entry ) {
		$sku = $entry['sku'];
		if ( in_array( $sku, $applied, true ) ) {
			continue;
		}
		$id = wc_get_product_id_by_sku( $sku );
		if ( $id ) {
			$product = wc_get_product( $id );
			if ( $product instanceof WC_Product_Simple && urumi_is_untouched_seed( $product, $entry ) ) {
				urumi_apply_catalog_entry( $product, $entry, $category_ids, $meta, $imported );
				$completed[] = $sku;
			} else {
				$left[] = $sku;
			}
		} elseif ( in_array( $sku, $seeded, true ) ) {
			$left[] = "{$sku} (removed by the merchant)";
		} else {
			urumi_apply_catalog_entry( new WC_Product_Simple(), $entry, $category_ids, $meta, $imported );
			$created[] = $sku;
		}
		urumi_remember( 'urumi_seeded_skus', $sku );
		urumi_remember( 'urumi_catalog_skus', $sku );
	}
	$parts = array();
	foreach ( array( 'created' => $created, 'completed' => $completed, 'left as they are' => $left ) as $verb => $skus ) {
		if ( $skus ) {
			$parts[] = "{$verb} " . count( $skus ) . ' (' . implode( ', ', $skus ) . ')';
		}
	}
	urumi_log( 'catalog products', $parts ? implode( '; ', $parts ) : 'unchanged (all ' . count( $products ) . ' applied before)' );
}

/**
 * The Home and About pages, each created once (option urumi_seed_pages: key => page ID, 0 when a page
 * with that address already existed and was left alone). Home becomes the front page when it is
 * created; after that the reading settings are the merchant's. Returns key => page ID.
 */
function urumi_seed_pages( array $pages, array $vars ): array {
	$done    = (array) get_option( 'urumi_seed_pages', array() );
	$created = array();
	foreach ( $pages as $page ) {
		$key = $page['key'];
		if ( array_key_exists( $key, $done ) ) {
			continue;
		}
		if ( get_page_by_path( $page['slug'] ) ) {
			$done[ $key ] = 0;
		} else {
			$id = wp_insert_post(
				array(
					'post_type'      => 'page',
					'post_status'    => 'publish',
					'post_title'     => $page['title'],
					'post_name'      => $page['slug'],
					'post_content'   => strtr( (string) file_get_contents( URUMI_SEED_DIR . '/' . $page['file'] ), $vars ),
					'comment_status' => 'closed',
					'ping_status'    => 'closed',
				),
				true
			);
			if ( is_wp_error( $id ) ) {
				WP_CLI::error( "could not create page {$key}: " . $id->get_error_message() );
			}
			if ( ! empty( $page['template'] ) ) {
				update_post_meta( $id, '_wp_page_template', $page['template'] );
			}
			if ( 'home' === $key ) {
				update_option( 'show_on_front', 'page' );
				update_option( 'page_on_front', $id );
			}
			$done[ $key ] = $id;
			$created[]    = "{$key} #{$id}" . ( 'home' === $key ? ' (front page)' : '' );
		}
		update_option( 'urumi_seed_pages', $done, false );
	}
	urumi_log( 'pages', $created ? 'created ' . implode( ', ', $created ) : 'unchanged (' . count( $done ) . ' seeded before)' );
	return $done;
}

/**
 * The main menu, created once (option urumi_seed_menu): Shop with the categories under it, then About
 * us. It goes into Storefront's primary and handheld (mobile) locations, unless those are already set.
 */
function urumi_seed_menu( array $categories, array $category_ids, array $page_ids ): void {
	if ( false !== get_option( 'urumi_seed_menu' ) ) {
		urumi_log( 'menu', 'unchanged (created before)' );
		return;
	}
	if ( wp_get_nav_menu_object( 'Main menu' ) ) {
		update_option( 'urumi_seed_menu', 0, false );
		urumi_log( 'menu', 'a menu called "Main menu" already exists: left as it is' );
		return;
	}
	$menu_id = wp_create_nav_menu( 'Main menu' );
	if ( is_wp_error( $menu_id ) ) {
		WP_CLI::error( 'could not create the menu: ' . $menu_id->get_error_message() );
	}
	$add  = static fn( array $item ) => wp_update_nav_menu_item( $menu_id, 0, $item + array( 'menu-item-status' => 'publish' ) );
	$shop = $add( array( 'menu-item-title' => 'Shop', 'menu-item-type' => 'post_type', 'menu-item-object' => 'page', 'menu-item-object-id' => wc_get_page_id( 'shop' ) ) );
	foreach ( $categories as $category ) {
		if ( isset( $category_ids[ $category['slug'] ] ) ) {
			$add( array( 'menu-item-title' => $category['name'], 'menu-item-type' => 'taxonomy', 'menu-item-object' => 'product_cat', 'menu-item-object-id' => $category_ids[ $category['slug'] ], 'menu-item-parent-id' => $shop ) );
		}
	}
	if ( ! empty( $page_ids['about'] ) ) {
		$add( array( 'menu-item-title' => 'About us', 'menu-item-type' => 'post_type', 'menu-item-object' => 'page', 'menu-item-object-id' => $page_ids['about'] ) );
	}
	$locations = (array) get_theme_mod( 'nav_menu_locations', array() );
	$placed    = array();
	foreach ( array( 'primary', 'handheld' ) as $location ) {
		if ( empty( $locations[ $location ] ) ) {
			$locations[ $location ] = $menu_id;
			$placed[]               = $location;
		}
	}
	set_theme_mod( 'nav_menu_locations', $locations );
	update_option( 'urumi_seed_menu', $menu_id, false );
	urumi_log( 'menu', "created #{$menu_id}" . ( $placed ? ' in ' . implode( ' and ', $placed ) : ' (locations already set: not placed)' ) );
}

/**
 * WordPress's sample content ("Hello world!" with its sample comment, and "Sample Page") is deleted once,
 * and only if it was never edited (modified date still equal to the creation date).
 */
function urumi_remove_sample_content(): void {
	if ( get_option( 'urumi_sample_content_checked' ) ) {
		urumi_log( 'sample content', 'unchanged (checked before)' );
		return;
	}
	$removed = array();
	foreach ( array( 'post' => 'hello-world', 'page' => 'sample-page' ) as $type => $slug ) {
		$found = get_posts( array( 'post_type' => $type, 'name' => $slug, 'post_status' => 'any', 'numberposts' => 1 ) );
		$post  = $found[0] ?? null;
		if ( $post && $post->post_modified_gmt === $post->post_date_gmt ) {
			wp_delete_post( $post->ID, true ); // also deletes the post's comments
			$removed[] = "{$type} \"{$post->post_title}\"";
		}
	}
	update_option( 'urumi_sample_content_checked', 1, false );
	urumi_log( 'sample content', $removed ? 'removed ' . implode( ', ', $removed ) : 'none left as installed' );
}

/**
 * Bank transfer next to Cash on Delivery, and the shop grid layout: set once (option urumi_shop_setup),
 * after which the merchant may change them. COD stays the first payment method. No account numbers are
 * published: the instructions say the shop emails them.
 */
function urumi_setup_shop_once(): void {
	if ( get_option( 'urumi_shop_setup' ) ) {
		urumi_log( 'bank transfer, shop grid', 'unchanged (set up before)' );
		return;
	}
	$bacs = WC()->payment_gateways()->payment_gateways()['bacs'] ?? null;
	if ( ! $bacs ) {
		WP_CLI::error( 'Direct bank transfer gateway not registered' );
	}
	$settings = array(
		'enabled'      => 'yes',
		'title'        => 'Direct bank transfer',
		'description'  => 'Pay by NEFT, IMPS or UPI. We email you our account details after you place the order and pack it as soon as the payment arrives.',
		'instructions' => 'Thank you for your order. We are emailing you our account details; please use your order number as the payment reference. We pack your order as soon as the payment arrives.',
	);
	foreach ( $settings as $key => $value ) {
		$bacs->update_option( $key, $value );
	}
	update_option( 'woocommerce_gateway_order', array( 'cod' => 0, 'bacs' => 1 ) );
	// Product grid: 4 per row, 4 rows per page (Storefront's default is 3 by 4).
	update_option( 'woocommerce_catalog_columns', 4 );
	update_option( 'woocommerce_catalog_rows', 4 );
	update_option( 'urumi_shop_setup', 1, false );
	urumi_log( 'bank transfer, shop grid', 'bank transfer enabled after Cash on Delivery; shop grid 4 x 4' );
}

function urumi_seed_storefront(): void {
	$catalog = urumi_catalog();
	// Seeded posts, pages and photos belong to the store admin. Also lifts the HTML filter for the page
	// templates (wp_set_current_user re-runs kses_init for the new user).
	$admin = get_user_by( 'login', urumi_env( 'WP_ADMIN_USER', 'admin' ) );
	if ( $admin ) {
		wp_set_current_user( $admin->ID );
	}
	$meta = array( $catalog['hero']['image'] => array( 'title' => 'Homepage banner', 'alt' => $catalog['hero']['image_alt'] ?? '' ) );
	foreach ( $catalog['products'] as $entry ) {
		$meta[ $entry['image'] ] = array( 'title' => $entry['name'], 'alt' => $entry['image_alt'] ?? '' );
	}
	$imported     = array();
	$category_ids = urumi_seed_categories( $catalog['categories'], $meta, $imported );
	urumi_seed_catalog_products( $catalog['products'], $category_ids, $meta, $imported );

	$hero_url = '';
	$hero     = urumi_seed_photo( $catalog['hero']['image'], $meta, $imported );
	if ( $hero ) {
		$hero_url = wp_make_link_relative( (string) wp_get_attachment_image_url( $hero, 'full' ) );
	}
	urumi_log( 'catalog photos', ( $imported ? 'imported ' . count( $imported ) : 'none imported' ) . '; ' . count( (array) get_option( 'urumi_seed_media', array() ) ) . ' seeded so far' );

	// Root-relative links, so a database restored under another host name still works.
	$page_ids = urumi_seed_pages(
		$catalog['pages'],
		array(
			'{{hero_url}}'   => esc_url( $hero_url ),
			'{{shop_url}}'   => esc_url( wp_make_link_relative( wc_get_page_permalink( 'shop' ) ) ),
			'{{store_name}}' => esc_html( urumi_env( 'STORE_NAME' ) ),
			'{{tagline}}'    => esc_html( urumi_env( 'STORE_TAGLINE', '' ) ),
			'{{address}}'    => esc_html( urumi_env( 'STORE_ADDRESS' ) ),
			'{{city}}'       => esc_html( urumi_env( 'STORE_CITY' ) ),
			'{{postcode}}'   => esc_html( urumi_env( 'STORE_POSTCODE' ) ),
		)
	);
	urumi_seed_menu( $catalog['categories'], $category_ids, $page_ids );
	urumi_remove_sample_content();
	urumi_setup_shop_once();
}

/** Fail the bootstrap (and so the pod) if the end state is not what the store needs. */
function urumi_verify(): void {
	$problems = array();
	if ( ! OrderUtil::custom_orders_table_usage_is_enabled() ) {
		$problems[] = 'HPOS is not the active order storage';
	}
	if ( 'no' !== get_option( 'woocommerce_coming_soon' ) ) {
		$problems[] = 'coming-soon mode is on';
	}
	if ( 'yes' !== WC()->payment_gateways()->payment_gateways()['cod']->get_option( 'enabled' ) ) {
		$problems[] = 'Cash on Delivery is disabled';
	}
	// user_can() also runs WooCommerce's user_has_cap filters, so this is what the REST API will allow.
	$bot      = get_user_by( 'login', URUMI_BOT_LOGIN );
	$too_much = array_filter( URUMI_BOT_FORBIDDEN_CAPS, fn( $cap ) => user_can( $bot, $cap ) );
	if ( $too_much ) {
		$problems[] = URUMI_BOT_LOGIN . ' has capabilities it must not have: ' . implode( ', ', $too_much );
	}
	if ( $problems ) {
		WP_CLI::error( 'verification failed: ' . implode( '; ', $problems ) );
	}
	urumi_log( 'verify', 'HPOS active, storefront public, Cash on Delivery enabled, ' . URUMI_BOT_LOGIN . ' least-privilege' );
}

// ---------------------------------------------------------------------------------------------
$home = urumi_env( 'WP_HOME' );

urumi_ensure_site_url( $home );
urumi_ensure_options(
	'general',
	array(
		'blogname'                    => urumi_env( 'STORE_NAME' ),
		'blogdescription'             => urumi_env( 'STORE_TAGLINE', '' ),
		'timezone_string'             => urumi_env( 'STORE_TIMEZONE' ),
		'woocommerce_email_from_name' => urumi_env( 'STORE_NAME' ),
	)
);
urumi_ensure_permalinks();
urumi_ensure_options(
	'store address',
	array(
		'woocommerce_store_address'   => urumi_env( 'STORE_ADDRESS' ),
		'woocommerce_store_address_2' => '',
		'woocommerce_store_city'      => urumi_env( 'STORE_CITY' ),
		'woocommerce_store_postcode'  => urumi_env( 'STORE_POSTCODE' ),
		'woocommerce_default_country' => urumi_env( 'STORE_COUNTRY' ),
		'woocommerce_currency'        => urumi_env( 'STORE_CURRENCY' ),
	)
);
urumi_ensure_options(
	'storefront',
	array(
		// Must be explicit: a WP-CLI install never runs WooCommerce's "newly installed" hooks (they fire
		// on the first wp-admin visit), and those would otherwise add coming_soon=yes later.
		'woocommerce_coming_soon'      => 'no',
		'woocommerce_store_pages_only' => 'no',
	)
);
urumi_ensure_options(
	'checkout',
	array(
		// No shipping zones/methods are configured, so shipping must be off or checkout is blocked.
		'woocommerce_ship_to_countries'     => 'disabled',
		'woocommerce_enable_guest_checkout' => 'yes',
	)
);
urumi_ensure_cod();
urumi_skip_onboarding();
urumi_ensure_pages();
urumi_ensure_admin_password();
urumi_ensure_bot_role();
urumi_ensure_api_key( urumi_ensure_bot_user() );
urumi_seed_storefront();
urumi_verify();
