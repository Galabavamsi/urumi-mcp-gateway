// MANUAL live check, never run in CI: the real Anthropic API drives this chat module against the fake
// gateway MCP server (one demo__get_time tool). Proves that the real model calls a tool through our
// loop and answers from its result, and prints the token usage. Costs a fraction of a cent on Haiku.
//
// Run from apps/gateway (Node 24 runs the TypeScript directly):
//   node --env-file=<path to the repo's .env> src/chat/live-smoke.ts
// It needs ANTHROPIC_API_KEY in the environment and never prints it. LLM_MODEL defaults to claude-haiku-5-5.
import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import type { AppEnv } from '../types.ts';
import { createChatRoutes } from './index.ts';
import { startFakeToolServer } from './testing/fake-tool-server.ts';
import { eventsNamed, parseSse } from './testing/sse.ts';

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error('ANTHROPIC_API_KEY is not set (pass --env-file=<path to .env>)');
  process.exit(1);
}
const model = process.env.LLM_MODEL || 'claude-haiku-5-5';
const question = 'What is the exact local time in Tokyo right now? Check it with a tool.';

const token = randomBytes(24).toString('hex'); // the fake server accepts only this bearer
const gateway = await startFakeToolServer(token);
try {
  const app = new Hono<AppEnv>();
  app.use('*', async (c, next) => {
    c.set('user', { id: 'smoke-user', email: 'smoke@example.test', name: 'Smoke Test', role: 'admin' });
    await next();
  });
  app.route('/api/chat', createChatRoutes({ internalMcpUrl: gateway.url, signChatToken: async () => token, anthropicApiKey: apiKey, model, storeTz: 'Asia/Kolkata' }));

  console.log(`model: ${model}\nquestion: ${question}\n`);
  const started = performance.now();
  const res = await app.request('/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: question }] }),
  });
  const events = parseSse(await res.text());
  for (const { event, data } of events) console.log(`${event}: ${JSON.stringify(data)}`);
  console.log(`\nwall time: ${Math.round(performance.now() - started)} ms`);

  const calledTool = eventsNamed(events, 'tool_call').some((call) => call.name === 'demo__get_time');
  const toolOk = eventsNamed(events, 'tool_result').some((result) => result.ok);
  const answered = eventsNamed(events, 'text').length > 0;
  const done = eventsNamed(events, 'done')[0];
  const passed = res.status === 200 && calledTool && toolOk && answered && done?.stopReason === 'end_turn';
  console.log(passed ? '\nSMOKE PASS: the real model called demo__get_time and answered' : '\nSMOKE FAIL');
  process.exitCode = passed ? 0 : 1;
} finally {
  await gateway.stop();
}
