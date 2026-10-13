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

/**
 * The bot user that woo-mcp acts as. shop_manager can manage products and orders but not plugins,
 * users or site settings. Its password is random and never used: it only ever authenticates with
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
				'role'         => 'shop_manager',
			)
		);
		if ( is_wp_error( $id ) ) {
			WP_CLI::error( 'could not create mcp-bot: ' . $id->get_error_message() );
		}
		urumi_log( 'mcp-bot user', "created #{$id} with role shop_manager" );
		return $id;
	}
	if ( array( 'shop_manager' ) !== array_values( $bot->roles ) ) {
		$bot->set_role( 'shop_manager' );
		urumi_log( 'mcp-bot user', "#{$bot->ID} role reset to shop_manager" );
	} else {
		urumi_log( 'mcp-bot user', "#{$bot->ID} unchanged (shop_manager)" );
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

/**
 * Seed catalog (same names/SKUs/prices as the supplier catalog). A product is created only when no
 * live product has its SKU, so re-runs never duplicate and a partly-seeded store heals itself.
 */
function urumi_seed_products(): void {
	$products = json_decode( urumi_env( 'STORE_SEED_PRODUCTS', '[]' ), true );
	if ( ! is_array( $products ) ) {
		WP_CLI::error( 'STORE_SEED_PRODUCTS is not a JSON array' );
	}
	$created = array();
	foreach ( $products as $seed ) {
		if ( wc_get_product_id_by_sku( $seed['sku'] ) ) {
			continue;
		}
		$product = new WC_Product_Simple();
		$product->set_name( $seed['name'] );
		$product->set_sku( $seed['sku'] );
		$product->set_regular_price( (string) $seed['price'] ); // WooCommerce stores prices as strings.
		$product->set_short_description( $seed['description'] ?? '' );
		$product->set_status( 'publish' );
		$product->save();
		$created[] = $seed['sku'];
	}
	$present = count( $products ) - count( $created );
	urumi_log( 'seed products', ( $created ? 'created ' . implode( ', ', $created ) : 'none created' ) . "; {$present} already present" );
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
	if ( $problems ) {
		WP_CLI::error( 'verification failed: ' . implode( '; ', $problems ) );
	}
	urumi_log( 'verify', 'HPOS active, storefront public, Cash on Delivery enabled' );
}

// ---------------------------------------------------------------------------------------------
$home = urumi_env( 'WP_HOME' );

urumi_ensure_site_url( $home );
urumi_ensure_options(
	'general',
	array(
		'blogname'        => urumi_env( 'STORE_NAME' ),
		'timezone_string' => urumi_env( 'STORE_TIMEZONE' ),
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
urumi_ensure_api_key( urumi_ensure_bot_user() );
urumi_seed_products();
urumi_verify();
