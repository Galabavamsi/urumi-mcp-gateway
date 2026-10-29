#!/usr/bin/env node
// End-to-end checks for the store half of the stack, run against the live k3d cluster:
//   (a) the storefront lists the seeded products and is not in "coming soon" mode
//   (k) the store notice banner says exactly what the chart value store.notice says, or is absent when it is empty
//   (b) a guest Cash-on-Delivery checkout through the Store API creates a "processing" order
//   (c) woo-mcp over real MCP, in BOTH protocol eras (legacy 2025-11-25 and modern 2026-07-28):
//       tools/list, list_products, create_product (then seen on the storefront; a retry with the same SKU
//       is refused), list_orders today, get_order, update_order_status -> completed ("refunded" refused);
//       mcp-bot's REST key is refused customers, settings and system status (least privilege)
//   (d) supplier-mcp over real MCP, both eras: list_products, check_stock
//   (e) both MCP servers answer 401 with no bearer token or a wrong one
//   (f) NetworkPolicies: only gateway pods in namespace "platform" reach the MCP servers, and no pod
//       outside the store reaches WordPress or MariaDB
//   (i) a PHP file in uploads is refused (403), and the code directory is read-only
//   (j) 12 concurrent page views: none stalls on an idle keep-alive connection
//   (g) supplier-mcp pod killed -> replaced and Ready; scaled to 0 -> connection refused fast; back to 1
//   (h) data survives `helm upgrade` with the same values and a WordPress restart, and the restart does
//       not bring back a seed product the merchant trashed
//
// Usage, from the repo root, after scripts/dev-up.sh:
//   node scripts/e2e-store.mjs           every check, about 2-3 minutes ((g) and (h) restart pods)
//   node scripts/e2e-store.mjs --quick   skip (g) and (h)
// On Windows, kubectl and helm run inside WSL (wsl.exe -d Ubuntu --exec ...); elsewhere directly.
// Exit code 0 means every check passed.
//
// The defaults are the local k3d cluster. To run against another deployment (e.g. the VPS, docs/VPS.md):
//   E2E_STORE_URL     the storefront, e.g. https://store.urumi.humanslop.in  (default http://store.127-0-0-1.sslip.io;
//                     the older name STORE_URL still works)
//   E2E_KUBE_CONTEXT  kubectl/helm context, e.g. urumi-vps                   (default: the current context)
//   E2E_KUBECONFIG    kubeconfig file, e.g. /home/<you>/.kube/urumi-vps.yaml (default: kubectl's own default)
//                     (a WSL path when kubectl runs in WSL)
//   E2E_WSL=0         run kubectl and helm directly even on Windows          (default: through WSL on Windows)
//   WSL_DISTRO        the WSL distribution                                   (default Ubuntu)
// Example (Windows, VPS, tunnel running in WSL):
//   $env:E2E_STORE_URL='https://store.urumi.humanslop.in'; $env:E2E_KUBE_CONTEXT='urumi-vps'
//   $env:E2E_KUBECONFIG='/home/<you>/.kube/urumi-vps.yaml'; node scripts/e2e-store.mjs
//
// Secrets: the MCP bearer tokens and the WooCommerce key pair are read with kubectl into memory only
// and never printed.
// Each run creates one "E2E Test Kettle" product (SKU E2E-KETTLE-<run id>) and one guest order (billing
// e2e+<run id>@example.test) and deletes both at the end, also after a failure, with WP-CLI in the
// WordPress pod (found by that SKU and email, so even a half-finished step is cleaned up).
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
// woo-mcp's own OAuth 1.0a signer (Node 24 runs .ts files directly), to call WooCommerce as mcp-bot in (c6).
import { signRequest } from '../apps/woo-mcp/src/woo/oauth1.ts';

