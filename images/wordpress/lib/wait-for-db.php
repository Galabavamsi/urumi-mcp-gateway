<?php
/**
 * Bootstrap step 1: wait until MariaDB accepts a login with the WordPress credentials.
 *
 * Uses the same WORDPRESS_DB_* env vars as wp-config.php, so success means "WordPress will be able
 * to connect", not merely "port 3306 is open". Exit code 0 = connected, 1 = gave up.
 */

// Return false on failure instead of throwing (the PHP 8.1+ default); we retry anyway.
mysqli_report( MYSQLI_REPORT_OFF );

$host_port = getenv( 'WORDPRESS_DB_HOST' ) ?: 'mariadb:3306';
[ $host, $port ] = array_pad( explode( ':', $host_port, 2 ), 2, '3306' );
$timeout = (int) ( getenv( 'DB_WAIT_TIMEOUT_SECONDS' ) ?: 180 );
$started = time();

while ( true ) {
	$db = mysqli_init();
	// Without this, a dropped SYN (e.g. a missing NetworkPolicy rule) blocks for a minute per try.
	$db->options( MYSQLI_OPT_CONNECT_TIMEOUT, 5 );
	$ok = @$db->real_connect(
		$host,
		getenv( 'WORDPRESS_DB_USER' ),
		getenv( 'WORDPRESS_DB_PASSWORD' ),
		getenv( 'WORDPRESS_DB_NAME' ),
		(int) $port
	);
	if ( $ok ) {
		$db->close();
		printf( "[bootstrap] database: %s reachable after %ds\n", $host_port, time() - $started );
		exit( 0 );
	}
	if ( time() - $started >= $timeout ) {
		fprintf( STDERR, "[bootstrap] database: %s not reachable after %ds: %s\n", $host_port, $timeout, mysqli_connect_error() );
		exit( 1 );
	}
	sleep( 2 );
}
