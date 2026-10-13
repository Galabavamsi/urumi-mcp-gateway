#!/usr/bin/env node
// The brief's Definition of Done, end to end, against the live local cluster (run scripts/dev-up.sh first).
// Two users, created by this script through the real invite flow:
//   A = asha@urumi.test   (admin)  uses the dashboard chat: real Claude Haiku through POST /api/chat (SSE)
//   B = bharat@urumi.test (member) uses external MCP clients with nothing but the gateway URL and an API key:
//       the MCP TypeScript SDK in both protocol eras, and the real Claude Code CLI when it is installed
//
// Checks (each prints PASS / FAIL / SKIP with its evidence):
//   d1  the dashboard SPA is served, the API answers, the bootstrap admin logs in
//   d2  the admin invites A (admin) and B (member); both accept; an invite link works only once
//   d3  GET /api/servers lists woo, supplier, firecrawl, mail (woo first), connected
//   d4  B's key, both protocol eras: every server's tools under <server>__ names (the two list_products don't
//       collide); woo__create_product and mail__send_message are hidden from B (member policy), a call is refused
//   d5  a storefront guest Cash-on-Delivery order (the "by hand" order, placed via the Store API) is visible to B
//   d6  A's chat: "Create a product named 'DoD Test Lamp' priced 349" -> woo__create_product -> on the storefront
//   d7  a COD order for the lamp; A's chat: "What orders came in today?" -> woo__list_orders, names that order
//   d7b A's chat: "Mark that order as completed" -> the agent pauses (confirm_required) before woo__update_order_status;
//       nothing changes until A approves; after approval the order is completed
//   d8  B: woo__list_orders {date:"today"} returns both orders; one flow over two upstreams (supplier, then woo)
//   d9  B in Claude Code (claude -p, gateway URL + B's key only) answers a question needing supplier AND woo
//   d10 A revokes B's key -> B's next MCP request gets HTTP 401; audited as auth_rejected under B
//   d11 A disables supplier -> B (listening) gets tools/list_changed and loses supplier__*, so does A's chat;
//       calls are refused while disabled; re-enabled -> the tools come back
//   d12 supplier scaled to 0 -> Unreachable with a reason within 12 s while woo keeps working; back to 1 ->
//       connected within 20 s; GET /api/stats (Observability page) shows the outage with its reason
//   d13 supplier pod deleted -> replacement Ready, supplier connected and callable within 20 s
//   d14 audit: every call above is in the log under the right user and channel (mcp / chat) with the right status
//   z   cleanup: nothing this run created is left behind
//
// Usage, from the repo root (Windows or Linux):
//   node scripts/e2e-dod.mjs                    everything, about 2-3 minutes
//   node scripts/e2e-dod.mjs --keep-users       leave A and B active afterwards, for a manual demo
//   node scripts/e2e-dod.mjs --no-claude-code   skip d9
// On Windows, kubectl runs inside WSL (wsl.exe -d Ubuntu --exec ...). Exit code 0 = every check passed.
// Cost: four short Claude Haiku chat turns (about one US cent) and, for d9, one Claude Code prompt.
//
// The defaults are the local k3d cluster. To run against another deployment (e.g. the VPS, docs/VPS.md):
//   E2E_APP_URL       the dashboard/gateway, e.g. https://app.urumi.humanslop.in  (default http://app.127-0-0-1.sslip.io;
//                     the older name APP_URL still works)
//   E2E_STORE_URL     the storefront, e.g. https://store.urumi.humanslop.in        (default http://store.127-0-0-1.sslip.io;
//                     the older name STORE_URL still works)
//   E2E_KUBE_CONTEXT  kubectl context, e.g. urumi-vps                              (default: the current context)
//   E2E_KUBECONFIG    kubeconfig file, e.g. /home/<you>/.kube/urumi-vps.yaml       (default: kubectl's own default)
//   E2E_WSL=0         run kubectl directly even on Windows                         (default: through WSL on Windows)
// Against another deployment the accounts note is notes/demo-accounts.<app host>.md, so the local one is kept.
//
// Secrets: the bootstrap admin's credentials are read with kubectl into memory. A's and B's passwords are
// generated here and written only to notes/demo-accounts.local.md (gitignored, private vault); API keys exist only
// in memory (and, for d9, in a temporary MCP config file deleted right after). Nothing secret is printed.
//
// Cleanup runs at the end (also after a failure) and once at the start (so a run killed half-way cannot break the
// next one): products named "DoD Test Lamp" and orders billed to dod-e2e@example.test are deleted with WP-CLI in
// the WordPress pod; A and B, with their keys, invites, sessions and audit rows, are deleted from the gateway's
// Postgres. That is a test-harness privilege: the product itself only ever DISABLES users, so that audit history
// always stays attributable. The supplier server is re-enabled and scaled back to 1 replica.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const LOCAL_APP_URL = 'http://app.127-0-0-1.sslip.io';
const APP_URL = (process.env.E2E_APP_URL ?? process.env.APP_URL ?? LOCAL_APP_URL).replace(/\/+$/, '');
const STORE_URL = (process.env.E2E_STORE_URL ?? process.env.STORE_URL ?? 'http://store.127-0-0-1.sslip.io').replace(/\/+$/, '');
const WSL_DISTRO = process.env.WSL_DISTRO ?? 'Ubuntu';
const USE_WSL = process.platform === 'win32' && process.env.E2E_WSL !== '0';
// Flags that pin every kubectl call to one cluster. Empty by default: the current context.
const KUBECTL_FLAGS = [
  ...(process.env.E2E_KUBECONFIG ? ['--kubeconfig', process.env.E2E_KUBECONFIG] : []),
  ...(process.env.E2E_KUBE_CONTEXT ? ['--context', process.env.E2E_KUBE_CONTEXT] : []),
];
const KEEP_USERS = process.argv.includes('--keep-users');
const SKIP_CLAUDE_CODE = process.argv.includes('--no-claude-code');
const RUN_ID = Date.now().toString(36);
// One private note per deployment, so a run against the VPS never overwrites the local accounts.
const ACCOUNTS_NOTE = APP_URL === LOCAL_APP_URL ? 'demo-accounts.local.md' : `demo-accounts.${new URL(APP_URL).hostname}.md`;
const ACCOUNTS_FILE = fileURLToPath(new URL(`../notes/${ACCOUNTS_NOTE}`, import.meta.url));

const USER_A = { label: 'A', email: 'asha@urumi.test', name: 'Asha (DoD admin)', role: 'admin' };
const USER_B = { label: 'B', email: 'bharat@urumi.test', name: 'Bharat (DoD member)', role: 'member' };
const LAMP = { name: 'DoD Test Lamp', price: 349 };
/** Every guest order this script places is billed to this address, which is how the cleanup finds them. */
const ORDER_EMAIL = 'dod-e2e@example.test';
const SEED_SLUGS = ['woo', 'supplier', 'firecrawl', 'mail'];
const SUPPLIER_SELECTOR = 'app.kubernetes.io/name=supplier-mcp';

// ---------------------------------------------------------------------------------------------------
// Tiny check runner (same shape as scripts/e2e-store.mjs)
// ---------------------------------------------------------------------------------------------------
const results = [];

/** Thrown by a check that cannot run here (e.g. no Claude Code CLI); counted as skipped, not failed. */
class Skip extends Error {}

