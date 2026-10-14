<?php
/**
 * Plugin Name: Urumi storefront
 * Description: Presentation tweaks for the Storefront theme: no theme credit in the footer, no WordPress
 *              version in the page head, the homepage hero's styles, and all five shop categories on the
 *              homepage. Baked into the image (images/wordpress/mu-plugins), so it cannot be switched off
 *              or edited in wp-admin.
 *
 * Content (products, pages, menu, the hero's text and photo) is not here: the bootstrap seeds it once
 * (lib/configure-store.php), and after that it belongs to the merchant.
 */

defined( 'ABSPATH' ) || exit;

// A shop's footer shows the shop, not "Built with WooCommerce & Storefront". The copyright line stays.
add_filter( 'storefront_credit_link', '__return_false' );

// Don't advertise the WordPress version (the generator meta tag in the head and in feeds).
remove_action( 'wp_head', 'wp_generator' );
add_filter( 'the_generator', '__return_empty_string' );

// The homepage template prints the page title ("Home") above the content. The hero in the content has
// its own heading, so drop the title there. Storefront adds its hooks when the theme loads, after the
// must-use plugins, so this runs on init.
add_action(
	'init',
	static function () {
		remove_action( 'storefront_homepage', 'storefront_homepage_header', 10 );
	}
);

// "Shop by Category" on the homepage: all five categories in one row (Storefront shows three).
add_filter(
	'storefront_product_categories_args',
	static function ( $args ) {
		$args['limit']   = 5;
		$args['columns'] = 5;
		return $args;
	}
);

// Styles for the homepage hero (the "urumi-hero" block in the Home page's content).
add_action(
	'wp_enqueue_scripts',
	static function () {
		if ( ! wp_style_is( 'storefront-style', 'enqueued' ) ) {
			return;
		}
		wp_add_inline_style(
			'storefront-style',
			'.urumi-hero{position:relative;margin:0 0 3em;padding:5.5em 3em;background:#3a2a20 center/cover no-repeat;border-radius:6px;overflow:hidden}'
			. '.urumi-hero::before{content:"";position:absolute;inset:0;background:linear-gradient(90deg,rgba(20,12,6,.78) 0%,rgba(20,12,6,.45) 55%,rgba(20,12,6,.1) 100%)}'
			. '.urumi-hero__text{position:relative;max-width:34em;color:#fff}'
			. '.urumi-hero__text h1{color:#fff;font-size:2.6em;line-height:1.15;margin:0 0 .4em;letter-spacing:-.01em}'
			. '.urumi-hero__text p{font-size:1.15em;margin:0 0 1.4em;color:#f4ece4}'
			. '.urumi-hero__text p:last-child{margin-bottom:0}'
			. '.urumi-hero .button{background:#f4ece4;color:#2b1a10;padding:.8em 1.8em;font-weight:600;border-radius:3px}'
			. '.urumi-hero .button:hover,.urumi-hero .button:focus{background:#fff;color:#2b1a10}'
			. '@media (max-width:767px){.urumi-hero{padding:3em 1.4em}.urumi-hero__text h1{font-size:1.9em}}'
		);
	},
	20
);
