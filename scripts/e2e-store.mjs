#!/usr/bin/env node
// End-to-end checks for the store half of the stack, run against the live k3d cluster:
//   (a) the storefront lists the seeded products and is not in "coming soon" mode
//   (b) a guest Cash-on-Delivery checkout through the Store API creates a "processing" order
//   (c) woo-mcp over real MCP, in BOTH protocol eras (legacy 2025-11-25 and modern 2026-07-28):
//       tools/list, list_products, create_product (then seen on the storefront), list_orders today,
//       get_order, update_order_status -> completed
//   (d) supplier-mcp over real MCP, both eras: list_products, check_stock
//   (e) both MCP servers answer 401 with no bearer token or a wrong one
//   (f) NetworkPolicies: only gateway pods in namespace "platform" reach the MCP servers, and no pod
//       outside the store reaches WordPress or MariaDB
//   (g) supplier-mcp pod killed -> replaced and Ready; scaled to 0 -> connection refused fast; back to 1
//   (h) data survives `helm upgrade` with the same values and a WordPress restart
//
// Usage, from the repo root, after scripts/dev-up.sh:
//   node scripts/e2e-store.mjs           every check, about 2-3 minutes ((g) and (h) restart pods)
//   node scripts/e2e-store.mjs --quick   skip (g) and (h)
// On Windows, kubectl and helm run inside WSL (wsl.exe -d Ubuntu --exec ...); elsewhere directly.
// Exit code 0 means every check passed.
//
// Secrets: the MCP bearer tokens are read with kubectl into memory only and never printed.
// Each run leaves one "E2E Test Kettle" product (SKU E2E-KETTLE-<run id>) and one guest order behind,
// so you can look at them in wp-admin.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const STORE_URL = process.env.STORE_URL ?? 'http://store.127-0-0-1.sslip.io';
const WSL_DISTRO = process.env.WSL_DISTRO ?? 'Ubuntu';
const QUICK = process.argv.includes('--quick');
const RUN_ID = Date.now().toString(36); // makes this run's names unique (SKU, probe pods, email)

// Must match charts/woo-store/values.yaml (store.seedProducts) and the supplier catalog.
const SEED_PRODUCTS = [
  { name: 'Masala Chai Tin (250g)', sku: 'URU-CHAI-250', price: '299.00' },
  { name: 'Handloom Cotton Tote', sku: 'URU-TOTE-01', price: '499.00' },
  { name: 'Brass Diya Set (2 pcs)', sku: 'URU-DIYA-02', price: '799.00' },
  { name: 'Organic Turmeric Powder (200g)', sku: 'URU-TURM-200', price: '199.00' },
];
const WOO_TOOLS = ['create_product', 'get_order', 'get_product', 'list_orders', 'list_products', 'update_order_status'];
const SUPPLIER_TOOLS = ['check_stock', 'get_product', 'list_products'];
const SUPPLIER_SELECTOR = 'app.kubernetes.io/name=supplier-mcp';

// In-cluster addresses the NetworkPolicy probes try (docs/CONTRACTS.md).
const TARGETS = {
  wooMcp: { host: 'woo-mcp.store.svc.cluster.local', port: 8080, path: '/healthz' },
  supplierMcp: { host: 'supplier-mcp.mcp-upstreams.svc.cluster.local', port: 8080, path: '/healthz' },
  wordpress: { host: 'wordpress.store.svc.cluster.local', port: 8080 },
  mariadb: { host: 'mariadb.store.svc.cluster.local', port: 3306 },
};

// ---------------------------------------------------------------------------------------------------
// Tiny check runner
// ---------------------------------------------------------------------------------------------------
const results = [];

