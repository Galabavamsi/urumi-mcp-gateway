// OAuth 1.0a "one-legged" request signing, written to match WooCommerce's verifier exactly
// (WC_REST_Authentication::check_oauth_signature in includes/class-wc-rest-authentication.php, WooCommerce 11.2.0).
//
// Why OAuth 1.0a at all: in the cluster we talk to WordPress over plain HTTP, and WooCommerce only accepts
// Basic auth / ?consumer_key= when is_ssl() is true. Over HTTP it insists on a signature, which is good for us:
// the consumer secret never travels on the wire, only an HMAC of the request made with it.
//
// How WooCommerce checks a request (and therefore what we must reproduce byte for byte):
//   1. params    = PHP's $_GET (query string only; a JSON body never fills $_POST, so it is NOT signed)
//                  + the oauth_* params, except oauth_signature
//   2. sort      = uksort($params, 'strcmp'): byte order of the *raw* top-level keys, before any encoding
//   3. normalize = rawurlencode every top-level key and every value (keys of nested arrays stay raw)
//   4. join      = rawurlencode("key=value") per param (so values end up encoded twice), glued with '%26'
//   5. base      = METHOD & rawurlencode(home URL + request path, with scheme http) & joined params
//   6. signature = base64(HMAC-SHA256(base, consumer_secret + '&'))
// Step 5 uses the store's home URL (WP_HOME), not the address we connect to, and the scheme comes from
// is_ssl(), which is false for our in-cluster hop, so it is "http" even when the public store is https.
import { createHmac, randomBytes } from 'node:crypto';

/** Query parameters in the order we send them. Keys may use PHP's bracket syntax, e.g. `filter[period]`. */
export type QueryPairs = ReadonlyArray<readonly [key: string, value: string]>;

export interface SignRequestInput {
  method: string;
  /** The store's public home URL (WP_HOME), e.g. `https://store.urumi.humanslop.in`. */
  homeUrl: string;
  /** Request path starting at the site root, e.g. `/wp-json/wc/v3/orders`. */
  path: string;
  query: QueryPairs;
  consumerKey: string;
  consumerSecret: string;
  /** Fixed values for tests; real requests get a fresh random nonce and the current time. */
  nonce?: string;
  timestamp?: number;
}

export interface SignedRequest {
  /** Value for the `Authorization` request header. */
  authorization: string;
  /** Exposed so tests can compare it with WooCommerce's own string_to_sign. */
  baseString: string;
  signature: string;
}

/**
 * Percent-encodes like PHP's rawurlencode() (RFC 3986): everything except `A-Z a-z 0-9 - . _ ~`.
 * encodeURIComponent leaves `! ' ( ) *` alone, so those are encoded by hand.
 */
export function rawUrlEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** Builds the query string we send. Must be what PHP decodes back into the same $_GET we sign. */
export function encodeQuery(query: QueryPairs): string {
  return query.map(([key, value]) => `${rawUrlEncode(key)}=${rawUrlEncode(value)}`).join('&');
}

// A PHP array as WooCommerce sees it. A Map keeps insertion order, like PHP arrays do
// (a plain JS object would move integer-like keys to the front).
type PhpValue = string | PhpArray;
type PhpArray = Map<string, PhpValue>;

// `name` or `name[sub]...`, ASCII letters/digits/_/- only. PHP rewrites some other characters in
// parameter names (`a.b` arrives as `a_b`) and WooCommerce encodes nested keys differently from top-level
// ones, so instead of emulating every corner of that we refuse names we have not verified.
const PARAM_NAME = /^([A-Za-z0-9_-]+)((?:\[[A-Za-z0-9_-]+\])*)$/;