async function check(id, title, fn) {
  const started = Date.now();
  try {
    const evidence = await fn();
    results.push({ id, ok: true });
    console.log(`PASS (${id}) ${title}  [${((Date.now() - started) / 1000).toFixed(1)}s]`);
    for (const line of [evidence].flat().filter(Boolean)) console.log(`       ${line}`);
  } catch (err) {
    if (err instanceof Skip) {
      results.push({ id, ok: true, skipped: true });
      console.log(`SKIP (${id}) ${title}: ${err.message}`);
      return;
    }
    results.push({ id, ok: false });
    console.log(`FAIL (${id}) ${title}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Polls `probe` until it returns something truthy; returns that value and the seconds it took. */
async function waitFor(what, probe, timeoutMs, intervalMs = 500) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await probe();
      if (value) return { value, seconds: (Date.now() - started) / 1000 };
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  const why = lastError instanceof Error ? ` (last error: ${lastError.message})` : '';
  throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}${why}`);
}

const short = (text, max = 160) => (text.length > max ? `${text.slice(0, max)}…` : text).replace(/\s+/g, ' ');

// ---------------------------------------------------------------------------------------------------
// kubectl, WP-CLI and psql (inside WSL when running on Windows)
// ---------------------------------------------------------------------------------------------------
/**
 * On Windows the cluster tools live in WSL. `--exec` runs the program without a shell, so arguments arrive as-is.
 * A kubectl call also gets the E2E_KUBECONFIG / E2E_KUBE_CONTEXT flags (none by default).
 */
function inCluster(argv) {
  const pinned = argv[0] === 'kubectl' ? ['kubectl', ...KUBECTL_FLAGS, ...argv.slice(1)] : argv;
  return USE_WSL ? ['wsl.exe', ['-d', WSL_DISTRO, '--exec', ...pinned]] : [pinned[0], pinned.slice(1)];
}

/** Runs a program; never rejects on a non-zero exit (the caller decides), only when it cannot start at all. */
function run(file, args, { input = '', timeoutMs = 120_000, cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // wsl.exe writes its own messages as UTF-16; drop the NUL bytes so they stay readable.
      resolve({ code, stdout: stdout.replaceAll('\0', ''), stderr: stderr.replaceAll('\0', '') });
    });
    child.stdin.end(input);
  });
}

async function sh(argv, options) {
  const [file, args] = inCluster(argv);
  const { code, stdout, stderr } = await run(file, args, options);
  if (code !== 0) throw new Error(`${argv.slice(0, 3).join(' ')} exited ${code}: ${stderr.trim().slice(0, 400)}`);
  return stdout;
}

const kubectl = (...args) => sh(['kubectl', ...args]);

/** Reads one Secret key into memory (go-template, because jsonpath cannot address dashed keys). Never logged. */
async function readSecret(namespace, name, key) {
  const value = await kubectl('get', 'secret', '-n', namespace, name, '-o', `go-template={{index .data "${key}" | base64decode}}`);
  assert(value, `Secret ${namespace}/${name} has no key ${key}`);
  return value;
}

/** Runs PHP inside WordPress with WP-CLI, in the web container (uid 33, as wp-admin itself would act). */
const wpEval = (php) => kubectl('exec', '-n', 'store', 'deploy/wordpress', '-c', 'wordpress', '--', 'wp', 'eval', php);

/** Runs SQL on the gateway's database over the pod-local socket (no password needed there; never over the network). */
const psql = (sql) =>
  kubectl('exec', '-n', 'platform', 'postgres-0', '-c', 'postgres', '--', 'psql', '-U', 'gateway', '-d', 'gateway', '-v', 'ON_ERROR_STOP=1', '-tAq', '-c', sql);

async function supplierPods() {
  const list = JSON.parse(await kubectl('get', 'pods', '-n', 'mcp-upstreams', '-l', SUPPLIER_SELECTOR, '-o', 'json'));
  return list.items.map((pod) => ({
    name: pod.metadata.name,
    terminating: Boolean(pod.metadata.deletionTimestamp),
    ready: (pod.status.conditions ?? []).some((c) => c.type === 'Ready' && c.status === 'True'),
  }));
}

const scaleSupplier = (replicas) => kubectl('scale', 'deploy/supplier-mcp', '-n', 'mcp-upstreams', `--replicas=${replicas}`);

// ---------------------------------------------------------------------------------------------------
// The gateway's REST API, as the dashboard uses it
// ---------------------------------------------------------------------------------------------------
/** A browser-like dashboard session: keeps the urumi_session cookie and sends the CSRF header on every write. */
class Session {
  cookie = null;
  user = null;

  constructor(label) {
    this.label = label;
  }

  async request(method, path, body) {
    const headers = { accept: 'application/json' };
    if (this.cookie) headers.cookie = this.cookie;
    if (method !== 'GET') headers['x-urumi-csrf'] = '1'; // docs/API.md: required on every non-GET /api request
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${APP_URL}/api${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
    const sessionCookie = res.headers.getSetCookie().find((c) => c.startsWith('urumi_session='));
    if (sessionCookie) this.cookie = sessionCookie.split(';')[0];
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    return { status: res.status, body: json };
  }

  /** Like request(), but anything other than 2xx throws with the gateway's error code (bodies are never logged). */
  async ok(method, path, body) {
    const res = await this.request(method, path, body);
    if (res.status < 200 || res.status > 299) {
      const error = res.body?.error ?? {};
      throw new Error(`${this.label}: ${method} /api${path} -> ${res.status} ${error.code ?? ''} ${error.message ?? ''}`.trim());
    }
    return res.body;
  }

  async login(email, password) {
    const { user } = await this.ok('POST', '/auth/login', { email, password });
    this.user = user;
    return user;
  }
}

const servers = (session) => session.ok('GET', '/servers');
const serverBySlug = async (session, slug) => (await servers(session)).find((s) => s.slug === slug);

/** Every audit row matching the query (follows the nextBefore cursor, at most 5 pages of 200). */
async function auditRows(session, query = {}) {
  const items = [];
  let before;
  for (let page = 0; page < 5; page++) {
    const params = new URLSearchParams({ ...query, limit: '200', ...(before ? { before: String(before) } : {}) });
    const body = await session.ok('GET', `/audit?${params}`);
    items.push(...body.items);
    if (!body.nextBefore) break;
    before = body.nextBefore;
  }
  return items;
}

// ---------------------------------------------------------------------------------------------------
// MCP, as an external client sees the gateway
// ---------------------------------------------------------------------------------------------------
/** mode "legacy" = the 2025-11-25 initialize handshake; "auto" = negotiates the stateless 2026-07-28 era. */
async function connectMcp(apiKey, mode) {
  const client = new Client({ name: 'urumi-dod-e2e', version: '1.0.0' }, { versionNegotiation: { mode } });
  const transport = new StreamableHTTPClientTransport(new URL(`${APP_URL}/mcp`), { authProvider: { token: async () => apiKey } });
  await client.connect(transport);
  return client;
}

const firstText = (result) => result.content?.find((c) => c.type === 'text')?.text ?? '';
const toolNames = async (client) => (await client.listTools()).tools.map((t) => t.name).sort();

/** Calls a tool and returns its data; an isError result throws with the tool's own message. */
async function callOk(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name} returned an error: ${firstText(result)}`);
  return result.structuredContent ?? JSON.parse(firstText(result));
}

/** A raw POST to /mcp, to see the HTTP status a caller gets before any MCP processing. */
async function rawMcpStatus(apiKey) {
  const res = await fetch(`${APP_URL}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'urumi-dod-e2e', version: '1.0.0' } },
    }),
  });
  await res.body?.cancel();
  return { status: res.status, wwwAuthenticate: res.headers.get('www-authenticate') };
}

// ---------------------------------------------------------------------------------------------------
// Chat (Server-Sent Events, docs/API.md "Chat")
// ---------------------------------------------------------------------------------------------------
/** Parses an SSE byte stream into {event, data} objects (data is JSON in our protocol). */
async function* readSse(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
    let end;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let event = 'message';
      const data = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        // lines starting with ':' are comments / keep-alives
      }
      if (data.length > 0) yield { event, data: JSON.parse(data.join('\n')) };
    }
  }
}

/** One chat turn as the dashboard sends it: the visible transcript in, a stream of events out. */
async function chat(session, messages) {
  return chatRequest(session, { messages });
}

/** The answer to an approval request (confirm_required): only its id and yes/no; the reply continues. */
async function answerApproval(session, id, approve) {
  return chatRequest(session, { confirm: { id, approve } });
}