async function check(id, title, fn) {
  const started = Date.now();
  try {
    const evidence = await fn();
    results.push({ id, ok: true });
    console.log(`PASS (${id}) ${title}  [${((Date.now() - started) / 1000).toFixed(1)}s]`);
    for (const line of [evidence].flat().filter(Boolean)) console.log(`       ${line}`);
  } catch (err) {
    results.push({ id, ok: false });
    console.log(`FAIL (${id}) ${title}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// ---------------------------------------------------------------------------------------------------
// kubectl / helm (inside WSL when running on Windows)
// ---------------------------------------------------------------------------------------------------
/** On Windows the cluster tools live in WSL. `--exec` runs the program without a shell, so arguments arrive as-is. */
function command(argv) {
  return process.platform === 'win32' ? ['wsl.exe', ['-d', WSL_DISTRO, '--exec', ...argv]] : [argv[0], argv.slice(1)];
}

function run(argv, { input = '', timeoutMs = 120_000 } = {}) {
  const [file, args] = command(argv);
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      // wsl.exe writes its own messages as UTF-16; drop the NUL bytes so they stay readable.
      resolve({ code, stdout: stdout.replaceAll('\0', ''), stderr: stderr.replaceAll('\0', '') });
    });
    child.stdin.end(input);
  });
}

async function sh(argv, options) {
  const { code, stdout, stderr } = await run(argv, options);
  if (code !== 0) throw new Error(`${argv.slice(0, 3).join(' ')} exited ${code}: ${stderr.trim().slice(0, 400)}`);
  return stdout;
}

const kubectl = (...args) => sh(['kubectl', ...args]);

/** Reads one Secret key into memory. The value is returned, never logged. */
async function readSecret(namespace, name, key) {
  const b64 = (await kubectl('get', 'secret', '-n', namespace, name, '-o', `jsonpath={.data.${key}}`)).trim();
  assert(b64, `Secret ${namespace}/${name} has no key ${key}`);
  return Buffer.from(b64, 'base64').toString('utf8');
}

/** kubectl port-forward to a free local port; resolves when it is listening. */
async function portForward(namespace, service) {
  // `timeout` ends the forward by itself even if this script dies without cleaning up.
  const [file, args] = command(['timeout', '900', 'kubectl', 'port-forward', '-n', namespace, `svc/${service}`, ':8080']);
  const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const port = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`port-forward to ${service} did not start within 30 s`)), 30_000);
    child.stdout.on('data', (chunk) => {
      out += chunk;
      const match = /Forwarding from 127\.0\.0\.1:(\d+)/.exec(out);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`port-forward to ${service} exited with ${code}`));
    });
  });
  const url = `http://127.0.0.1:${port}`;
  const close = () => child.kill();
  // On Windows, WSL relays a new Linux listening port to Windows' localhost after a short delay,
  // so wait until /healthz answers from this side.
  for (let attempt = 1; ; attempt++) {
    const ok = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
    if (ok) return { url, close };
    if (attempt === 20) {
      close();
      throw new Error(`port-forward to ${service} on ${url} is not reachable`);
    }
    await sleep(500);
  }
}

async function pods(namespace, selector) {
  const list = JSON.parse(await kubectl('get', 'pods', '-n', namespace, '-l', selector, '-o', 'json'));
  return list.items.map((pod) => ({
    name: pod.metadata.name,
    uid: pod.metadata.uid,
    terminating: Boolean(pod.metadata.deletionTimestamp),
    ready: (pod.status.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'),
  }));
}

/** Polls until `predicate(pods)` holds; returns the seconds it took. */
async function waitForPods(namespace, selector, predicate, what, timeoutS = 180) {
  const started = Date.now();
  while (Date.now() - started < timeoutS * 1000) {
    if (predicate(await pods(namespace, selector))) return (Date.now() - started) / 1000;
    await sleep(1000);
  }
  throw new Error(`timed out after ${timeoutS} s waiting for ${what}`);
}

// ---------------------------------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------------------------------
/** mode "legacy" = 2025-11-25 initialize handshake; "auto" = negotiates the stateless 2026-07-28 era. */
async function connectMcp(baseUrl, token, mode) {
  const client = new Client({ name: 'urumi-e2e', version: '1.0.0' }, { versionNegotiation: { mode } });
  const transport = new StreamableHTTPClientTransport(new URL('/mcp', baseUrl), { authProvider: { token: async () => token } });
  await client.connect(transport);
  return client;
}

async function callTool(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.[0]?.text ?? '';
  if (result.isError) throw new Error(`${name} returned an error: ${text}`);
  return result.structuredContent;
}

async function toolNames(client) {
  const { tools } = await client.listTools();
  return tools.map((t) => t.name).sort();
}

/** A raw MCP initialize POST, to see the HTTP status the server gives a caller without the right token. */
async function rawInitialize(baseUrl, authorization) {
  const res = await fetch(new URL('/mcp', baseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(authorization ? { authorization } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'urumi-e2e', version: '1.0.0' } },
    }),
  });
  await res.body?.cancel();
  return { status: res.status, wwwAuthenticate: res.headers.get('www-authenticate') };
}

