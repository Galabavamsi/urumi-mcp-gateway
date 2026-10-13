/**
 * Demo-only switches. Both are OFF unless explicitly set to "true". They exist to show failure modes
 * in the gateway demo, never to change normal behaviour:
 *  - slowTool:           adds a `slow_lookup` tool that sleeps, to demonstrate the gateway's per-call timeout.
 *  - poisonedDescription: appends a manipulative instruction to one tool description, to demonstrate
 *                         the "untrusted upstream / tool poisoning" threat from the threat model.
 */
export interface DemoSwitches {
  slowTool: boolean;
  poisonedDescription: boolean;
}

export interface Config {
  port: number;
  /** Bearer token the gateway must send on /mcp (Secret `supplier-mcp-auth`, key `token`). */
  authToken: string;
  /** Optional JSON catalog file; the built-in catalog is used when unset. */
  catalogPath?: string;
  demo: DemoSwitches;
}

export const DEMO_OFF: DemoSwitches = { slowTool: false, poisonedDescription: false };

/**
 * Reads configuration from environment variables. Throws with a clear message on anything invalid,
 * so a misconfigured pod crash-loops with the reason in its logs instead of half-working.
 */
export function readConfig(env: Record<string, string | undefined>): Config {
  const authToken = env.MCP_AUTH_TOKEN ?? '';
  // A short shared secret is guessable; scripts/secrets.sh generates 64 hex characters.
  if (authToken.length < 16) throw new Error('MCP_AUTH_TOKEN must be set (at least 16 characters)');

  const port = Number(env.PORT ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`PORT must be 1-65535, got "${env.PORT}"`);

  return {
    port,
    authToken,
    catalogPath: env.CATALOG_PATH || undefined,
    demo: {
      slowTool: flag(env, 'DEMO_SLOW_TOOL'),
      poisonedDescription: flag(env, 'DEMO_POISONED_DESCRIPTION'),
    },
  };
}

/** Strict boolean: only "true"/"false" (or unset). A typo like "ture" fails instead of silently meaning false. */
function flag(env: Record<string, string | undefined>, name: string): boolean {
  const value = (env[name] ?? '').trim().toLowerCase();
  if (value === '' || value === 'false') return false;
  if (value === 'true') return true;
  throw new Error(`${name} must be "true" or "false", got "${env[name]}"`);
}