async function chatRequest(session, body) {
  const started = Date.now();
  const res = await fetch(`${APP_URL}/api/chat`, {
    method: 'POST',
    headers: { cookie: session.cookie, 'content-type': 'application/json', accept: 'text/event-stream', 'x-urumi-csrf': '1' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180_000),
  });
  if (res.status !== 200) throw new Error(`POST /api/chat -> ${res.status} ${short(await res.text())}`);
  assert((res.headers.get('content-type') ?? '').includes('text/event-stream'), `content-type ${res.headers.get('content-type')}`);
  const turn = { tools: null, calls: [], texts: [], confirm: null, done: null, error: null };
  for await (const { event, data } of readSse(res.body)) {
    if (event === 'tools') turn.tools = data;
    else if (event === 'text') turn.texts.push(data.text);
    else if (event === 'tool_call') turn.calls.push({ id: data.id, name: data.name, args: data.args });
    else if (event === 'tool_result') {
      // After an approval the stream continues with tool_result for calls announced in the PREVIOUS request.
      const call = turn.calls.find((c) => c.id === data.id);
      if (call) Object.assign(call, data);
      else turn.calls.push({ ...data });
    }
    else if (event === 'confirm_required') turn.confirm = data;
    else if (event === 'done') turn.done = data;
    else if (event === 'error') turn.error = data.message;
  }
  turn.text = turn.texts.join('\n');
  turn.seconds = (Date.now() - started) / 1000;
  assert(!turn.error, `the chat stream sent an error event: ${turn.error}`);
  assert(turn.done, 'the chat stream ended without a done event');
  assert(turn.tools, 'the chat stream sent no tools event');
  return turn;
}

const describeCalls = (turn) =>
  turn.calls.map((c) => `${c.name}${c.ok === undefined ? ' (no result)' : c.ok ? ` ok ${c.durationMs} ms` : ' FAILED'}`).join(', ') || 'no tool calls';
const describeTurn = (turn) =>
  `${turn.done.iterations} model call(s), stop=${turn.done.stopReason}, ${turn.done.usage.inputTokens}/${turn.done.usage.outputTokens} tokens, ${turn.seconds.toFixed(1)} s`;

// ---------------------------------------------------------------------------------------------------
// Storefront (Store API: what the checkout page itself calls)
// ---------------------------------------------------------------------------------------------------
const STORE_API = `${STORE_URL}/wp-json/wc/store/v1`;

/** A guest Cash-on-Delivery checkout, exactly as the storefront does it. Returns the WooCommerce order id. */
async function placeGuestOrder(productId, quantity, note) {
  // A guest cart is identified by the Cart-Token header; writes also need the Store API Nonce.
  const cartRes = await fetch(`${STORE_API}/cart`);
  await cartRes.text();
  const headers = {
    'content-type': 'application/json',
    nonce: cartRes.headers.get('nonce') ?? '',
    'cart-token': cartRes.headers.get('cart-token') ?? '',
  };
  assert(headers.nonce && headers['cart-token'], 'GET /cart returned no Nonce / Cart-Token headers');
  const add = await fetch(`${STORE_API}/cart/add-item`, { method: 'POST', headers, body: JSON.stringify({ id: productId, quantity }) });
  const cart = await add.json();
  assert(add.status === 200 || add.status === 201, `add-item -> ${add.status} ${short(JSON.stringify(cart))}`);

  const address = {
    first_name: 'Dee', last_name: 'Oday', company: '', address_1: '7 Brigade Road', address_2: '',
    city: 'Bengaluru', state: 'KA', postcode: '560025', country: 'IN', phone: '9000000001',
  };
  const res = await fetch(`${STORE_API}/checkout`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ billing_address: { ...address, email: ORDER_EMAIL }, shipping_address: address, payment_method: 'cod', customer_note: note }),
  });
  const order = await res.json();
  assert(res.status === 200, `checkout -> ${res.status} ${short(JSON.stringify(order), 300)}`);
  assert(order.status === 'processing', `order status ${order.status}, expected processing`);
  return order.order_id;
}

async function storeProductBySku(sku) {
  const [product] = await (await fetch(`${STORE_API}/products?sku=${encodeURIComponent(sku)}`)).json();
  return product;
}

async function storeProductsByName(name) {
  const found = await (await fetch(`${STORE_API}/products?search=${encodeURIComponent(name)}&per_page=50`)).json();
  return found.filter((p) => p.name === name);
}

// ---------------------------------------------------------------------------------------------------
// Cleanup of everything this script creates
// ---------------------------------------------------------------------------------------------------
/** Deletes every "DoD Test Lamp" product and every order billed to ORDER_EMAIL. The seed products never match. */
async function removeStoreTestData() {
  const php = `
    $removed = [];
    $lamps = get_posts(['post_type' => 'product', 'title' => ${JSON.stringify(LAMP.name)}, 'numberposts' => -1,
      'post_status' => ['publish', 'draft', 'private', 'pending', 'trash'], 'fields' => 'ids']);
    foreach ($lamps as $id) {
      if (($p = wc_get_product($id)) && !str_starts_with($p->get_sku(), 'URU-')) { $p->delete(true); $removed[] = "product #$id"; }
    }
    $statuses = array_merge(array_keys(wc_get_order_statuses()), ['trash', 'checkout-draft']);
    foreach (wc_get_orders(['billing_email' => ${JSON.stringify(ORDER_EMAIL)}, 'status' => $statuses, 'limit' => -1, 'return' => 'ids']) as $id) {
      if ($o = wc_get_order($id)) { $o->delete(true); $removed[] = "order #$id"; }
    }
    echo $removed ? implode(', ', $removed) : 'nothing';`;
  return (await wpEval(php)).trim();
}

/**
 * Deletes A and B from the gateway database, with what references them. Test-harness only: the product has no
 * hard delete for users (PATCH status=disabled), so that audit rows always keep pointing at a real user.
 */
async function deleteDemoUsers() {
  const emails = [USER_A.email, USER_B.email].map((e) => `'${e}'`).join(', '); // constants above, never input
  const out = await psql(`
    BEGIN;
    CREATE TEMP TABLE dod_users ON COMMIT DROP AS SELECT id FROM users WHERE email IN (${emails});
    DELETE FROM audit_log WHERE user_id IN (SELECT id FROM dod_users)
      OR api_key_id IN (SELECT id FROM api_keys WHERE user_id IN (SELECT id FROM dod_users));
    UPDATE api_keys SET created_by = NULL WHERE created_by IN (SELECT id FROM dod_users);
    DELETE FROM api_keys WHERE user_id IN (SELECT id FROM dod_users);
    UPDATE invites SET created_by = NULL WHERE created_by IN (SELECT id FROM dod_users);
    DELETE FROM invites WHERE email IN (${emails});
    DELETE FROM users WHERE id IN (SELECT id FROM dod_users);
    SELECT count(*) FROM dod_users;
    COMMIT;`);
  return Number(out.trim().split('\n').pop());
}

