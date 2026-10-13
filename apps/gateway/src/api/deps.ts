// Everything the REST routes need, built once in src/gateway.ts and passed in (no globals, easy to fake in tests).
import type { AuditLog } from '../audit/auditLog.ts';
import type { LoginThrottle } from '../auth/loginThrottle.ts';
import type { SessionStore } from '../auth/sessions.ts';
import type { Config } from '../config.ts';
import type { SecretBox } from '../crypto/secretBox.ts';
import type { Db } from '../db/client.ts';
import type { OpenStreams } from '../mcp/openStreams.ts';
import type { ToolRouter } from '../mcp/toolRouter.ts';
import type { Resolver } from '../security/ssrf.ts';
import type { UpstreamManager } from '../upstreams/manager.ts';

export interface ApiDeps {
  db: Db;
  config: Config;
  sessions: SessionStore;
  loginThrottle: LoginThrottle;
  secretBox: SecretBox;
  manager: UpstreamManager;
  router: ToolRouter;
  audit: AuditLog;
  streams: OpenStreams;
  /** Tell MCP clients holding a listen stream that their tool list may have changed. */
  notifyToolsChanged: () => void;
  /** Re-read tool policies from the database into the router. */
  reloadPolicies: () => Promise<void>;
  /** DNS resolver for the SSRF guard (tests inject a fake one). */
  resolveHost?: Resolver;
}