const STORE_URL = (process.env.E2E_STORE_URL ?? process.env.STORE_URL ?? 'http://store.127-0-0-1.sslip.io').replace(/\/+$/, '');
const WSL_DISTRO = process.env.WSL_DISTRO ?? 'Ubuntu';
const USE_WSL = process.platform === 'win32' && process.env.E2E_WSL !== '0';
// Flags that pin every kubectl / helm call to one cluster. Empty by default: the current context.
const KUBECONFIG_PATH = process.env.E2E_KUBECONFIG ?? '';
const KUBE_CONTEXT = process.env.E2E_KUBE_CONTEXT ?? '';
const CLUSTER_FLAGS = {
  kubectl: [...(KUBECONFIG_PATH ? ['--kubeconfig', KUBECONFIG_PATH] : []), ...(KUBE_CONTEXT ? ['--context', KUBE_CONTEXT] : [])],
  helm: [...(KUBECONFIG_PATH ? ['--kubeconfig', KUBECONFIG_PATH] : []), ...(KUBE_CONTEXT ? ['--kube-context', KUBE_CONTEXT] : [])],
};
const QUICK = process.argv.includes('--quick');
const RUN_ID = Date.now().toString(36); // makes this run's names unique (SKU, probe pods, email)
// This run's test data, by the identifiers the cleanup finds it with.
const KETTLE_SKU = `E2E-KETTLE-${RUN_ID.toUpperCase()}`;
const ORDER_EMAIL = `e2e+${RUN_ID}@example.test`;

// Must match images/wordpress/seed/catalog.json (the four original seed products) and the supplier catalog.
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
/**
 * Adds the E2E_KUBECONFIG / E2E_KUBE_CONTEXT flags right after the kubectl or helm program name, wherever it sits
 * in argv (e.g. `timeout 900 kubectl port-forward ...`), so no call site can forget them. No flags set = argv as is.
 */
function pinCluster(argv) {
  const i = argv.findIndex((arg) => arg === 'kubectl' || arg === 'helm');
  return i < 0 ? argv : [...argv.slice(0, i + 1), ...CLUSTER_FLAGS[argv[i]], ...argv.slice(i + 1)];
}