/** Rebuilds the array PHP puts in $_GET for our query, e.g. `filter[x]=1` becomes `['filter' => ['x' => '1']]`. */
export function phpQueryParams(query: QueryPairs): PhpArray {
  const root: PhpArray = new Map();
  for (const [key, value] of query) {
    const match = PARAM_NAME.exec(key);
    if (!match) throw new Error(`cannot sign query parameter name ${JSON.stringify(key)}`);
    const path = [match[1]!, ...[...match[2]!.matchAll(/\[([^\]]+)\]/g)].map((m) => m[1]!)];
    if (path[0]!.startsWith('oauth_')) throw new Error(`query parameter ${key} clashes with the OAuth parameters`);

    let node = root;
    for (const segment of path.slice(0, -1)) {
      const child = node.get(segment) ?? new Map<string, PhpValue>();
      if (typeof child === 'string') throw new Error(`query parameter ${key} conflicts with an earlier one`);
      node.set(segment, child);
      node = child;
    }
    const leaf = path[path.length - 1]!;
    // PHP would silently keep only the last duplicate; we never need duplicates, so treat one as a bug.
    if (node.has(leaf)) throw new Error(`duplicate query parameter ${key}`);
    node.set(leaf, value);
  }
  return root;
}

/** WooCommerce's join_with_equals_sign(normalize_parameters($params)), flattened into one list. */
function joinParams(params: PhpArray, parentKey = ''): string[] {
  const parts: string[] = [];
  for (const [key, value] of params) {
    // normalize_parameters() encodes only top-level keys; nested keys are appended raw inside %5B...%5D.
    const name = parentKey ? `${parentKey}%5B${key}%5D` : rawUrlEncode(key);
    if (typeof value === 'string') parts.push(rawUrlEncode(`${name}=${rawUrlEncode(value)}`));
    else parts.push(...joinParams(value, name));
  }
  return parts;
}

/** PHP's strcmp on our ASCII-only keys is plain code-unit order. */
const strcmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The URL WooCommerce signs: get_home_url(null, $path, 'http'). It swaps the scheme for http, keeps the
 * home host/port/path exactly as configured, and appends the request path.
 */
export function signatureUrl(homeUrl: string, path: string): string {
  const home = homeUrl.replace(/^\w+:\/\//, '').replace(/\/+$/, '');
  return `http://${home}/${path.replace(/^\/+/, '')}`;
}

export function signRequest(input: SignRequestInput): SignedRequest {
  const oauth: Record<string, string> = {
    oauth_consumer_key: input.consumerKey,
    // 32 random hex chars; WooCommerce remembers used nonces per key for 15 minutes to stop replays.
    oauth_nonce: input.nonce ?? randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA256',
    // Must be within 15 minutes of the WordPress server clock.
    oauth_timestamp: String(input.timestamp ?? Math.floor(Date.now() / 1000)),
  };

  const params = phpQueryParams(input.query);
  for (const [key, value] of Object.entries(oauth)) params.set(key, value);
  const sorted: PhpArray = new Map([...params].sort(([a], [b]) => strcmp(a, b)));

  const baseString = [
    input.method.toUpperCase(),
    rawUrlEncode(signatureUrl(input.homeUrl, input.path)),
    joinParams(sorted).join('%26'),
  ].join('&');
  const signature = createHmac('sha256', `${input.consumerSecret}&`).update(baseString).digest('base64');

  // We send the OAuth params in the Authorization header (RFC 5849 section 3.5.1) rather than the query string:
  // WooCommerce's get_oauth_parameters() merges header params (parse_header, which urldecodes each value),
  // the URL stays clean in access logs, and the request path/query we log never contains auth material.
  // WordPress sees the header via the image's .htaccess rule (HTTP_AUTHORIZATION) or getallheaders().
  const headerParams = { ...oauth, oauth_signature: signature };
  const authorization =
    'OAuth ' +
    Object.keys(headerParams)
      .sort(strcmp)
      .map((key) => `${key}="${rawUrlEncode(headerParams[key as keyof typeof headerParams]!)}"`)
      .join(', ');

  return { authorization, baseString, signature };
}