// ---------------------------------------------------------------------------------------------------
// Storefront and Store API
// ---------------------------------------------------------------------------------------------------
async function getText(url) {
  const res = await fetch(url, { redirect: 'manual' });
  assert(res.status === 200, `GET ${url} -> ${res.status}`);
  return res.text();
}

/** Every page of /shop/ concatenated (the theme shows a limited number of products per page). */
async function shopHtml() {
  let html = '';
  for (let page = 1; page <= 20; page++) {
    const pageHtml = await getText(`${STORE_URL}/shop/${page > 1 ? `page/${page}/` : ''}`);
    html += pageHtml;
    if (!pageHtml.includes(`/shop/page/${page + 1}/`)) break;
  }
  return html;
}

function seedProductsListed(html) {
  return SEED_PRODUCTS.filter((p) => html.includes(p.name) && html.includes(p.price));
}

// ---------------------------------------------------------------------------------------------------
// NetworkPolicy probe pods
// ---------------------------------------------------------------------------------------------------
// A probe pod runs our own woo-mcp image (already in the cluster, so nothing is pulled) and just
// sleeps; each probe is a small Node script piped into `kubectl exec`. Restricted securityContext so
// Pod Security does not warn; activeDeadlineSeconds removes it even if this script crashes.
function probePodManifest({ name, namespace, labels, image }) {
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: { name, namespace, labels: { 'app.kubernetes.io/part-of': 'urumi-e2e', ...labels } },
    spec: {
      restartPolicy: 'Never',
      activeDeadlineSeconds: 1800,
      terminationGracePeriodSeconds: 1,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      securityContext: { runAsNonRoot: true, runAsUser: 1000, runAsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
      containers: [
        {
          name: 'probe',
          image,
          imagePullPolicy: 'IfNotPresent',
          command: ['node', '-e', 'setTimeout(() => {}, 1_800_000)'],
          resources: { requests: { cpu: '10m', memory: '32Mi' }, limits: { cpu: '200m', memory: '128Mi' } },
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } },
        },
      ],
    },
  };
}

/** Runs inside a probe pod: TCP connect to each target, then GET its path when one is given. */
const PROBE_SCRIPT = (targets) => `
import net from 'node:net';
const targets = ${JSON.stringify(targets)};
function tcp(host, port) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    const done = (outcome) => { socket.destroy(); resolve({ outcome, ms: Date.now() - started }); };
    socket.setTimeout(4000, () => done('timeout'));
    socket.once('connect', () => done('open'));
    socket.once('error', (err) => done(err.code === 'ECONNREFUSED' ? 'refused' : String(err.code ?? err.message)));
  });
}
const out = [];
for (const t of targets) {
  const r = await tcp(t.host, t.port);
  if (r.outcome === 'open' && t.path) {
    const res = await fetch('http://' + t.host + ':' + t.port + t.path, { signal: AbortSignal.timeout(4000) })
      .catch((err) => ({ status: err.name }));
    r.http = res.status;
  }
  out.push({ host: t.host, port: t.port, ...r });
}
console.log(JSON.stringify(out));
`;

