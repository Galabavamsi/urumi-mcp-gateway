<?php
/**
 * Reference OAuth 1.0a signatures computed by WooCommerce's own code, used by src/woo/oauth1.test.ts.
 *
 * Run it through generate.sh (never by hand). It executes inside the official wordpress:7.1.3-php8.3-apache
 * image with no network:
 *   - WordPress helpers on the signing path (get_home_url, set_url_scheme, wp_parse_url, wp_unslash,
 *     is_ssl, add_filter) come from the image's own /usr/src/wordpress/wp-includes;
 *   - WooCommerce's class-wc-rest-authentication.php and wc-rest-functions.php are the files of the pinned
 *     WooCommerce git tag, downloaded by generate.sh and mounted at /wc.
 *
 * For every vector we
 *   1. compute the signature: the base-string lines of check_oauth_signature() are repeated below, but the
 *      parameter handling calls WooCommerce's private normalize_parameters()/join_with_equals_sign();
 *   2. prove it: put it in an `Authorization: OAuth ...` header formatted like woo-mcp sends it, and let
 *      WooCommerce's real get_oauth_parameters() + check_oauth_signature() accept it;
 *   3. check a tampered signature is rejected (otherwise step 2 would prove nothing).
 * The output is JSON on stdout; generate.sh writes it to src/woo/oauth1.vectors.json.
 */

define( 'ABSPATH', '/usr/src/wordpress/' );
define( 'WPINC', 'wp-includes' );

// Minimal stand-ins for things that need a database or translations. Everything else is real code.
function get_option( $option, $default_value = false ) {
  return 'home' === $option ? $GLOBALS['reference_home_url'] : $default_value;
}
function __( $text, $domain = 'default' ) {
  return $text;
}
function _n( $single, $plural, $number, $domain = 'default' ) {
  return 1 === $number ? $single : $plural;
}

require ABSPATH . WPINC . '/version.php';
require ABSPATH . WPINC . '/plugin.php';        // add_filter / apply_filters.
require ABSPATH . WPINC . '/load.php';          // is_ssl, is_multisite.
require ABSPATH . WPINC . '/class-wp-error.php';
require ABSPATH . WPINC . '/formatting.php';    // wp_unslash.
require ABSPATH . WPINC . '/http.php';          // wp_parse_url.
require ABSPATH . WPINC . '/link-template.php'; // get_home_url, set_url_scheme.
require '/wc/wc-rest-functions.php';            // wc_rest_urlencode_rfc3986.
require '/wc/class-wc-rest-authentication.php'; // WC_REST_Authentication.

$auth      = WC_REST_Authentication::instance();
$normalize = new ReflectionMethod( WC_REST_Authentication::class, 'normalize_parameters' );
$join      = new ReflectionMethod( WC_REST_Authentication::class, 'join_with_equals_sign' );
$check     = new ReflectionMethod( WC_REST_Authentication::class, 'check_oauth_signature' );

// Obviously fake credentials: these vectors only pin down the algorithm.
$consumer_key    = 'ck_test_consumer_key_for_signature_vectors';
$consumer_secret = 'cs_test_consumer_secret_for_signature_vectors';

$vectors = array(
  array(
    'name'      => 'orders for one store-local day (naive UTC bounds, dates_are_gmt)',
    'method'    => 'GET',
    'home_url'  => 'http://store.127-0-0-1.sslip.io',
    'path'      => '/wp-json/wc/v3/orders',
    'query'     => array(
      array( 'after', '2026-10-13T18:29:59' ),
      array( 'before', '2026-10-14T18:30:00' ),
      array( 'dates_are_gmt', 'true' ),
      array( 'status', 'any' ),
      array( 'per_page', '20' ),
      array( 'page', '1' ),
      array( '_fields', 'id,number,status,date_created_gmt,total' ),
    ),
    'nonce'     => '0f1e2d3c4b5a69788796a5b4c3d2e1f0',
    'timestamp' => 1791900000,
  ),
  array(
    'name'      => 'values needing encoding, unicode, nested filter[] keys and strcmp key order',
    'method'    => 'GET',
    'home_url'  => 'http://store.127-0-0-1.sslip.io',
    'path'      => '/wp-json/wc/v3/products',
    'query'     => array(
      array( 'search', "Masala Chai & Tea + Spices = ₹299 (250g) ~/*!'[] चाय" ),
      array( 'filter[period]', 'week' ),
      array( 'filter[a]', 'b c' ),
      array( 'per_page', '5' ),
      array( 'a-b', '1' ),
      array( 'Zeta', 'uppercase keys sort before lowercase' ),
      array( 'empty', '' ),
    ),
    'nonce'     => 'aaaabbbbccccddddeeeeffff00001111',
    'timestamp' => 1791900123,
  ),
  array(
    'name'      => 'https home URL with port, mixed case and a sub-path; POST body is not signed',
    'method'    => 'POST',
    'home_url'  => 'https://Store.Example.COM:8443/shop',
    'path'      => '/wp-json/wc/v3/products',
    'query'     => array(),
    'nonce'     => '00112233445566778899aabbccddeeff',
    'timestamp' => 1791900456,
  ),
  array(
    'name'      => 'production https home URL, PUT to an order',
    'method'    => 'PUT',
    'home_url'  => 'https://store.urumi.humanslop.in',
    'path'      => '/wp-json/wc/v3/orders/123',
    'query'     => array(),
    'nonce'     => 'ffeeddccbbaa99887766554433221100',
    'timestamp' => 1791900789,
  ),
);

