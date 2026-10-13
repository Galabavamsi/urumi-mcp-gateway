// SSRF guard for upstream URLs that admins type in (Server-Side Request Forgery: making the gateway, which sits
// inside the cluster, fetch something the admin's browser could never reach, e.g. the cloud metadata service at
// 169.254.169.254 or a database Service).
//
// Rules:
//   1. Hosts in INTERNAL_HOST_ALLOWLIST (our own in-cluster MCP Services) may use http or https. Nothing else
//      in the cluster is reachable.
//   2. Every other URL must be https, and EVERY address its host resolves to must be public unicast. We ask
//      ipaddr.js for the address's range and accept only 'unicast' (an allowlist: loopback, private, link-local,
//      CGNAT, unique-local, multicast, NAT64, 6to4, IPv4-mapped forms and every reserved range are refused).
//   3. The check runs twice: when the URL is saved (clear 422 for the admin) and again at connect time inside the
//      HTTP client, on the address actually dialled. The second check defeats DNS rebinding (a name that resolved
//      to a public IP when saved and to 10.0.0.5 a minute later).
//   4. Redirects are never followed (a public URL could redirect to an internal one).
import dns, { type LookupAddress } from 'node:dns';
import net from 'node:net';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as undiciFetch } from 'undici';

export class UrlNotAllowedError extends Error {
  override readonly name = 'UrlNotAllowedError';
}

/** True only for ordinary public addresses. IPv4-mapped IPv6 (::ffff:a.b.c.d) is judged as the IPv4 inside. */
export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  return ipaddr.process(address).range() === 'unicast';
}

/** `new URL()` keeps IPv6 hosts in brackets; strip them for comparisons and IP checks. */
function bareHostname(url: URL): string {
  return url.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
}

export function isAllowlistedHost(url: URL, allowlist: readonly string[]): boolean {
  return allowlist.includes(bareHostname(url));
}

/**
 * The checks that need no DNS: scheme, no credentials in the URL, and IP-literal hosts.
 * (The WHATWG URL parser already turns decimal/octal/hex IPv4 forms like 2852039166 or 0251.0376.0251.0376 into
 * dotted decimal, so they are caught here too.)
 */
export function checkUrlShape(raw: string, allowlist: readonly string[]): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UrlNotAllowedError('not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UrlNotAllowedError('only http(s) URLs are allowed');
  }
  if (url.username || url.password) {
    throw new UrlNotAllowedError('credentials must not be part of the URL; use the credential field');
  }
  if (isAllowlistedHost(url, allowlist)) return url;

  if (url.protocol !== 'https:') {
    throw new UrlNotAllowedError('only https URLs are allowed (plain http only for hosts in INTERNAL_HOST_ALLOWLIST)');
  }
  const host = bareHostname(url);
  if (net.isIP(host) !== 0 && !isPublicAddress(host)) {
    throw new UrlNotAllowedError(`${host} is not a public address`);
  }
  return url;
}

export type Resolver = (hostname: string) => Promise<LookupAddress[]>;

const systemResolver: Resolver = (hostname) => dns.promises.lookup(hostname, { all: true, verbatim: true });

/** Full check for an admin-entered URL: shape, then every DNS answer must be public. */
export async function assertUrlAllowed(
  raw: string,
  allowlist: readonly string[],
  resolve: Resolver = systemResolver,
): Promise<URL> {
  const url = checkUrlShape(raw, allowlist);
  const host = bareHostname(url);
  if (isAllowlistedHost(url, allowlist) || net.isIP(host) !== 0) return url;

  let addresses: LookupAddress[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new UrlNotAllowedError(`could not resolve ${host}`);
  }
  assertAllPublic(host, addresses);
  return url;
}

function assertAllPublic(host: string, addresses: readonly LookupAddress[]): void {
  if (addresses.length === 0) throw new UrlNotAllowedError(`could not resolve ${host}`);
  if (addresses.some((a) => !isPublicAddress(a.address))) {
    throw new UrlNotAllowedError(`${host} resolves to a non-public address`);
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/**
 * A drop-in for dns.lookup used by the HTTP client when it opens a socket: resolves, refuses non-public answers,
 * and hands the SAME vetted addresses to the socket. Node calls it with `all: true` when it races IPv4/IPv6
 * (autoSelectFamily), so both callback shapes are supported.
 */
export function guardedLookup(hostname: string, options: dns.LookupOptions, callback: LookupCallback): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    try {
      assertAllPublic(hostname, addresses);
    } catch (blocked) {
      return callback(blocked as NodeJS.ErrnoException, []);
    }
    if (options.all) return callback(null, addresses);
    const [first] = addresses as [LookupAddress];
    return callback(null, first.address, first.family);
  });
}

export type FetchLike = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** Connect timeout for upstream sockets: a host that does not even accept the TCP connection is down. */
const CONNECT_TIMEOUT_MS = 3_000;

/**
 * The fetch the gateway's MCP clients use for every upstream. Allowlisted in-cluster hosts get a plain
 * connection (they resolve to cluster IPs by design); everything else goes through the guarded lookup.
 * Redirects are an error for both.
 */
export function createUpstreamFetch(allowlist: readonly string[]): FetchLike {
  const internal = new Agent({ connect: { timeout: CONNECT_TIMEOUT_MS } });
  const guarded = new Agent({ connect: { timeout: CONNECT_TIMEOUT_MS, lookup: guardedLookup } });
  return async (input, init) => {
    // Re-checked on every request: net.connect skips `lookup` for IP literals, so those are validated here.
    const url = checkUrlShape(String(input), allowlist);
    const dispatcher = isAllowlistedHost(url, allowlist) ? internal : guarded;
    const response = await undiciFetch(url, { ...(init as object), redirect: 'error', dispatcher });
    // undici's Response implements the same Fetch API the MCP SDK expects from the global one.
    return response as unknown as Response;
  };
}
