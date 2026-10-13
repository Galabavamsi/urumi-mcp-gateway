import type { LookupAddress } from 'node:dns';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  MAX_UPSTREAM_RESPONSE_BYTES,
  UrlNotAllowedError,
  assertUrlAllowed,
  checkUrlShape,
  createUpstreamFetch,
  guardedLookup,
  isPublicAddress,
  type Resolver,
} from './ssrf.ts';
import { classifyUpstreamError } from '../upstreams/errors.ts';

const ALLOWLIST = ['woo-mcp.store.svc.cluster.local', 'supplier-mcp.mcp-upstreams.svc.cluster.local'];

/** A resolver that answers from a table, so tests never touch real DNS. */
const fakeDns =
  (table: Record<string, string[]>): Resolver =>
  async (host) => {
    const answers = table[host];
    if (!answers) throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), { code: 'ENOTFOUND' });
    return answers.map((address): LookupAddress => ({ address, family: address.includes(':') ? 6 : 4 }));
  };

const refused = (url: string, resolve: Resolver = fakeDns({})) => expect(assertUrlAllowed(url, ALLOWLIST, resolve)).rejects.toThrow(UrlNotAllowedError);

describe('isPublicAddress', () => {
  it('accepts ordinary public unicast addresses', () => {
    for (const ip of ['93.184.215.14', '1.1.1.1', '2606:4700:4700::1111']) expect(isPublicAddress(ip)).toBe(true);
  });

  it('refuses loopback, private, link-local, CGNAT, ULA, multicast, reserved and mapped forms', () => {
    for (const ip of [
      '127.0.0.1', '10.0.0.5', '172.16.3.4', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0',
      '224.0.0.1', '255.255.255.255', '240.0.0.1', '::1', '::', 'fd00:ec2::254', 'fe80::1', 'ff02::1',
      '::ffff:169.254.169.254', '::ffff:127.0.0.1', '64:ff9b::a9fe:a9fe', '2002:a9fe:a9fe::1', 'not-an-ip',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });
});

describe('assertUrlAllowed', () => {
  it('allows allowlisted in-cluster hosts over plain http without resolving them', async () => {
    const url = await assertUrlAllowed('http://woo-mcp.store.svc.cluster.local:8080/mcp', ALLOWLIST, fakeDns({}));
    expect(url.hostname).toBe('woo-mcp.store.svc.cluster.local');
  });

  it('allows public https hosts whose every address is public', async () => {
    await expect(assertUrlAllowed('https://mcp.firecrawl.dev/v2/mcp', ALLOWLIST, fakeDns({ 'mcp.firecrawl.dev': ['104.18.1.1', '2606:4700::1'] }))).resolves.toBeInstanceOf(URL);
  });

  it('refuses plain http for anything not allowlisted', async () => {
    await refused('http://mcp.firecrawl.dev/mcp', fakeDns({ 'mcp.firecrawl.dev': ['104.18.1.1'] }));
  });

  it('refuses the cloud metadata address in every spelling', async () => {
    await refused('https://169.254.169.254/latest/meta-data');
    await refused('https://2852039166/'); // decimal
    await refused('https://0251.0376.0251.0376/'); // octal
    await refused('https://0xa9.0xfe.0xa9.0xfe/'); // hex
    await refused('https://[::ffff:169.254.169.254]/'); // IPv4-mapped IPv6
    await refused('https://[64:ff9b::a9fe:a9fe]/'); // NAT64
  });

  it('refuses loopback and private literals', async () => {
    await refused('https://127.0.0.1:8443/mcp');
    await refused('https://127.1/mcp');
    await refused('https://[::1]/mcp');
    await refused('https://10.43.0.10/mcp');
  });

  it('refuses names that resolve to a private address, even if only one answer is private', async () => {
    await refused('https://evil.example/mcp', fakeDns({ 'evil.example': ['10.0.0.5'] }));
    await refused('https://mixed.example/mcp', fakeDns({ 'mixed.example': ['93.184.215.14', '127.0.0.1'] }));
    await refused('https://localhost/mcp', fakeDns({ localhost: ['127.0.0.1', '::1'] }));
    await refused('https://postgres.platform.svc.cluster.local/mcp', fakeDns({ 'postgres.platform.svc.cluster.local': ['10.43.12.7'] }));
  });

  it('refuses unresolvable hosts, other schemes and credentials in the URL', async () => {
    await refused('https://nowhere.invalid/mcp');
    await refused('ftp://files.example/mcp');
    await refused('file:///etc/passwd');
    await refused('https://user:pass@mcp.example/mcp', fakeDns({ 'mcp.example': ['93.184.215.14'] }));
    await refused('not a url');
  });

  it('gives a readable reason', async () => {
    await expect(assertUrlAllowed('https://evil.example/mcp', ALLOWLIST, fakeDns({ 'evil.example': ['10.0.0.5'] }))).rejects.toThrow(
      'evil.example resolves to a non-public address',
    );
    expect(() => checkUrlShape('http://example.com/mcp', ALLOWLIST)).toThrow(/only https/);
  });
});

describe('guardedLookup (connect-time check, defeats DNS rebinding)', () => {
  const lookup = (host: string, all: boolean) =>
    new Promise<{ err: Error | null; address: unknown }>((resolve) =>
      guardedLookup(host, { all }, (err, address) => resolve({ err, address })),
    );

  it('refuses a name that resolves to loopback at connect time', async () => {
    const result = await lookup('localhost', true);
    expect(result.err).toBeInstanceOf(UrlNotAllowedError);
  });

  it('passes a lookup error through (unknown host)', async () => {
    const result = await lookup('no-such-host.invalid', false);
    expect(result.err).not.toBeNull();
    expect(result.err).not.toBeInstanceOf(UrlNotAllowedError);
  });
});

describe('createUpstreamFetch response size cap', () => {
  it('refuses to read a body over MAX_UPSTREAM_RESPONSE_BYTES, and the failure reads as "too large", not as a dead server', async () => {
    // A local "upstream" that answers with 1 MB more than the cap.
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(Buffer.alloc(MAX_UPSTREAM_RESPONSE_BYTES + 1024 * 1024, 0x20));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const upstreamFetch = createUpstreamFetch(['127.0.0.1']);
      const error = await upstreamFetch(`http://127.0.0.1:${port}/mcp`).then((res) => res.text()).then(
        () => null,
        (err: unknown) => err,
      );
      expect(error).not.toBeNull();
      expect(classifyUpstreamError(error)).toEqual({ kind: 'protocol', reason: 'upstream response too large (over 4 MB)' });
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