/** On Windows the cluster tools live in WSL. `--exec` runs the program without a shell, so arguments arrive as-is. */
function command(argv) {
  const pinned = pinCluster(argv);
  return USE_WSL ? ['wsl.exe', ['-d', WSL_DISTRO, '--exec', ...pinned]] : [pinned[0], pinned.slice(1)];
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
/** Runs a command in the WordPress web container (uid 33, the same user Apache serves requests as). */
const inWordpress = (...args) => kubectl('exec', '-n', 'store', 'deploy/wordpress', '-c', 'wordpress', '--', ...args);

/** Reads one Secret key into memory. The value is returned, never logged. */
async function readSecret(namespace, name, key) {
  const b64 = (await kubectl('get', 'secret', '-n', namespace, name, '-o', `jsonpath={.data.${key}}`)).trim();
  assert(b64, `Secret ${namespace}/${name} has no key ${key}`);
  return Buffer.from(b64, 'base64').toString('utf8');
}

/** kubectl port-forward to a free local port; resolves when `readyPath` answers 2xx through it. */
async function portForward(namespace, service, readyPath = '/healthz') {
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
  // so wait until the ready path answers from this side.
  for (let attempt = 1; ; attempt++) {
    const ok = await fetch(`${url}${readyPath}`, { signal: AbortSignal.timeout(2000) }).then((r) => r.ok, () => false);
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
  const target = KUBE_CONTEXT ? `, kube context ${KUBE_CONTEXT}` : '';
  console.log(`Urumi store e2e, run ${RUN_ID}, store ${STORE_URL}${target}${QUICK ? ' (quick)' : ''}\n`);

  await check('a', 'storefront lists the 4 seed products and is open (not "coming soon")', async () => {
    const home = await getText(`${STORE_URL}/`);
    const shop = await shopHtml();
    const listed = seedProductsListed(shop);
    assert(listed.length === SEED_PRODUCTS.length, `only ${listed.map((p) => p.sku).join(', ')} listed on /shop/`);
    assert(!/coming soon/i.test(home + shop), 'the page says "coming soon"');
    assert(shop.includes('&#8377;'), 'no ₹ symbol on /shop/');
    return [`GET / 200, GET /shop/ 200; listed: ${listed.map((p) => `${p.sku} ₹${p.price}`).join(', ')}`, '"coming soon" appears 0 times'];
  });

  await check('k', 'the store notice banner matches the chart value store.notice (or is absent when empty)', async () => {
    const notice = (await kubectl('get', 'configmap', 'wordpress-env', '-n', 'store', '-o', 'jsonpath={.data.STORE_NOTICE}')).trim();
    const home = await getText(`${STORE_URL}/`);
    // WooCommerce prints <p class="woocommerce-store-notice demo_store" ...>TEXT <a ...>Dismiss</a></p>.
    const banner = /<p[^>]*class="woocommerce-store-notice[^"]*"[^>]*>([\s\S]*?)<a /.exec(home)?.[1].trim();
    if (!notice) {
      assert(banner === undefined, `store.notice is empty, but / shows a store notice: "${banner}"`);
      return 'store.notice is empty and / shows no store notice';
    }
    assert(banner !== undefined, 'store.notice is set, but / shows no store notice');
    assert(banner === notice, `the store notice on / says "${banner}", not "${notice}"`);
    return `store notice on /: "${banner}"`;
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
        billing_address: { ...address, email: ORDER_EMAIL },
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
    const sku = KETTLE_SKU;
    const product = await callTool(woo.legacy, 'create_product', { name: 'E2E Test Kettle', regular_price: 149, sku });
    assert(product.regular_price === '149.00' && product.status === 'publish', `created ${JSON.stringify(product)}`);
    state.kettle = product;
    const page = await getText(product.permalink);
    assert(page.includes('E2E Test Kettle') && page.includes('149.00'), 'product page lacks the name or price');
    const shop = await shopHtml();
    assert(shop.includes(product.permalink), 'the new product is not linked from /shop/');
    // A retry (e.g. after a timeout) with the same SKU must not publish a second copy.
    const retry = await woo.modern.callTool({ name: 'create_product', arguments: { name: 'E2E Test Kettle', regular_price: 149, sku } });
    const retryText = retry.content?.[0]?.text ?? '';
    assert(retry.isError && retryText.includes('product_invalid_sku'), `retry with the same SKU: ${retryText}`);
    return [
      `created #${product.id} sku=${sku} regular_price=${product.regular_price} (legacy era)`,
      `GET ${product.permalink} 200 with name and ₹149.00; linked from /shop/`,
      `retry with the same SKU refused: "${retryText}"`,
    ];
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

  await check('c5', 'woo-mcp: get_order, then update_order_status -> completed ("refunded" is refused)', async () => {
    const before = await callTool(woo.modern, 'get_order', { id: state.orderId });
    assert(before.status === 'processing', `status before is ${before.status}`);
    assert(before.payment_method_title === 'Cash on delivery', `payment method ${before.payment_method_title}`);
    // "refunded" would make WooCommerce record a full refund and email the customer; the tool refuses it.
    const refund = await woo.modern.callTool({ name: 'update_order_status', arguments: { id: state.orderId, status: 'refunded' } });
    assert(refund.isError, `status "refunded" was accepted: ${refund.content?.[0]?.text}`);
    const update = await callTool(woo.modern, 'update_order_status', { id: state.orderId, status: 'completed', note: `Delivered (e2e run ${RUN_ID})` });
    assert(update.previous_status === 'processing' && update.status === 'completed' && update.changed, `update returned ${JSON.stringify(update)}`);
    const after = await callTool(woo.legacy, 'get_order', { id: state.orderId });
    assert(after.status === 'completed', `status after is ${after.status}`);
    return [
      `get_order #${before.id} (modern): ${before.status}, ${before.payment_method_title}, ${before.line_items.map((l) => `${l.sku}×${l.quantity}`).join(', ')}, total ₹${before.totals.total}`,
      `update_order_status status=refunded refused: "${(refund.content?.[0]?.text ?? '').slice(0, 120)}"`,
      `update_order_status (modern): ${update.previous_status} -> ${update.status}, note_added=${update.note_added}`,
      `get_order (legacy): ${after.status}, date_completed=${after.date_completed}`,
    ];
  });

  await check('c6', "mcp-bot's REST key reads products but is refused customers, settings and system status", async () => {
    const consumerKey = await readSecret('store', 'woo-store-api', 'consumer-key');
    const consumerSecret = await readSecret('store', 'woo-store-api', 'consumer-secret');
    // Where the signed requests go. Over plain http, through the Ingress like a shopper. An https store (the VPS)
    // is different: behind Traefik WordPress sees https (is_ssl() is true) and WooCommerce then checks the
    // signature with scheme https, while woo-mcp's signer always uses http, because woo-mcp itself only ever talks
    // to WordPress over plain in-cluster HTTP. So for an https store take woo-mcp's own route: a port-forward to the
    // wordpress Service (plain HTTP, is_ssl() false); the signature still carries the public home URL's host.
    let restBase = STORE_URL;
    if (STORE_URL.startsWith('https://')) {
      const forward = await portForward('store', 'wordpress', '/wp-json/');
      cleanups.push(forward.close);
      restBase = forward.url;
    }
    // Read-only GETs only: if the role were wrong, a DELETE test would itself destroy data.
    const signedGet = async (route) => {
      const path = `/wp-json/wc/v3${route}`;
      const { authorization } = signRequest({ method: 'GET', homeUrl: STORE_URL, path, query: [], consumerKey, consumerSecret });
      const res = await fetch(`${restBase}${path}`, { headers: { authorization }, redirect: 'manual' });
      const body = await res.json().catch(() => ({}));
      return { route, status: res.status, code: body.code ?? '' };
    };
    // The positive control proves the signature is right, so the refusals below are about capabilities.
    const products = await signedGet('/products');
    assert(products.status === 200, `GET /products -> ${products.status} ${products.code}`);
    const refused = [];
    for (const route of ['/customers', '/settings', '/system_status']) {
      const r = await signedGet(route);
      assert(r.status === 401 || r.status === 403, `GET ${route} -> ${r.status} ${r.code} (expected 401/403)`);
      refused.push(`${route} ${r.status} ${r.code}`);
    }
    const via = restBase === STORE_URL ? '' : ', via a port-forward to the wordpress Service';
    return [`GET /products 200 (signed as mcp-bot${via})`, `refused: ${refused.join(', ')}`];
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

  // --- (i) immutable code, no PHP from uploads -------------------------------------------------
  await check('i', 'a PHP file in uploads is refused (403), and the code directory is read-only', async () => {
    const uploads = '/srv/wordpress/wp-content/uploads';
    const name = `urumi-e2e-${RUN_ID}.php`;
    // Plant the file the way an arbitrary-upload bug would: as uid 33, the only user that can write there.
    await sh(['kubectl', 'exec', '-i', '-n', 'store', 'deploy/wordpress', '-c', 'wordpress', '--', 'sh', '-c', `cat > ${uploads}/${name}`], {
      input: '<?php echo "urumi-e2e-" . "executed";',
    });
    let probeLine;
    try {
      const res = await fetch(`${STORE_URL}/wp-content/uploads/${name}`, { redirect: 'manual' });
      const body = await res.text();
      assert(!body.includes('urumi-e2e-executed'), 'the uploaded PHP file was EXECUTED');
      assert(!body.includes('<?php'), 'the uploaded PHP file was served as source');
      assert(res.status === 403, `GET /wp-content/uploads/${name} -> ${res.status}`);
      probeLine = `GET /wp-content/uploads/${name} -> 403, neither executed nor shown`;
    } finally {
      await inWordpress('rm', '-f', `${uploads}/${name}`);
    }
    // WooCommerce's own "deny from all" .htaccess must still work under the narrowed AllowOverride.
    const wcLogs = await fetch(`${STORE_URL}/wp-content/uploads/wc-logs/index.html`, { redirect: 'manual' });
    assert(wcLogs.status === 403, `GET /wp-content/uploads/wc-logs/index.html -> ${wcLogs.status}`);
    // The code is on the read-only root filesystem (not on a writable mount) and uid 33 cannot change it.
    const touch = await run(['kubectl', 'exec', '-n', 'store', 'deploy/wordpress', '-c', 'wordpress', '--', 'touch', '/srv/wordpress/urumi-e2e-touch']);
    assert(touch.code !== 0, 'uid 33 could create a file in /srv/wordpress');
    const mounts = (await inWordpress('cat', '/proc/mounts')).split('\n').map((line) => line.split(' '));
    const root = mounts.find((m) => m[1] === '/');
    const docroot = mounts.find((m) => m[1] === '/srv/wordpress');
    assert(!docroot, `/srv/wordpress is a separate mount: ${docroot?.join(' ')}`);
    assert(root?.[3]?.split(',').includes('ro'), `the root filesystem is not read-only: ${root?.join(' ')}`);
    return [
      probeLine,
      'GET /wp-content/uploads/wc-logs/index.html -> 403 (WooCommerce .htaccess still honoured)',
      `/srv/wordpress is on the root filesystem (${root[2]} ${root[3].split(',')[0]}); touch as uid 33 refused`,
    ];
  });

  await check('j', '12 concurrent page views: none stalls on an idle keep-alive connection', async () => {
    const times = await Promise.all(
      Array.from({ length: 12 }, async (_, i) => {
        const started = Date.now();
        const res = await fetch(`${STORE_URL}/?e2e=${RUN_ID}-${i}`);
        await res.text();
        assert(res.status === 200, `GET /?e2e=... -> ${res.status}`);
        return Date.now() - started;
      }),
    );
    times.sort((a, b) => a - b);
    // With Apache keep-alive on, the slowest requests waited the full 5 s KeepAliveTimeout for a worker.
    assert(times.at(-1) < 4000, `slowest page view took ${times.at(-1)} ms`);
    return `12 parallel GET / through Traefik, ms: ${times.join(', ')}`;
  });

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
      '--wait', '--wait-for-jobs', '--timeout', '10m', '--rollback-on-failure'], { timeoutMs: 660_000 });
    const revision = JSON.parse(await sh(['helm', 'status', 'woo-store', '-n', 'store', '-o', 'json'])).version;
    const after = [...(await pods('store', 'app.kubernetes.io/name=wordpress')), ...(await pods('store', 'app.kubernetes.io/name=mariadb'))];
    const same = JSON.stringify(before.map((p) => p.uid).sort()) === JSON.stringify(after.map((p) => p.uid).sort());
    assert(same, `pods changed: ${before.map((p) => p.name)} -> ${after.map((p) => p.name)}`);
    const order = await callTool(woo.modern, 'get_order', { id: state.orderId });
    assert(order.status === 'completed', `order #${state.orderId} is ${order.status}`);
    return [`release woo-store now at revision ${revision}; pods unchanged: ${after.map((p) => p.name).join(', ')}`, `order #${order.id} still ${order.status}`];
  });

  await check('h2', 'WordPress restart keeps products and orders, and does not bring back a seed the merchant trashed', async () => {
    // The merchant trashes a seed product (as from wp-admin; here with WP-CLI in the web container).
    const trashedSku = 'URU-TURM-200';
    const [seed] = (await callTool(woo.legacy, 'list_products', { sku: trashedSku })).products;
    assert(seed, `${trashedSku} not found before the restart`);
    // wp_trash_post() is what wp-admin's "Trash" link calls (`wp post delete` refuses to trash products).
    await inWordpress('wp', 'eval', `if ( ! wp_trash_post( ${seed.id} ) ) { WP_CLI::error( 'could not trash #${seed.id}' ); }`);
    // wp_untrash_post() restores to draft since WP 5.6 unless told to use the previous status.
    const untrash = `add_filter( 'wp_untrash_post_status', 'wp_untrash_post_set_previous_status', 10, 3 ); wp_untrash_post( ${seed.id} );`;
    let restored = false;
    let old;
    let now;
    let seedLine;
    try {
      [old] = await pods('store', 'app.kubernetes.io/name=wordpress');
      await kubectl('rollout', 'restart', 'deploy/wordpress', '-n', 'store');
      await sh(['kubectl', 'rollout', 'status', 'deploy/wordpress', '-n', 'store', '--timeout=300s'], { timeoutMs: 320_000 });
      [now] = await pods('store', 'app.kubernetes.io/name=wordpress');
      assert(now && now.name !== old.name, 'the wordpress pod was not replaced');
      const bootstrapLog = await kubectl('logs', '-n', 'store', now.name, '-c', 'bootstrap');
      // The catalog step logs "created N (...)" only when it creates something.
      seedLine = bootstrapLog.split('\n').find((l) => l.includes('catalog products')) ?? '';
      assert(seedLine && !/\bcreated\b/.test(seedLine), `bootstrap re-seeded: "${seedLine}"`);
      const again = await callTool(woo.legacy, 'list_products', { sku: trashedSku });
      assert(again.count === 0, `the trashed seed ${trashedSku} came back: ${JSON.stringify(again.products)}`);
      await inWordpress('wp', 'eval', untrash);
      restored = true;
    } finally {
      if (!restored) await inWordpress('wp', 'eval', untrash).catch(() => {});
    }
    const shop = await shopHtml();
    assert(seedProductsListed(shop).length === SEED_PRODUCTS.length, 'seed products missing after restart');
    assert(shop.includes(state.kettle.permalink), 'the e2e kettle is missing after restart');
    const order = await callTool(woo.modern, 'get_order', { id: state.orderId });
    assert(order.status === 'completed', `order #${state.orderId} is ${order.status}`);
    const kettle = await callTool(woo.legacy, 'list_products', { sku: state.kettle.sku });
    assert(kettle.count === 1, `kettle lookup by SKU found ${kettle.count}`);
    return [
      `${old.name} -> ${now.name}; bootstrap: "${seedLine.trim()}"`,
      `seed ${trashedSku} (#${seed.id}) trashed before the restart stayed trashed; restored from the trash afterwards`,
      `/shop/ still lists 4 seeds + kettle #${state.kettle.id}; order #${order.id} still ${order.status}`,
    ];
  });
}

/**
 * Deletes this run's product and order(s) with WP-CLI (as an admin-level tool: mcp-bot itself may not delete).
 * Found by SKU and billing email rather than by remembered ids, so a step that failed half-way (product created,
 * response lost) is cleaned up too. The seed products are never matched.
 */
async function removeTestData() {
  const php = `
    $removed = [];
    $id = wc_get_product_id_by_sku(${JSON.stringify(KETTLE_SKU)});
    if ($id && ($p = wc_get_product($id))) { $p->delete(true); $removed[] = "product #$id"; }
    $statuses = array_merge(array_keys(wc_get_order_statuses()), ['trash', 'checkout-draft']);
    foreach (wc_get_orders(['billing_email' => ${JSON.stringify(ORDER_EMAIL)}, 'status' => $statuses, 'limit' => -1, 'return' => 'ids']) as $oid) {
      if ($o = wc_get_order($oid)) { $o->delete(true); $removed[] = "order #$oid"; }
    }
    echo $removed ? implode(', ', $removed) : 'nothing';`;
  const out = await inWordpress('wp', 'eval', php);
  console.log(`\ncleanup: removed ${out.trim()} (SKU ${KETTLE_SKU}, billing ${ORDER_EMAIL})`);
}

try {
  await main();
} catch (err) {
  results.push({ id: 'setup', ok: false });
  console.log(`FAIL (setup) ${err instanceof Error ? err.message : String(err)}`);
} finally {
  for (const cleanup of cleanups.reverse()) await Promise.resolve().then(cleanup).catch(() => {});
  await removeTestData().catch((err) => {
    results.push({ id: 'cleanup', ok: false });
    console.log(`FAIL (cleanup) could not remove this run's test data: ${err instanceof Error ? err.message : String(err)}`);
  });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `; failed: ${failed.map((r) => r.id).join(', ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
