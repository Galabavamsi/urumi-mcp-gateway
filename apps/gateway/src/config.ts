// Gateway configuration, read once at startup from environment variables (docs/CONTRACTS.md "gateway environment").
// Everything is validated here so a bad deployment fails fast with a clear message instead of misbehaving later.
import { z } from 'zod';

const port = z.coerce.number().int().min(1).max(65535);
/** Internal secrets are random strings from scripts/secrets.sh (64 hex chars); refuse anything guessably short. */
const secret = z.string().min(32, 'must be at least 32 characters');
const flag = z.enum(['true', 'false']).transform((value) => value === 'true');
const commaList = z
  .string()
  .transform((value) => value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean));

const EnvSchema = z.object({
  PORT: port.default(8080),
  INTERNAL_MCP_PORT: port.default(8081),
  METRICS_PORT: port.default(9091),

  PGHOST: z.string().min(1),
  PGPORT: port.default(5432),
  PGDATABASE: z.string().min(1),
  PGUSER: z.string().min(1),
  PGPASSWORD: z.string().min(1),

  API_KEY_PEPPER: secret,
  CREDENTIALS_KEY: z
    .string()
    .transform((value) => Buffer.from(value, 'base64'))
    .refine((key) => key.length === 32, 'must be base64 of exactly 32 bytes (AES-256 key)'),
  CHAT_JWT_KEY: secret,
  SESSION_SECRET: secret,

  BOOTSTRAP_ADMIN_EMAIL: z.email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().optional(),

  ANTHROPIC_API_KEY: z.string().default(''),
  LLM_MODEL: z.string().min(1).default('claude-haiku-5-5'),
  PUBLIC_BASE_URL: z.url().transform((url) => url.replace(/\/+$/, '')),
  /** Optional: the storefront URL shown in /api/config. Defaults to PUBLIC_BASE_URL with `app.` swapped for `store.`. */
  STORE_URL: z.url().optional(),
  COOKIE_SECURE: flag.default(false),
  STORE_TZ: z.string().min(1).default('Asia/Kolkata'),
  /** The shop's name as the chat agent should call it; keep it equal to the woo-store chart's store.name. */
  STORE_NAME: z.string().trim().min(1).max(100).default('Kaveri & Co.'),

  SEED_SERVERS_FILE: z.string().optional(),
  INTERNAL_HOST_ALLOWLIST: commaList.default([]),
  HEALTH_INTERVAL_MS: z.coerce.number().int().min(1000).max(600_000).default(5000),
  DEFAULT_CALL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(10_000),
});

export type Env = z.infer<typeof EnvSchema>;

export interface Config {
  port: number;
  internalMcpPort: number;
  metricsPort: number;
  db: { host: string; port: number; database: string; user: string; password: string };
  apiKeyPepper: string;
  credentialsKey: Buffer;
  chatJwtKey: string;
  sessionSecret: string;
  bootstrapAdmin: { email: string; password: string } | null;
  anthropicApiKey: string;
  llmModel: string;
  publicBaseUrl: string;
  storeUrl: string;
  cookieSecure: boolean;
  storeTz: string;
  storeName: string;
  seedServersFile: string | null;
  internalHostAllowlist: string[];
  healthIntervalMs: number;
  defaultCallTimeoutMs: number;
}

export class ConfigError extends Error {}

/**
 * Parses the environment into a typed Config. Empty strings count as "unset" (Kubernetes renders optional
 * Secret keys that way). Error messages name the variable and the problem, never the value.
 */
export function loadConfig(env: Record<string, string | undefined>): Config {
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ''));
  const parsed = EnvSchema.safeParse(present);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new ConfigError(`invalid gateway configuration: ${problems.join('; ')}`);
  }
  const e = parsed.data;
  const bootstrapAdmin =
    e.BOOTSTRAP_ADMIN_EMAIL && e.BOOTSTRAP_ADMIN_PASSWORD
      ? { email: e.BOOTSTRAP_ADMIN_EMAIL.toLowerCase(), password: e.BOOTSTRAP_ADMIN_PASSWORD }
      : null;
  return {
    port: e.PORT,
    internalMcpPort: e.INTERNAL_MCP_PORT,
    metricsPort: e.METRICS_PORT,
    db: { host: e.PGHOST, port: e.PGPORT, database: e.PGDATABASE, user: e.PGUSER, password: e.PGPASSWORD },
    apiKeyPepper: e.API_KEY_PEPPER,
    credentialsKey: e.CREDENTIALS_KEY,
    chatJwtKey: e.CHAT_JWT_KEY,
    sessionSecret: e.SESSION_SECRET,
    bootstrapAdmin,
    anthropicApiKey: e.ANTHROPIC_API_KEY,
    llmModel: e.LLM_MODEL,
    publicBaseUrl: e.PUBLIC_BASE_URL,
    storeUrl: e.STORE_URL ?? defaultStoreUrl(e.PUBLIC_BASE_URL),
    cookieSecure: e.COOKIE_SECURE,
    storeTz: e.STORE_TZ,
    storeName: e.STORE_NAME,
    seedServersFile: e.SEED_SERVERS_FILE ?? null,
    internalHostAllowlist: e.INTERNAL_HOST_ALLOWLIST,
    healthIntervalMs: e.HEALTH_INTERVAL_MS,
    defaultCallTimeoutMs: e.DEFAULT_CALL_TIMEOUT_MS,
  };
}

/** CONTRACTS: the dashboard lives on `app.<baseDomain>` and the store on `store.<baseDomain>`. */
function defaultStoreUrl(publicBaseUrl: string): string {
  const url = new URL(publicBaseUrl);
  if (url.hostname.startsWith('app.')) url.hostname = `store.${url.hostname.slice('app.'.length)}`;
  return url.origin;
}
