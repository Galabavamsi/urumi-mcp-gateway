// The dashboard's REST API under /api. CSRF guard and a body limit apply to everything; each route group adds its
// own session/admin checks (public: login, logout and the invite link pages).
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { createChatRoutes, type ChatDeps } from '../chat/index.ts';
import { csrfGuard, requireSession } from '../auth/middleware.ts';
import type { StatsCollector } from '../stats/collector.ts';
import type { AppEnv } from '../types.ts';
import { auditRoutes } from './auditRoutes.ts';
import { authRoutes } from './authRoutes.ts';
import type { ApiDeps } from './deps.ts';
import { errorBody, handleApiError } from './errors.ts';
import { inviteRoutes } from './inviteRoutes.ts';
import { keyRoutes } from './keyRoutes.ts';
import { policyRoutes } from './policyRoutes.ts';
import { serverRoutes } from './serverRoutes.ts';
import { statsRoutes } from './statsRoutes.ts';
import { userRoutes } from './userRoutes.ts';

export function createApiApp(deps: ApiDeps, chat: ChatDeps, stats: StatsCollector): Hono<AppEnv> {
  const api = new Hono<AppEnv>();

  api.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store'); // API answers are per user; no proxy or browser cache may keep them
    c.header('X-Content-Type-Options', 'nosniff');
  });
  api.use('*', csrfGuard);
  // Small bodies everywhere; the chat transcript (resent each turn) gets more room.
  const tooLarge = (limit: string) => (c: Context) => c.json(errorBody('payload_too_large', `request body over ${limit}`), 413);
  const defaultLimit = bodyLimit({ maxSize: 64 * 1024, onError: tooLarge('64 KB') });
  const chatLimit = bodyLimit({ maxSize: 512 * 1024, onError: tooLarge('512 KB') });
  api.use('*', (c, next) => (c.req.path.startsWith('/api/chat') ? chatLimit(c, next) : defaultLimit(c, next)));

  api.route('/auth', authRoutes(deps));
  api.route('/invites', inviteRoutes(deps));
  api.route('/users', userRoutes(deps));
  api.route('/keys', keyRoutes(deps));
  api.route('/servers', serverRoutes(deps));
  api.route('/policies', policyRoutes(deps));
  api.route('/audit', auditRoutes(deps));
  api.route('/stats', statsRoutes(deps, stats));

  api.get('/config', requireSession(deps.sessions, deps.config.cookieSecure), (c) =>
    c.json({
      mcpUrl: `${deps.config.publicBaseUrl}/mcp`,
      storeUrl: deps.config.storeUrl,
      model: deps.config.llmModel,
      storeTz: deps.config.storeTz,
    }),
  );

  // The chat agent (src/chat, its own module) behind the same session + CSRF checks as everything else.
  // ('/chat/*' also matches '/chat' itself.)
  api.use('/chat/*', requireSession(deps.sessions, deps.config.cookieSecure));
  api.route('/chat', createChatRoutes(chat));

  api.notFound((c) => c.json(errorBody('not_found', 'no such API route'), 404));
  api.onError(handleApiError);
  return api;
}
