import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from './config.ts';

const base = {
  PGHOST: 'postgres',
  PGDATABASE: 'gateway',
  PGUSER: 'gateway',
  PGPASSWORD: 'pg-secret-value',
  API_KEY_PEPPER: 'p'.repeat(64),
  CREDENTIALS_KEY: Buffer.alloc(32, 7).toString('base64'),
  CHAT_JWT_KEY: 'c'.repeat(64),
  SESSION_SECRET: 's'.repeat(64),
  PUBLIC_BASE_URL: 'http://app.127-0-0-1.sslip.io/',
};

describe('loadConfig', () => {
  it('applies the documented defaults', () => {
    const config = loadConfig(base);
    expect(config).toMatchObject({
      port: 8080,
      internalMcpPort: 8081,
      metricsPort: 9091,
      db: { host: 'postgres', port: 5432 },
      llmModel: 'claude-haiku-5-5',
      cookieSecure: false,
      storeTz: 'Asia/Kolkata',
      healthIntervalMs: 5000,
      defaultCallTimeoutMs: 10_000,
      publicBaseUrl: 'http://app.127-0-0-1.sslip.io',
      storeUrl: 'http://store.127-0-0-1.sslip.io',
      bootstrapAdmin: null,
      seedServersFile: null,
      internalHostAllowlist: [],
    });
    expect(config.credentialsKey).toHaveLength(32);
  });

  it('parses lists and flags, and treats empty strings as unset', () => {
    const config = loadConfig({
      ...base,
      COOKIE_SECURE: 'true',
      INTERNAL_HOST_ALLOWLIST: 'Woo-MCP.store.svc.cluster.local, supplier-mcp.mcp-upstreams.svc.cluster.local,',
      BOOTSTRAP_ADMIN_EMAIL: 'Admin@Example.com',
      BOOTSTRAP_ADMIN_PASSWORD: 'long-enough-password',
      STORE_URL: '',
    });
    expect(config.cookieSecure).toBe(true);
    expect(config.internalHostAllowlist).toEqual(['woo-mcp.store.svc.cluster.local', 'supplier-mcp.mcp-upstreams.svc.cluster.local']);
    expect(config.bootstrapAdmin).toEqual({ email: 'admin@example.com', password: 'long-enough-password' });
    expect(config.storeUrl).toBe('http://store.127-0-0-1.sslip.io');
  });

  it('names bad variables without echoing their values', () => {
    const attempt = () => loadConfig({ ...base, CREDENTIALS_KEY: 'dG9vLXNob3J0', SESSION_SECRET: 'short-secret-value' });
    expect(attempt).toThrow(ConfigError);
    expect(attempt).toThrow(/CREDENTIALS_KEY/);
    expect(attempt).toThrow(/SESSION_SECRET/);
    try {
      attempt();
    } catch (err) {
      expect((err as Error).message).not.toContain('short-secret-value');
      expect((err as Error).message).not.toContain('dG9vLXNob3J0');
    }
  });

  it('requires the database settings', () => {
    expect(() => loadConfig({ ...base, PGPASSWORD: undefined })).toThrow(/PGPASSWORD/);
  });
});