/** The private accounts note (gitignored notes/ vault). Passwords are listed only while the accounts exist. */
async function writeAccountsFile(status, passwords) {
  const rows = [USER_A, USER_B].map(
    (u) => `| ${u.label} | ${u.email} | ${u.role} | ${passwords ? `\`${passwords[u.label]}\`` : '(deleted)'} |`,
  );
  const content = `---
tags: [private, demo]
updated: ${new Date().toISOString()}
---
# Demo accounts (written by scripts/e2e-dod.mjs, run ${RUN_ID})

> Private: this file is gitignored (notes/). Never commit, paste or screenshot these passwords.

**Status:** ${status}

| User | Email | Role | Password |
|---|---|---|---|
${rows.join('\n')}

- Dashboard: ${APP_URL}/ (log in with the email and password above)
- MCP URL for Claude Code / Cursor: ${APP_URL}/mcp (create an API key on the dashboard's "My API keys" page)
- Bootstrap admin: Secret platform/gateway-bootstrap-admin (from .env), not listed here
- Keep the accounts after a run: \`node scripts/e2e-dod.mjs --keep-users\`
`;
  await writeFile(ACCOUNTS_FILE, content, { mode: 0o600 });
}

// ---------------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------------
const state = {}; // values later checks need from earlier ones
const clients = []; // MCP clients to close at the end
const sessions = { admin: new Session('admin'), A: new Session('A'), B: new Session('B') };
const passwords = { A: randomBytes(18).toString('base64url'), B: randomBytes(18).toString('base64url') };

async function main() {
  console.log(`Urumi Definition-of-Done e2e, run ${RUN_ID}: app ${APP_URL}, store ${STORE_URL}\n`);
  const precleaned = await removeStoreTestData();
  const preDeleted = await deleteDemoUsers();
  console.log(`pre-clean: store test data removed: ${precleaned}; leftover demo users removed: ${preDeleted}\n`);

  const { admin, A, B } = sessions;

  await check('d1', 'dashboard SPA served, API answers, bootstrap admin logs in', async () => {
    const home = await fetch(`${APP_URL}/`);
    const html = await home.text();
    assert(home.status === 200 && html.includes('id="root"'), `GET / -> ${home.status}, no React root`);
    const csp = home.headers.get('content-security-policy') ?? '';
    assert(csp.includes("default-src 'self'"), `CSP header: ${csp || 'missing'}`);
    const deepLink = await fetch(`${APP_URL}/servers`);
    assert(deepLink.status === 200 && (await deepLink.text()).includes('id="root"'), `GET /servers -> ${deepLink.status} (SPA fallback)`);
    const anonymous = await new Session('anonymous').request('GET', '/auth/me');
    assert(anonymous.status === 401, `GET /api/auth/me without a session -> ${anonymous.status}`);

    const email = await readSecret('platform', 'gateway-bootstrap-admin', 'email');
    const password = await readSecret('platform', 'gateway-bootstrap-admin', 'password');
    const user = await admin.login(email, password);
    assert(user.role === 'admin', `bootstrap user has role ${user.role}`);
    const me = await admin.ok('GET', '/auth/me');
    assert(me.user.id === user.id, '/api/auth/me returned someone else');
    const config = await admin.ok('GET', '/config');
    assert(config.mcpUrl === `${APP_URL}/mcp`, `config.mcpUrl ${config.mcpUrl}`);
    state.config = config;
    return [
      `GET / 200 (SPA, CSP "${short(csp, 60)}"), GET /servers 200 (SPA fallback), /api/auth/me without session 401`,
      `bootstrap admin logged in (role admin); /api/config: mcpUrl ${config.mcpUrl}, model ${config.model}, storeTz ${config.storeTz}`,
    ];
  });

  await check('d2', 'admin invites A (admin) and B (member); both accept; the link is single-use', async () => {
    assert(admin.user, 'no admin session (d1 failed)');
    const lines = [];
    for (const [who, spec] of [['A', USER_A], ['B', USER_B]]) {
      const invite = await admin.ok('POST', '/invites', { email: spec.email, role: spec.role });
      const token = new URL(invite.inviteUrl).pathname.split('/').pop(); // the link the admin would share; never printed
      const preview = await new Session('link').ok('GET', `/invites/${token}`);
      assert(preview.email === spec.email && preview.role === spec.role, `invite preview ${JSON.stringify(preview)}`);
      const accepted = await sessions[who].ok('POST', `/invites/${token}/accept`, { name: spec.name, password: passwords[who] });
      sessions[who].user = accepted.user;
      assert(accepted.user.role === spec.role && accepted.user.email === spec.email, `accepted as ${JSON.stringify(accepted.user)}`);
      const me = await sessions[who].ok('GET', '/auth/me');
      assert(me.user.id === accepted.user.id, `${who}: the cookie from accepting is not a session`);
      const reused = await new Session('link').request('GET', `/invites/${token}`);
      assert(reused.status === 404, `${who}: the used invite link still answers ${reused.status}`);
      lines.push(`${who} = ${spec.email} (${spec.role}): invited by the admin, accepted, signed in by the accept response; link reuse -> 404`);
    }
    await writeAccountsFile('in use by a running e2e-dod.mjs (deleted when it ends unless --keep-users)', passwords);
    // A's own sign-in also works with the generated password (the dashboard's login form path).
    const fresh = new Session('A-login');
    await fresh.login(USER_A.email, passwords.A);
    await fresh.ok('POST', '/auth/logout');
    lines.push(`passwords generated and stored only in notes/${ACCOUNTS_NOTE} (gitignored); A's password login works`);
    return lines;
  });

  await check('d3', 'GET /api/servers: woo, supplier, firecrawl, mail (woo first), connected', async () => {
    assert(A.user, 'no session for A (d2 failed)');
    // Right after a gateway restart a server can still be "connecting"; give the health loop a moment.
    const { value: list } = await waitFor(
      'the in-cluster servers to be connected',
      async () => {
        const all = await servers(A);
        const local = all.filter((s) => s.slug === 'woo' || s.slug === 'supplier');
        return local.length === 2 && local.every((s) => s.status === 'connected') ? all : null;
      },
      30_000,
    );
    const slugs = list.map((s) => s.slug);
    assert(JSON.stringify(slugs.filter((s) => SEED_SLUGS.includes(s))) === JSON.stringify(SEED_SLUGS), `order: ${slugs.join(', ')}`);
    state.servers = Object.fromEntries(list.map((s) => [s.slug, s]));
    // The hosted upstreams need their keys in .env and internet access. Without them the core still works, so a
    // missing one is reported (and its tools are not required in d4), not failed.
    state.externalUp = {};
    const notes = [];
    for (const slug of ['firecrawl', 'mail']) {
      state.externalUp[slug] = state.servers[slug].status === 'connected';
      if (!state.externalUp[slug]) notes.push(`NOTE: ${slug} is ${state.servers[slug].status} (${state.servers[slug].statusReason}); needs its key in .env and internet access`);
    }
    return [
      ...list.map(
        (s) => `${s.slug}: ${s.status} (${s.protocolEra ?? 'era ?'}), auth ${s.authType}${s.hasCredential ? ' with stored credential' : ''}, ` +
          `${s.tools.filter((t) => t.exposed).length}/${s.tools.length} tools exposed${s.toolAllowlist ? ' (allowlist)' : ''}`,
      ),
      ...notes,
    ];
  });

  await check('d4', "B's API key in both MCP eras: every server's tools, prefixed; woo__create_product hidden and refused", async () => {
    assert(B.user, 'no session for B (d2 failed)');
    state.keyB1 = await B.ok('POST', '/keys', { name: `dod-e2e ${RUN_ID}` });
    assert(state.keyB1.key.startsWith('mgw_'), 'the new key has the wrong shape');
    const lines = [`B created key ${state.keyB1.prefix} (full key shown once, kept in memory only)`];
    for (const mode of ['auto', 'legacy']) {
      const client = await connectMcp(state.keyB1.key, mode);
      clients.push(client);
      const era = client.getProtocolEra();
      assert(era === (mode === 'auto' ? 'modern' : 'legacy'), `${mode}: negotiated era ${era}`);
      const names = await toolNames(client);
      const must = ['woo__list_orders', 'woo__list_products', 'supplier__list_products', 'supplier__check_stock'];
      const missing = must.filter((n) => !names.includes(n));
      assert(missing.length === 0, `${era}: missing ${missing.join(', ')}`);
      if (state.externalUp?.firecrawl) assert(names.some((n) => n.startsWith('firecrawl__')), `${era}: no firecrawl__ tools`);
      // Member policy: no store writes and no email from the team address (customer data + an outbound channel).
      for (const hidden of ['woo__create_product', 'woo__update_order_status', 'mail__send_message']) {
        assert(!names.includes(hidden), `${era}: ${hidden} is listed for member B`);
      }
      assert(names.every((n) => /^[a-z][a-z0-9-]*__[A-Za-z0-9_-]+$/.test(n) && n.length <= 48), `${era}: a tool name breaks the naming rule`);
      if (mode === 'auto') state.clientB1 = client;
      const examples = ['woo__list_products', 'supplier__list_products', names.find((n) => n.startsWith('firecrawl__')), names.find((n) => n.startsWith('mail__'))];
      lines.push(`${mode} client -> era ${era}: ${names.length} tools, e.g. ${examples.filter(Boolean).join(', ')}`);
    }
    const refused = await state.clientB1.callTool({ name: 'woo__create_product', arguments: { name: 'Should not exist', regular_price: 1 } }).then(
      (r) => `answered (isError=${Boolean(r.isError)}): ${firstText(r)}`,
      (err) => `refused: ${err.message}`,
    );
    assert(refused.startsWith('refused') && /not permitted/.test(refused), `woo__create_product as B: ${refused}`);
    lines.push(`hidden for B: woo__create_product, woo__update_order_status, mail__send_message; calling woo__create_product -> ${short(refused, 110)}`);
    return lines;
  });

  await check('d5', "a storefront guest COD order (the 'by hand' order) is visible to B through woo", async () => {
    assert(state.clientB1, 'no MCP client for B (d4 failed)');
    const chai = await storeProductBySku('URU-CHAI-250');
    assert(chai?.id, 'seed product URU-CHAI-250 not found through the Store API');
    state.handOrderId = await placeGuestOrder(chai.id, 2, `DoD e2e ${RUN_ID}: placed like a shopper would`);
    const order = await callOk(state.clientB1, 'woo__get_order', { id: state.handOrderId });
    assert(order.status === 'processing' && order.payment_method_title === 'Cash on delivery', `order ${order.status} / ${order.payment_method_title}`);
    state.handOrderNumber = order.number;
    return [
      `Store API checkout (cart -> add-item -> checkout, payment cod) -> order #${order.number}, status ${order.status}`,
      `B: woo__get_order #${order.number} -> ${order.line_items.map((l) => `${l.name} × ${l.quantity}`).join(', ')}, ₹${order.totals.total}, ${order.payment_method_title}`,
    ];
  });

  await check('d6', `A's chat creates "${LAMP.name}" for ₹${LAMP.price} (woo__create_product) and it shows on the storefront`, async () => {
    assert(A.user, 'no session for A (d2 failed)');
    const ask = `Create a product named '${LAMP.name}' priced ${LAMP.price}.`;
    let turn = await chat(A, [{ role: 'user', content: ask }]);
    const lines = [`turn 1: tools ${turn.tools.count} (incl. woo__create_product: ${turn.tools.names.includes('woo__create_product')}); calls: ${describeCalls(turn)}; ${describeTurn(turn)}`];
    assert(turn.tools.names.includes('woo__create_product'), 'admin A does not get woo__create_product');
    if (turn.confirm) {
      lines.push(`paused for approval of ${turn.confirm.calls.map((c) => c.name).join(', ')}; approving`);
      turn = await answerApproval(A, turn.confirm.id, true);
    }
    let created = turn.calls.find((c) => c.name === 'woo__create_product' && c.ok);
    if (!created) {
      // The agent may ask before a write (its prompt allows that when details are unclear): answer like a user would.
      turn = await chat(A, [
        { role: 'user', content: ask },
        { role: 'assistant', content: turn.text || '(no reply)' },
        { role: 'user', content: 'Yes, please create it now.' },
      ]);
      lines.push(`turn 2 (after "Yes, please create it now."): calls: ${describeCalls(turn)}; ${describeTurn(turn)}`);
      created = turn.calls.find((c) => c.name === 'woo__create_product' && c.ok);
    }
    assert(created, `no successful woo__create_product call; reply: ${short(turn.text, 300)}`);
    const product = JSON.parse(created.preview);
    assert(product.name === LAMP.name && Number(product.regular_price) === LAMP.price, `created ${short(created.preview, 200)}`);
    state.lampId = product.id;

    const [listed] = await storeProductsByName(LAMP.name);
    assert(listed, `"${LAMP.name}" not found through the storefront's Store API`);
    const price = Number(listed.prices.price) / 10 ** listed.prices.currency_minor_unit;
    assert(price === LAMP.price, `storefront price ${price}`);
    const page = await fetch(listed.permalink);
    const pageHtml = await page.text();
    assert(page.status === 200 && pageHtml.includes(LAMP.name), `GET ${listed.permalink} -> ${page.status}`);
    lines.push(
      `tool_call woo__create_product args ${short(JSON.stringify(created.args), 120)} -> ok in ${created.durationMs} ms: product #${product.id}`,
      `storefront: Store API lists "${listed.name}" at ₹${price}; GET ${listed.permalink} -> 200 with the name`,
      `assistant: "${short(turn.text, 200)}"`,
    );
    return lines;
  });

  await check('d7', `a COD order for the lamp; A's chat "What orders came in today?" calls woo__list_orders and names it`, async () => {
    assert(state.lampId, 'no lamp product (d6 failed)');
    state.lampOrderId = await placeGuestOrder(state.lampId, 1, `DoD e2e ${RUN_ID}: one lamp`);
    const turn = await chat(A, [{ role: 'user', content: 'What orders came in today?' }]);
    const listCall = turn.calls.find((c) => c.name === 'woo__list_orders' && c.ok);
    assert(listCall, `no successful woo__list_orders call (calls: ${describeCalls(turn)}); reply: ${short(turn.text, 300)}`);
    const number = String(state.lampOrderId);
    assert(new RegExp(`(^|\\D)${number}(\\D|$)`).test(turn.text), `the reply does not mention order ${number}: ${short(turn.text, 400)}`);
    return [
      `lamp order #${number} placed (guest, COD) through the Store API`,
      `chat calls: ${describeCalls(turn)} with args ${short(JSON.stringify(listCall.args), 100)}; ${describeTurn(turn)}`,
      `assistant: "${short(turn.text, 260)}"`,
    ];
  });

  await check('d7b', "A's chat asks before a destructive tool: woo__update_order_status waits for approval, then runs", async () => {
    assert(state.lampOrderId, 'no lamp order (d7 failed)');
    const ask = `Mark order #${state.lampOrderId} as completed.`;
    let turn = await chat(A, [{ role: 'user', content: ask }]);
    const lines = [`turn 1: calls: ${describeCalls(turn)}; ${describeTurn(turn)}`];
    if (!turn.confirm) {
      // The agent may first ask in words; answer like a user would.
      turn = await chat(A, [
        { role: 'user', content: ask },
        { role: 'assistant', content: turn.text || '(no reply)' },
        { role: 'user', content: 'Yes, please do it now.' },
      ]);
      lines.push(`turn 2: calls: ${describeCalls(turn)}; ${describeTurn(turn)}`);
    }
    assert(turn.confirm && turn.done.stopReason === 'needs_confirmation', `no approval request; reply: ${short(turn.text, 200)}`);
    const gated = turn.confirm.calls.find((c) => c.name === 'woo__update_order_status');
    assert(gated, `the approval request is for ${turn.confirm.calls.map((c) => c.name).join(', ')}`);
    assert(turn.calls.every((c) => c.ok === undefined || c.name !== 'woo__update_order_status'), 'the gated call ran before approval');
    const before = await callOk(state.clientB1, 'woo__get_order', { id: state.lampOrderId });
    assert(before.status !== 'completed', `order is already ${before.status} before the approval`);
    lines.push(`confirm_required for woo__update_order_status ${short(JSON.stringify(gated.args), 80)}; order still "${before.status}"`);

    const approved = await answerApproval(A, turn.confirm.id, true);
    const ran = approved.calls.find((c) => c.name === 'woo__update_order_status');
    assert(ran?.ok, `after approval: calls ${describeCalls(approved)}; reply ${short(approved.text, 200)}`);
    const after = await callOk(state.clientB1, 'woo__get_order', { id: state.lampOrderId });
    assert(after.status === 'completed', `order status after approval: ${after.status}`);
    const reused = await fetch(`${APP_URL}/api/chat`, {
      method: 'POST',
      headers: { cookie: A.cookie, 'content-type': 'application/json', 'x-urumi-csrf': '1' },
      body: JSON.stringify({ confirm: { id: turn.confirm.id, approve: true } }),
    });
    await reused.text();
    assert(reused.status === 404, `answering the same approval twice -> HTTP ${reused.status}`);
    lines.push(
      `approved: woo__update_order_status ok in ${ran.durationMs} ms; order #${state.lampOrderId} now "${after.status}"; ${describeTurn(approved)}`,
      `the same approval id a second time -> HTTP 404 (single use); assistant: "${short(approved.text, 160)}"`,
    );
    return lines;
  });

  await check('d8', "B: today's orders over MCP; one flow over two upstreams (supplier, then woo)", async () => {
    assert(state.clientB1, 'no MCP client for B (d4 failed)');
    const today = await callOk(state.clientB1, 'woo__list_orders', { date: 'today' });
    const ids = today.orders.map((o) => o.id);
    for (const [what, id] of [['hand-placed', state.handOrderId], ['lamp', state.lampOrderId]]) {
      if (id) assert(ids.includes(id), `the ${what} order #${id} is not in today's list (${ids.join(', ')})`);
    }
    // Two upstreams in one flow: what does the supplier offer that our store does not sell yet?
    const catalog = await callOk(state.clientB1, 'supplier__list_products');
    const store = await callOk(state.clientB1, 'woo__list_products', { per_page: 50 });
    const ours = new Set(store.products.map((p) => p.name.toLowerCase()));
    const notSold = catalog.products.filter((p) => !ours.has(p.name.toLowerCase()));
    return [
      `woo__list_orders {date:"today"}: window ${today.window.from} .. ${today.window.to} (${today.window.timezone}); ${today.count} order(s): ${today.orders.map((o) => `#${o.number} ${o.status} ₹${o.total}`).join(', ')}`,
      `supplier__list_products: ${catalog.count} items; woo__list_products: ${store.count} products; supplier items not in our store: ${notSold.length} (e.g. ${notSold.slice(0, 2).map((p) => p.name).join('; ')})`,
    ];
  });

  await check('d9', 'B in Claude Code (gateway URL + B\'s key only) answers a question that needs supplier and woo', async () => {
    if (SKIP_CLAUDE_CODE) throw new Skip('--no-claude-code');
    assert(state.keyB1, 'no API key for B (d4 failed)');
    const version = await run('claude', ['--version'], { timeoutMs: 20_000 }).then((r) => (r.code === 0 ? r.stdout.trim() : null), () => null);
    if (!version) throw new Skip('the claude CLI is not installed on this machine');
    const [{ id: auditMark } = { id: 0 }] = (await A.ok('GET', '/audit?limit=1')).items;

    // The same thing user B does with `claude mcp add --transport http urumi <url> --header "Authorization: Bearer <key>"`,
    // as a throwaway config file: only this server (--strict-mcp-config), no built-in tools (--tools ""), no web.
    const dir = await mkdtemp(join(tmpdir(), 'urumi-dod-'));
    const configFile = join(dir, 'mcp.json');
    try {
      const config = { mcpServers: { urumi: { type: 'http', url: `${APP_URL}/mcp`, headers: { Authorization: `Bearer ${state.keyB1.key}` } } } };
      await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
      const prompt =
        'Use the urumi MCP tools. First get the supplier catalog (supplier__list_products), then our own store products ' +
        '(woo__list_products). Which supplier products do we not sell yet? Answer with a short list: name and supplier unit cost in ₹.';
      // A nested Claude Code refuses to start when it thinks it runs inside another session's terminal.
      const env = { ...process.env };
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_ENTRYPOINT;
      const out = await run(
        'claude',
        ['-p', prompt, '--mcp-config', configFile, '--strict-mcp-config', '--tools', '', '--allowedTools', 'mcp__urumi',
          '--disallowedTools', 'WebFetch', 'WebSearch', '--output-format', 'stream-json', '--verbose', '--no-session-persistence'],
        { cwd: dir, env, timeoutMs: 300_000 },
      );
      const events = out.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l));
      const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
      const result = events.find((e) => e.type === 'result');
      assert(result, `claude exited ${out.code} without a result: ${short(out.stderr || out.stdout, 300)}`);
      assert(!result.is_error, `claude reported an error: ${short(String(result.result ?? result.subtype), 300)}`);
      const server = init?.mcp_servers?.find((s) => s.name === 'urumi');
      assert(server?.status === 'connected', `Claude Code's urumi server status: ${server?.status ?? 'missing'}`);
      const gatewayTools = (init.tools ?? []).filter((t) => t.startsWith('mcp__urumi__'));
      const used = events
        .filter((e) => e.type === 'assistant')
        .flatMap((e) => e.message?.content ?? [])
        .filter((b) => b.type === 'tool_use')
        .map((b) => b.name.replace('mcp__urumi__', ''));
      for (const tool of ['supplier__list_products', 'woo__list_products']) assert(used.includes(tool), `Claude Code did not call ${tool} (called: ${used.join(', ')})`);
      // The gateway saw those calls as B, via mcp, with B's key.
      const rows = (await auditRows(A, { userId: B.user.id })).filter((r) => r.id > auditMark && r.status === 'ok');
      for (const tool of ['supplier__list_products', 'woo__list_products']) {
        assert(rows.some((r) => r.exposedName === tool && r.via === 'mcp' && r.apiKeyPrefix === state.keyB1.prefix), `no audit row for B's ${tool} from Claude Code`);
      }
      return [
        `${version}: MCP server "urumi" ${server.status}; ${gatewayTools.length} gateway tools offered (e.g. ${gatewayTools.slice(0, 3).join(', ')})`,
        `tool calls in order: ${used.join(' -> ')}; ${result.num_turns} turns, ${(result.duration_ms / 1000).toFixed(1)} s`,
        `audit: ${rows.length} new ok row(s) for B via mcp with key ${state.keyB1.prefix}`,
        `answer: "${short(String(result.result), 300)}"`,
      ];
    } finally {
      // The file held B's key. On Windows the claude process can hold its working directory for a moment after it
      // exits (EBUSY), so let rm retry instead of failing the check (and leaving the key file behind).
      await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
  });

  await check('d10', "A revokes B's key -> B's next MCP request is HTTP 401; audited as auth_rejected under B", async () => {
    assert(state.keyB1 && state.clientB1, 'no key/client for B (d4 failed)');
    await A.ok('DELETE', `/keys/${state.keyB1.id}`);
    const raw = await rawMcpStatus(state.keyB1.key);
    assert(raw.status === 401, `raw POST /mcp with the revoked key -> ${raw.status}`);
    assert(raw.wwwAuthenticate === 'Bearer error="invalid_token"', `WWW-Authenticate: ${raw.wwwAuthenticate}`);
    const sdk = await state.clientB1.listTools().then(() => 'listed tools', (err) => `rejected (${err.constructor.name})`);
    assert(sdk.startsWith('rejected'), `B's already-connected client still ${sdk}`);
    const { value: rows } = await waitFor(
      'an auth_rejected audit row for B',
      async () => {
        const items = await auditRows(A, { userId: B.user.id, status: 'auth_rejected' });
        return items.length > 0 ? items : null;
      },
      5_000,
    );
    assert(rows[0].userEmail === USER_B.email && rows[0].apiKeyPrefix === state.keyB1.prefix, `audit row ${JSON.stringify(rows[0])}`);
    const keys = await A.ok('GET', `/keys?userId=${B.user.id}`);
    assert(keys.find((k) => k.id === state.keyB1.id)?.revokedAt, 'the key is not marked revoked');
    return [
      `DELETE /api/keys/${state.keyB1.prefix} by admin A -> 204`,
      `raw POST /mcp -> 401, WWW-Authenticate: ${raw.wwwAuthenticate}; B's connected SDK client: next tools/list ${sdk}`,
      `audit: ${rows.length} auth_rejected row(s) for ${rows[0].userEmail}, key ${rows[0].apiKeyPrefix}, error "${rows[0].error}"`,
    ];
  });

  await check('d11', "A disables supplier -> B gets list_changed and loses supplier__*, so does A's chat; re-enable restores", async () => {
    assert(state.servers?.supplier, 'supplier not known (d3 failed)');
    state.keyB2 = await B.ok('POST', '/keys', { name: `dod-e2e ${RUN_ID} second` });
    const listener = await connectMcp(state.keyB2.key, 'auto');
    clients.push(listener);
    state.clientB2 = listener;
    let changes = 0;
    listener.setNotificationHandler('notifications/tools/list_changed', () => {
      changes += 1;
    });
    // Pass the filter itself (wrapping it in {notifications: ...} silently subscribes to nothing).
    const subscription = await listener.listen({ toolsListChanged: true });
    try {
      assert((await toolNames(listener)).includes('supplier__list_products'), 'supplier tools missing before the test');
      const id = state.servers.supplier.id;
      state.supplierDisabled = true;
      const patched = await A.ok('PATCH', `/servers/${id}`, { enabled: false });
      assert(patched.enabled === false && patched.status === 'disabled', `PATCH -> enabled ${patched.enabled}, status ${patched.status}`);
      const pushed = await waitFor('notifications/tools/list_changed', async () => changes > 0, 5_000, 100);
      const without = await toolNames(listener);
      assert(!without.some((n) => n.startsWith('supplier__')), 'supplier__ tools still listed after the push');
      const refused = await listener.callTool({ name: 'supplier__list_products', arguments: {} }).then(
        (r) => `answered: ${firstText(r)}`,
        (err) => `refused: ${err.message}`,
      );
      assert(refused.startsWith('refused') && /disabled/.test(refused), `supplier__list_products while disabled: ${refused}`);
      const turn = await chat(A, [{ role: 'user', content: 'Reply with just the word OK.' }]);
      assert(!turn.tools.names.some((n) => n.startsWith('supplier__')), `A's chat still offers ${turn.tools.names.filter((n) => n.startsWith('supplier__')).join(', ')}`);
      assert(turn.tools.names.includes('woo__list_orders'), "A's chat lost the woo tools too");

      const enabled = await A.ok('PATCH', `/servers/${id}`, { enabled: true });
      state.supplierDisabled = false;
      const back = await waitFor('supplier tools back for B', async () => (await toolNames(listener)).includes('supplier__list_products'), 20_000);
      const before = changes;
      await waitFor('a second list_changed push', async () => changes >= 2, 5_000, 100).catch(() => null);
      return [
        `PATCH /api/servers/supplier {enabled:false} -> status ${patched.status}; B's listen stream got list_changed after ${pushed.seconds.toFixed(1)} s`,
        `B re-lists: ${without.length} tools, no supplier__*; supplier__list_products -> ${short(refused, 100)}`,
        `A's chat tools event (${turn.tools.count} tools): no supplier__*, woo__* still there`,
        `re-enabled (status ${enabled.status}) -> supplier__* back for B after ${back.seconds.toFixed(1)} s; list_changed pushes: ${Math.max(before, changes)}`,
      ];
    } finally {
      await subscription.close().catch(() => {});
      // If a step above failed, don't leave supplier disabled for the checks that follow.
      if (state.supplierDisabled) {
        await A.ok('PATCH', `/servers/${state.servers.supplier.id}`, { enabled: true }).catch(() => {});
        state.supplierDisabled = false;
      }
    }
  });

  await check('d12', 'supplier scaled to 0 -> Unreachable (with reason) in <= 12 s, woo still works; back to 1 -> connected in <= 20 s', async () => {
    assert(state.clientB2, 'no MCP client for B (d11 failed)');
    await waitFor('supplier connected before the test', async () => (await serverBySlug(A, 'supplier'))?.status === 'connected', 20_000);
    state.supplierScaledDown = true;
    await scaleSupplier(0);
    const down = await waitFor(
      'supplier to show as unreachable',
      async () => {
        const s = await serverBySlug(A, 'supplier');
        return s?.status === 'unreachable' ? s : null;
      },
      12_000,
      250,
    );
    assert(down.value.statusReason, 'unreachable without a reason');
    const woo = await serverBySlug(A, 'woo');
    assert(woo.status === 'connected', `woo is ${woo.status} while supplier is down`);
    const orders = await callOk(state.clientB2, 'woo__list_orders', { date: 'today' });
    const started = Date.now();
    const failed = await state.clientB2.callTool({ name: 'supplier__list_products', arguments: {} });
    const failMs = Date.now() - started;
    assert(failed.isError && /unreachable/.test(firstText(failed)) && failMs < 3_000, `supplier call while down: ${firstText(failed)} (${failMs} ms)`);

    await scaleSupplier(1);
    state.supplierScaledDown = false;
    const scaledAt = Date.now();
    const ready = await waitFor('a Ready supplier pod', async () => (await supplierPods()).some((p) => p.ready && !p.terminating), 60_000);
    const up = await waitFor('supplier connected again', async () => (await serverBySlug(A, 'supplier'))?.status === 'connected', 30_000, 250);
    const upSeconds = (Date.now() - scaledAt) / 1000;
    assert(upSeconds <= 20, `connected only ${upSeconds.toFixed(1)} s after scaling back up`);
    await callOk(state.clientB2, 'supplier__list_products');
    // The Observability page's data (GET /api/stats, admins only): the outage is in supplier's status history
    // with its reason, and B's fail-fast call above is counted as unreachable.
    const stats = (await A.ok('GET', '/stats')).servers.find((s) => s.slug === 'supplier');
    const outage = stats?.transitions.find((t) => t.from === 'connected' && t.to === 'unreachable');
    assert(outage?.reason, 'GET /api/stats shows no connected -> unreachable transition with a reason for supplier');
    assert(stats.window.errors.unreachable >= 1, `GET /api/stats counted ${stats.window.errors.unreachable} unreachable supplier calls`);
    return [
      `replicas=0 -> dashboard status unreachable after ${down.seconds.toFixed(1)} s, reason "${down.value.statusReason}"`,
      `GET /api/stats: transition connected -> unreachable "${outage.reason}" at ${outage.at}; window errors.unreachable=${stats.window.errors.unreachable}`,
      `meanwhile: woo ${woo.status}; B's woo__list_orders ok (${orders.count} today); B's supplier__list_products -> isError "${short(firstText(failed), 80)}" in ${failMs} ms`,
      `replicas=1 -> pod Ready after ${ready.seconds.toFixed(1)} s, gateway status connected ${upSeconds.toFixed(1)} s after the scale-up; B's supplier call ok`,
    ];
  });

  await check('d13', 'supplier pod deleted -> replacement Ready; connected and callable again in <= 20 s', async () => {
    assert(state.clientB2, 'no MCP client for B (d11 failed)');
    const [old] = (await supplierPods()).filter((p) => p.ready && !p.terminating);
    assert(old, 'no Ready supplier pod before the test');
    await kubectl('delete', 'pod', '-n', 'mcp-upstreams', old.name, '--wait=false');
    const deletedAt = Date.now();
    const seen = new Set();
    const { seconds } = await waitFor(
      'the replacement pod Ready, supplier connected and callable',
      async () => {
        const s = await serverBySlug(A, 'supplier');
        seen.add(s.status);
        const pods = await supplierPods();
        if (!pods.some((p) => p.name !== old.name && p.ready && !p.terminating)) return false;
        if (s.status !== 'connected') return false;
        await callOk(state.clientB2, 'supplier__list_products');
        return true;
      },
      20_000,
    );
    return [
      `deleted ${old.name}; replacement Ready, gateway connected and B's supplier__list_products ok ${((Date.now() - deletedAt) / 1000).toFixed(1)} s later (waited ${seconds.toFixed(1)} s)`,
      `statuses seen on /api/servers meanwhile: ${[...seen].join(' -> ')}`,
    ];
  });

  await check('d14', 'audit: every call above under the right user and channel, with the right status', async () => {
    assert(A.user && B.user, 'no users (d2 failed)');
    const bRows = await auditRows(A, { userId: B.user.id });
    const aRows = await auditRows(A, { userId: A.user.id });
    const has = (rows, exposedName, status, via) =>
      rows.some((r) => (exposedName === null || r.exposedName === exposedName) && r.status === status && r.via === via);
    const expectations = [
      [bRows, 'woo__get_order', 'ok', 'mcp'],
      [bRows, 'woo__list_orders', 'ok', 'mcp'],
      [bRows, 'supplier__list_products', 'ok', 'mcp'],
      [bRows, 'woo__list_products', 'ok', 'mcp'],
      [bRows, 'woo__create_product', 'denied', 'mcp'],
      [bRows, 'supplier__list_products', 'denied', 'mcp'],
      [bRows, 'supplier__list_products', 'unreachable', 'mcp'],
      [bRows, null, 'auth_rejected', 'mcp'],
      [aRows, 'woo__create_product', 'ok', 'chat'],
      [aRows, 'woo__list_orders', 'ok', 'chat'],
      [aRows, 'woo__update_order_status', 'ok', 'chat'],
    ];
    const missing = expectations.filter(([rows, ...want]) => !has(rows, ...want)).map(([, ...want]) => want.join('/'));
    assert(missing.length === 0, `missing audit rows: ${missing.join(', ')}`);
    assert(bRows.every((r) => r.userEmail === USER_B.email && r.via === 'mcp' && r.apiKeyPrefix?.startsWith('mgw_')), "a row of B's is not B / mcp / keyed");
    assert(aRows.every((r) => r.userEmail === USER_A.email && r.via === 'chat' && r.apiKeyPrefix === null), "a row of A's is not A / chat");
    assert(bRows.every((r) => r.status !== 'pending') && aRows.every((r) => r.status !== 'pending'), 'a call is still pending');
    // A member sees only their own rows, even when asking for someone else's.
    const own = await auditRows(B);
    const sneaky = await auditRows(B, { userId: A.user.id });
    assert(own.length === bRows.length && own.every((r) => r.userId === B.user.id), `B's own view: ${own.length} rows vs ${bRows.length}`);
    assert(sneaky.every((r) => r.userId === B.user.id), "B's ?userId=<A> query returned A's rows");
    const tally = (rows) => Object.entries(Object.groupBy(rows, (r) => r.status)).map(([s, list]) => `${s} ${list.length}`).join(', ');
    return [
      `B (${USER_B.email}, via mcp, keys ${[...new Set(bRows.map((r) => r.apiKeyPrefix))].join(' + ')}): ${bRows.length} rows: ${tally(bRows)}`,
      `A (${USER_A.email}, via chat, no key): ${aRows.length} rows: ${tally(aRows)}`,
      `B's own /api/audit returns only B's ${own.length} rows; ?userId=<A> is ignored for a member`,
    ];
  });
}