async function probe(pod, targets) {
  const out = await sh(['kubectl', 'exec', '-i', '-n', pod.namespace, pod.name, '--', 'node', '--input-type=module', '-'], {
    input: PROBE_SCRIPT(targets),
  });
  return JSON.parse(out.trim().split('\n').pop());
}

const reached = (r) => r.outcome === 'open' && (r.http === undefined || r.http === 200);
const describe = (r) => `${r.host.split('.')[0]}:${r.port} ${r.outcome}${r.http ? ` http ${r.http}` : ''} (${r.ms} ms)`;

/**
 * Probes until the expectation holds or the attempts run out. kube-router needs a few seconds before
 * a brand-new pod is matched by allow rules, so an "allowed" path may be refused at first.
 */
async function expectReach(pod, expectations, attempts = 4) {
  let last = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await probe(pod, expectations.map((e) => e.target));
    const wrong = last.filter((r, i) => reached(r) !== expectations[i].reachable);
    if (wrong.length === 0) return last.map(describe);
    if (attempt < attempts) await sleep(3000);
  }
  const detail = last.map((r, i) => `${describe(r)} expected ${expectations[i].reachable ? 'reachable' : 'blocked'}`);
  throw new Error(`${pod.namespace}/${pod.name}: ${detail.join('; ')}`);
}

// ---------------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------------
const cleanups = [];
const state = {}; // values later checks need from earlier ones