/** The Authorization header exactly as woo-mcp formats it (keys in strcmp order, values rawurlencoded). */
function oauth_header( array $oauth ) {
  ksort( $oauth, SORT_STRING );
  $pairs = array();
  foreach ( $oauth as $key => $value ) {
    $pairs[] = $key . '="' . rawurlencode( $value ) . '"';
  }
  return 'OAuth ' . implode( ', ', $pairs );
}

function fail( $message ) {
  fwrite( STDERR, "reference.php: $message\n" );
  exit( 1 );
}

$results = array();
foreach ( $vectors as $vector ) {
  // The request woo-mcp sends: every query key and value rawurlencoded.
  $pairs = array();
  foreach ( $vector['query'] as $pair ) {
    $pairs[] = rawurlencode( $pair[0] ) . '=' . rawurlencode( $pair[1] );
  }
  $query_string = implode( '&', $pairs );
  $request_uri  = $vector['path'] . ( '' === $query_string ? '' : '?' . $query_string );

  // Present it to WooCommerce the way PHP would: parse_str() is the parser PHP uses to fill $_GET.
  $_GET = array();
  parse_str( $query_string, $_GET );
  $_POST                         = array(); // JSON request bodies never populate $_POST, so they are not signed.
  $_SERVER                       = array(
    'REQUEST_METHOD' => $vector['method'],
    'REQUEST_URI'    => $request_uri,
  );
  $GLOBALS['reference_home_url'] = $vector['home_url'];

  $oauth = array(
    'oauth_consumer_key'     => $consumer_key,
    'oauth_nonce'            => $vector['nonce'],
    'oauth_signature_method' => 'HMAC-SHA256',
    'oauth_timestamp'        => (string) $vector['timestamp'],
  );

  // 1. The signature. These lines repeat check_oauth_signature() from WooCommerce 11.2.0.
  $http_method  = strtoupper( $_SERVER['REQUEST_METHOD'] );
  $request_path = wp_parse_url( $_SERVER['REQUEST_URI'], PHP_URL_PATH );
  $wp_base      = get_home_url( null, '/', 'relative' );
  if ( substr( $request_path, 0, strlen( $wp_base ) ) === $wp_base ) {
    $request_path = substr( $request_path, strlen( $wp_base ) );
  }
  $base_request_uri = rawurlencode( get_home_url( null, $request_path, is_ssl() ? 'https' : 'http' ) );

  $params = array_merge( $_GET, $oauth ); // What get_oauth_parameters() returns, minus oauth_signature.
  uksort( $params, 'strcmp' );
  $params         = $normalize->invoke( $auth, $params );
  $query_to_sign  = implode( '%26', $join->invoke( $auth, $params ) );
  $string_to_sign = $http_method . '&' . $base_request_uri . '&' . $query_to_sign;
  $signature      = base64_encode( hash_hmac( 'sha256', $string_to_sign, $consumer_secret . '&', true ) );

  // 2. WooCommerce itself must accept that signature when it arrives in the Authorization header.
  $user          = (object) array( 'consumer_secret' => $consumer_secret );
  $authorization = oauth_header( $oauth + array( 'oauth_signature' => $signature ) );

  $_SERVER['HTTP_AUTHORIZATION'] = $authorization;
  $verdict                       = $check->invoke( $auth, $user, $auth->get_oauth_parameters() );
  if ( true !== $verdict ) {
    fail( "WooCommerce rejected the signature for '{$vector['name']}': " . $verdict->get_error_message() );
  }

  // 3. ...and must reject a tampered one.
  $_SERVER['HTTP_AUTHORIZATION'] = oauth_header( $oauth + array( 'oauth_signature' => base64_encode( str_repeat( "\0", 32 ) ) ) );
  if ( ! is_wp_error( $check->invoke( $auth, $user, $auth->get_oauth_parameters() ) ) ) {
    fail( "WooCommerce accepted a tampered signature for '{$vector['name']}'" );
  }

  $results[] = $vector + array(
    'consumer_key'    => $consumer_key,
    'consumer_secret' => $consumer_secret,
    'expected'        => array(
      'request_uri'   => $request_uri,
      'base_string'   => $string_to_sign,
      'signature'     => $signature,
      'authorization' => $authorization,
    ),
  );
}

echo json_encode(
  array(
    'generated_by' => 'apps/woo-mcp/test/oauth1-reference/generate.sh',
    'wordpress'    => $wp_version,
    'woocommerce'  => getenv( 'WC_TAG' ),
    'php'          => PHP_VERSION,
    'vectors'      => $results,
  ),
  JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE
) . "\n";