// ---------------------------------------------------------------------------------------------------
// Run, then always clean up
// ---------------------------------------------------------------------------------------------------
async function cleanup() {
  const report = [];
  const step = async (what, fn) => {
    try {
      const outcome = await fn();
      if (outcome) report.push(`${what}: ${outcome}`);
    } catch (err) {
      report.push(`${what}: FAILED (${err instanceof Error ? err.message : String(err)})`);
    }
  };
  for (const client of clients) await client.close().catch(() => {});

  await step('supplier replicas', async () => {
    if (state.supplierScaledDown) await scaleSupplier(1);
    const replicas = (await kubectl('get', 'deploy/supplier-mcp', '-n', 'mcp-upstreams', '-o', 'jsonpath={.spec.replicas}')).trim();
    if (replicas !== '1') {
      await scaleSupplier(1);
      return `restored to 1 (was ${replicas})`;
    }
    return state.supplierScaledDown ? 'restored to 1' : null;
  });
  await step('supplier enabled', async () => {
    const operator = sessions.admin.user ? sessions.admin : null;
    if (!operator) return null;
    const supplier = await serverBySlug(operator, 'supplier');
    if (supplier && !supplier.enabled) {
      await operator.ok('PATCH', `/servers/${supplier.id}`, { enabled: true });
      return 're-enabled';
    }
    return null;
  });
  await step('store test data', removeStoreTestData);
  if (KEEP_USERS) {
    await step('API keys', async () => {
      const revoked = [];
      for (const key of [state.keyB1, state.keyB2].filter(Boolean)) {
        await sessions.admin.ok('DELETE', `/keys/${key.id}`);
        revoked.push(key.prefix);
      }
      return revoked.length ? `revoked ${revoked.join(', ')}` : null;
    });
    await step('accounts', async () => {
      await writeAccountsFile(`kept active after run ${RUN_ID} (--keep-users); API keys revoked`, passwords);
      return `A and B kept; passwords in ${ACCOUNTS_FILE}`;
    });
  } else {
    await step('demo users (with keys, sessions, invites, audit rows)', async () => `${await deleteDemoUsers()} deleted`);
    await step('accounts file', async () => {
      await writeAccountsFile(`deleted at the end of run ${RUN_ID}; passwords discarded. Run with --keep-users to keep them.`, null);
      return null;
    });
  }
  await step('admin session', async () => {
    if (sessions.admin.cookie) await sessions.admin.request('POST', '/auth/logout');
    return null;
  });

  // Prove it: nothing of this run is left.
  await step('verify', async () => {
    const lamps = await storeProductsByName(LAMP.name);
    assert(lamps.length === 0, `${lamps.length} "${LAMP.name}" product(s) still on the storefront`);
    const orders = (await wpEval(`echo count(wc_get_orders(['billing_email' => ${JSON.stringify(ORDER_EMAIL)}, 'limit' => -1, 'return' => 'ids', 'status' => array_keys(wc_get_order_statuses())]));`)).trim();
    assert(orders === '0', `${orders} test order(s) left`);
    const users = (await psql(`SELECT count(*) FROM users WHERE email IN ('${USER_A.email}', '${USER_B.email}')`)).trim();
    assert(users === (KEEP_USERS ? '2' : '0'), `${users} demo user(s) in the gateway database`);
    const replicas = (await kubectl('get', 'deploy/supplier-mcp', '-n', 'mcp-upstreams', '-o', 'jsonpath={.spec.replicas}')).trim();
    assert(replicas === '1', `supplier replicas ${replicas}`);
    return `no lamp products, no test orders, ${users} demo users, supplier at 1 replica`;
  });
  const failed = report.some((line) => line.includes('FAILED'));
  console.log(`${failed ? 'FAIL' : 'PASS'} (z) cleanup: nothing this run created is left behind`);
  for (const line of report) console.log(`       ${line}`);
  results.push({ id: 'z', ok: !failed });
}

try {
  await main();
} catch (err) {
  results.push({ id: 'setup', ok: false });
  console.log(`FAIL (setup) ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await cleanup();
}

const failed = results.filter((r) => !r.ok);
const skipped = results.filter((r) => r.skipped);
console.log(
  `\n${results.length - failed.length}/${results.length} checks passed` +
    `${skipped.length ? ` (${skipped.length} skipped: ${skipped.map((r) => r.id).join(', ')})` : ''}` +
    `${failed.length ? `; failed: ${failed.map((r) => r.id).join(', ')}` : ''}`,
);
process.exit(failed.length ? 1 : 0);