async function main() {
  console.log(`Urumi store e2e, run ${RUN_ID}, store ${STORE_URL}${QUICK ? ' (quick)' : ''}\n`);

  await check('a', 'storefront lists the 4 seed products and is open (not "coming soon")', async () => {
    const home = await getText(`${STORE_URL}/`);
    const shop = await shopHtml();
    const listed = seedProductsListed(shop);
    assert(listed.length === SEED_PRODUCTS.length, `only ${listed.map((p) => p.sku).join(', ')} listed on /shop/`);
    assert(!/coming soon/i.test(home + shop), 'the page says "coming soon"');
    assert(shop.includes('&#8377;'), 'no ₹ symbol on /shop/');
    return [`GET / 200, GET /shop/ 200; listed: ${listed.map((p) => `${p.sku} ₹${p.price}`).join(', ')}`, '"coming soon" appears 0 times'];
  });

  await check('b', 'guest Cash-on-Delivery checkout through the Store API creates a processing order', async () => {
    const api = `${STORE_URL}/wp-json/wc/store/v1`;
    const [chai] = await (await fetch(`${api}/products?sku=URU-CHAI-250`)).json();
    assert(chai?.id, 'URU-CHAI-250 not found through the Store API');

    // A guest cart is identified by the Cart-Token header; writes also need the Store API Nonce.
    const cartRes = await fetch(`${api}/cart`);
    const headers = {
      'content-type': 'application/json',
      nonce: cartRes.headers.get('nonce') ?? '',
      'cart-token': cartRes.headers.get('cart-token') ?? '',
    };
    assert(headers.nonce && headers['cart-token'], 'GET /cart returned no Nonce / Cart-Token headers');

    const addRes = await fetch(`${api}/cart/add-item`, { method: 'POST', headers, body: JSON.stringify({ id: chai.id, quantity: 2 }) });
    const cart = await addRes.json();
    assert(addRes.status === 201 || addRes.status === 200, `add-item -> ${addRes.status} ${JSON.stringify(cart).slice(0, 200)}`);

    const address = {
      first_name: 'Asha', last_name: 'E2E', company: '', address_1: '12 MG Road', address_2: '',
      city: 'Bengaluru', state: 'KA', postcode: '560001', country: 'IN', phone: '9000000000',
    };
    const checkoutRes = await fetch(`${api}/checkout`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        billing_address: { ...address, email: `e2e+${RUN_ID}@example.test` },
        shipping_address: address,
        payment_method: 'cod',
        customer_note: `e2e run ${RUN_ID}`,
      }),
    });
    const order = await checkoutRes.json();
    assert(checkoutRes.status === 200, `checkout -> ${checkoutRes.status} ${JSON.stringify(order).slice(0, 300)}`);
    assert(order.status === 'processing', `order status is ${order.status}, expected processing`);
    state.orderId = order.order_id;
    return [
      `cart: needs_shipping=${cart.needs_shipping}, payment_methods=${JSON.stringify(cart.payment_methods)}, total ₹${Number(cart.totals.total_price) / 100}`,
      `order #${order.order_id} status=${order.status} payment_method=${order.payment_method}`,
    ];
  });

  // --- woo-mcp ---------------------------------------------------------------------------------
  const wooToken = await readSecret('store', 'woo-mcp-auth', 'token');
  const wooForward = await portForward('store', 'woo-mcp');
  cleanups.push(wooForward.close);
  const woo = {};

  await check('c1', 'woo-mcp: both protocol eras connect and list the 6 tools', async () => {
    woo.legacy = await connectMcp(wooForward.url, wooToken, 'legacy');
    woo.modern = await connectMcp(wooForward.url, wooToken, 'auto');
    cleanups.push(() => woo.legacy.close(), () => woo.modern.close());
    const eras = [woo.legacy.getProtocolEra(), woo.modern.getProtocolEra()];
    assert(eras[0] === 'legacy' && eras[1] === 'modern', `eras negotiated: ${eras.join(', ')}`);
    const lists = [await toolNames(woo.legacy), await toolNames(woo.modern)];
    for (const names of lists) assert(JSON.stringify(names) === JSON.stringify(WOO_TOOLS), `tools: ${names.join(', ')}`);
    return [`legacy client -> era ${eras[0]}, auto client -> era ${eras[1]} (via kubectl port-forward ${wooForward.url})`, `tools: ${WOO_TOOLS.join(', ')}`];
  });

  await check('c2', 'woo-mcp: list_products returns the seed products (both eras)', async () => {
    const lines = [];
    for (const [era, client] of Object.entries({ legacy: woo.legacy, modern: woo.modern })) {
      const out = await callTool(client, 'list_products', { per_page: 50 });
      const skus = out.products.map((p) => p.sku);
      const missing = SEED_PRODUCTS.filter((p) => !skus.includes(p.sku));
      assert(missing.length === 0, `${era}: missing ${missing.map((p) => p.sku).join(', ')}`);
      lines.push(`${era}: total=${out.total}, includes ${SEED_PRODUCTS.map((p) => p.sku).join(', ')}`);
    }
    return lines;
  });

  await check('c3', 'woo-mcp: create_product "E2E Test Kettle" ₹149 appears on the storefront', async () => {
    const sku = `E2E-KETTLE-${RUN_ID.toUpperCase()}`;
    const product = await callTool(woo.legacy, 'create_product', { name: 'E2E Test Kettle', regular_price: 149, sku });
    assert(product.regular_price === '149.00' && product.status === 'publish', `created ${JSON.stringify(product)}`);
    state.kettle = product;
    const page = await getText(product.permalink);
    assert(page.includes('E2E Test Kettle') && page.includes('149.00'), 'product page lacks the name or price');
    const shop = await shopHtml();
    assert(shop.includes(product.permalink), 'the new product is not linked from /shop/');
    return [`created #${product.id} sku=${sku} regular_price=${product.regular_price} (legacy era)`, `GET ${product.permalink} 200 with name and ₹149.00; linked from /shop/`];
  });

  await check('c4', 'woo-mcp: list_orders {date:"today"} returns the guest order (both eras)', async () => {
    assert(state.orderId, 'no order from (b)');
    const lines = [];
    for (const [era, client] of Object.entries({ legacy: woo.legacy, modern: woo.modern })) {
      const out = await callTool(client, 'list_orders', { date: 'today' });
      const mine = out.orders.find((o) => o.id === state.orderId);
      assert(mine, `${era}: order #${state.orderId} not in today's ${out.count} orders`);
      lines.push(`${era}: window ${out.window.from} .. ${out.window.to} (${out.window.timezone}); ${out.count} order(s); #${mine.id} ${mine.status} ₹${mine.total} "${mine.items.join(', ')}"`);
    }
    return lines;
  });

  await check('c5', 'woo-mcp: get_order, then update_order_status -> completed', async () => {
    const before = await callTool(woo.modern, 'get_order', { id: state.orderId });
    assert(before.status === 'processing', `status before is ${before.status}`);
    assert(before.payment_method_title === 'Cash on delivery', `payment method ${before.payment_method_title}`);
    const update = await callTool(woo.modern, 'update_order_status', { id: state.orderId, status: 'completed', note: `Delivered (e2e run ${RUN_ID})` });
    assert(update.previous_status === 'processing' && update.status === 'completed' && update.changed, `update returned ${JSON.stringify(update)}`);
    const after = await callTool(woo.legacy, 'get_order', { id: state.orderId });
    assert(after.status === 'completed', `status after is ${after.status}`);
    return [
      `get_order #${before.id} (modern): ${before.status}, ${before.payment_method_title}, ${before.line_items.map((l) => `${l.sku}×${l.quantity}`).join(', ')}, total ₹${before.totals.total}`,
      `update_order_status (modern): ${update.previous_status} -> ${update.status}, note_added=${update.note_added}`,
      `get_order (legacy): ${after.status}, date_completed=${after.date_completed}`,
    ];
  });

  // --- supplier-mcp ----------------------------------------------------------------------------
  const supplierToken = await readSecret('mcp-upstreams', 'supplier-mcp-auth', 'token');
  const supplierForward = await portForward('mcp-upstreams', 'supplier-mcp');
  cleanups.push(supplierForward.close);

  await check('d', 'supplier-mcp: list_products and check_stock (both eras)', async () => {
    const lines = [];
    for (const mode of ['legacy', 'auto']) {
      const client = await connectMcp(supplierForward.url, supplierToken, mode);
      try {
        const era = client.getProtocolEra();
        const names = await toolNames(client);
        assert(JSON.stringify(names) === JSON.stringify(SUPPLIER_TOOLS), `${era}: tools ${names.join(', ')}`);
        const catalog = await callTool(client, 'list_products');
        assert(catalog.count >= 4 && catalog.products.some((p) => p.sku === 'SUP-CHAI-250'), `${era}: catalog ${catalog.count} items`);
        const stock = await callTool(client, 'check_stock', { sku: 'SUP-CHAI-250', quantity: 48 });
        assert(stock.available === true, `${era}: check_stock ${JSON.stringify(stock)}`);
        lines.push(`${mode} -> era ${era}: tools ${names.join(', ')}; ${catalog.count} catalog items; SUP-CHAI-250 ×48 available (${stock.reason}, ₹${stock.unit_cost_inr}/unit)`);
      } finally {
        await client.close();
      }
    }
    return lines;
  });

  await check('e', 'both MCP servers reject a missing or wrong bearer token with 401', async () => {
    const lines = [];
    for (const [name, url] of [['woo-mcp', wooForward.url], ['supplier-mcp', supplierForward.url]]) {
      const none = await rawInitialize(url);
      const wrong = await rawInitialize(url, 'Bearer not-the-right-token-0123456789');
      assert(none.status === 401 && wrong.status === 401, `${name}: no token -> ${none.status}, wrong token -> ${wrong.status}`);
      const connectError = await connectMcp(url, 'not-the-right-token-0123456789', 'auto').then(
        (c) => (c.close(), 'connected'),
        (err) => err.constructor.name,
      );
      assert(connectError !== 'connected', `${name}: an MCP client with a wrong token connected`);
      lines.push(`${name}: no token 401, wrong token 401 (WWW-Authenticate: ${none.wwwAuthenticate ?? 'none'}); client connect rejected (${connectError})`);
    }
    return lines;
  });

  // --- NetworkPolicies -------------------------------------------------------------------------
  const image = (await kubectl('get', 'deploy', 'woo-mcp', '-n', 'store', '-o', 'jsonpath={.spec.template.spec.containers[0].image}')).trim();
  const probePods = {
    gateway: { name: `e2e-gateway-${RUN_ID}`, namespace: 'platform', labels: { 'app.kubernetes.io/component': 'gateway' } },
    plain: { name: `e2e-plain-${RUN_ID}`, namespace: 'platform', labels: {} },
    outsider: { name: `e2e-outsider-${RUN_ID}`, namespace: 'default', labels: { 'app.kubernetes.io/component': 'gateway' } },
  };
  const manifests = Object.values(probePods).map((p) => probePodManifest({ ...p, image }));
  await sh(['kubectl', 'apply', '-f', '-'], { input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items: manifests }) });
  cleanups.push(() =>
    Promise.all(Object.values(probePods).map((p) => run(['kubectl', 'delete', 'pod', '-n', p.namespace, p.name, '--wait=false']))),
  );
  for (const p of Object.values(probePods)) await kubectl('wait', '--for=condition=Ready', `pod/${p.name}`, '-n', p.namespace, '--timeout=90s');
  await sleep(6000); // let kube-router match the brand-new pods

  await check('f1', 'NetworkPolicy: a gateway pod in "platform" reaches woo-mcp and supplier-mcp, not WordPress/MariaDB', async () =>
    expectReach(probePods.gateway, [
      { target: TARGETS.wooMcp, reachable: true },
      { target: TARGETS.supplierMcp, reachable: true },
      { target: TARGETS.wordpress, reachable: false },
      { target: TARGETS.mariadb, reachable: false },
    ]),
  );
  await check('f2', 'NetworkPolicy: an unlabelled pod in "platform" reaches none of them', async () =>
    expectReach(probePods.plain, Object.values(TARGETS).map((target) => ({ target, reachable: false })), 1),
  );
  await check('f3', 'NetworkPolicy: a gateway-labelled pod OUTSIDE "platform" reaches none of them', async () =>
    expectReach(probePods.outsider, Object.values(TARGETS).map((target) => ({ target, reachable: false })), 1),
  );

  if (QUICK) return;

  // --- (g) pod kill and scale to zero -----------------------------------------------------------
  await check('g1', 'supplier-mcp: deleted pod is replaced and Ready again', async () => {
    const [old] = await pods('mcp-upstreams', SUPPLIER_SELECTOR);
    assert(old?.ready, 'supplier-mcp is not Ready before the test');
    await kubectl('delete', 'pod', '-n', 'mcp-upstreams', old.name, '--wait=false');
    const seconds = await waitForPods('mcp-upstreams', SUPPLIER_SELECTOR,
      (list) => list.some((p) => p.name !== old.name && p.ready && !p.terminating), 'a replacement supplier-mcp pod');
    const [result] = await expectReach(probePods.gateway, [{ target: TARGETS.supplierMcp, reachable: true }]);
    return [`deleted ${old.name}; replacement Ready after ${seconds.toFixed(1)} s`, `gateway probe: ${result}`];
  });

  await check('g2', 'supplier-mcp: scaled to 0 -> refused quickly; scaled back to 1 -> healthy', async () => {
    const restore = () => kubectl('scale', 'deploy/supplier-mcp', '-n', 'mcp-upstreams', '--replicas=1');
    try {
      await kubectl('scale', 'deploy/supplier-mcp', '-n', 'mcp-upstreams', '--replicas=0');
      await waitForPods('mcp-upstreams', SUPPLIER_SELECTOR, (list) => list.length === 0, 'supplier-mcp pods to go away', 90);
      await sleep(2000); // the Service's endpoints follow the pod deletion
      const [down] = await probe(probePods.gateway, [TARGETS.supplierMcp]);
      assert(down.outcome === 'refused' && down.ms < 2000, `with 0 replicas: ${describe(down)}`);
      await restore();
      const seconds = await waitForPods('mcp-upstreams', SUPPLIER_SELECTOR, (list) => list.some((p) => p.ready), 'supplier-mcp to be Ready');
      const [up] = await expectReach(probePods.gateway, [{ target: TARGETS.supplierMcp, reachable: true }]);
      return [`replicas=0: ${describe(down)}`, `replicas=1: Ready after ${seconds.toFixed(1)} s; ${up}`];
    } catch (err) {
      await restore().catch(() => {});
      throw err;
    }
  });

  // --- (h) persistence ------------------------------------------------------------------------
  await check('h1', '`helm upgrade` with the same values restarts nothing and keeps the data', async () => {
    const before = [...(await pods('store', 'app.kubernetes.io/name=wordpress')), ...(await pods('store', 'app.kubernetes.io/name=mariadb'))];
    // --reuse-values = exactly the values of the running release. Runs in the repo root (WSL maps the cwd).
    await sh(['helm', 'upgrade', 'woo-store', 'charts/woo-store', '-n', 'store', '--reuse-values',
      '--wait', '--timeout', '10m', '--rollback-on-failure'], { timeoutMs: 660_000 });
    const revision = JSON.parse(await sh(['helm', 'status', 'woo-store', '-n', 'store', '-o', 'json'])).version;
    const after = [...(await pods('store', 'app.kubernetes.io/name=wordpress')), ...(await pods('store', 'app.kubernetes.io/name=mariadb'))];
    const same = JSON.stringify(before.map((p) => p.uid).sort()) === JSON.stringify(after.map((p) => p.uid).sort());
    assert(same, `pods changed: ${before.map((p) => p.name)} -> ${after.map((p) => p.name)}`);
    const order = await callTool(woo.modern, 'get_order', { id: state.orderId });
    assert(order.status === 'completed', `order #${state.orderId} is ${order.status}`);
    return [`release woo-store now at revision ${revision}; pods unchanged: ${after.map((p) => p.name).join(', ')}`, `order #${order.id} still ${order.status}`];
  });

  await check('h2', 'WordPress restart (rollout restart) keeps products and orders', async () => {
    const [old] = await pods('store', 'app.kubernetes.io/name=wordpress');
    await kubectl('rollout', 'restart', 'deploy/wordpress', '-n', 'store');
    await sh(['kubectl', 'rollout', 'status', 'deploy/wordpress', '-n', 'store', '--timeout=300s'], { timeoutMs: 320_000 });
    const [now] = await pods('store', 'app.kubernetes.io/name=wordpress');
    assert(now && now.name !== old.name, 'the wordpress pod was not replaced');
    const bootstrapLog = await kubectl('logs', '-n', 'store', now.name, '-c', 'bootstrap');
    const seedLine = bootstrapLog.split('\n').find((l) => l.includes('seed products')) ?? '';
    assert(seedLine.includes('none created'), `bootstrap re-seeded: "${seedLine}"`);
    const shop = await shopHtml();
    assert(seedProductsListed(shop).length === SEED_PRODUCTS.length, 'seed products missing after restart');
    assert(shop.includes(state.kettle.permalink), 'the e2e kettle is missing after restart');
    const order = await callTool(woo.modern, 'get_order', { id: state.orderId });
    assert(order.status === 'completed', `order #${state.orderId} is ${order.status}`);
    const kettle = await callTool(woo.legacy, 'list_products', { sku: state.kettle.sku });
    assert(kettle.count === 1, `kettle lookup by SKU found ${kettle.count}`);
    return [`${old.name} -> ${now.name}; bootstrap: "${seedLine.trim()}"`, `/shop/ still lists 4 seeds + kettle #${state.kettle.id}; order #${order.id} still ${order.status}`];
  });
}

try {
  await main();
} catch (err) {
  results.push({ id: 'setup', ok: false });
  console.log(`FAIL (setup) ${err instanceof Error ? err.message : String(err)}`);
} finally {
  for (const cleanup of cleanups.reverse()) await Promise.resolve().then(cleanup).catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed: ${failed.map((r) => r.id).join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
