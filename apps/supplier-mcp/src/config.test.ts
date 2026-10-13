import { describe, expect, it } from 'vitest';
import { readConfig } from './config.ts';

const TOKEN = 'a-test-token-long-enough';

describe('readConfig', () => {
  it('uses safe defaults: port 8080, built-in catalog, demo switches off', () => {
    expect(readConfig({ MCP_AUTH_TOKEN: TOKEN })).toEqual({
      port: 8080,
      authToken: TOKEN,
      catalogPath: undefined,
      demo: { slowTool: false, poisonedDescription: false },
    });
  });

  it('requires a token of at least 16 characters', () => {
    expect(() => readConfig({})).toThrow(/MCP_AUTH_TOKEN/);
    expect(() => readConfig({ MCP_AUTH_TOKEN: 'short' })).toThrow(/MCP_AUTH_TOKEN/);
  });

  it('reads the optional port and catalog path', () => {
    const config = readConfig({ MCP_AUTH_TOKEN: TOKEN, PORT: '9090', CATALOG_PATH: '/config/catalog.json' });
    expect(config.port).toBe(9090);
    expect(config.catalogPath).toBe('/config/catalog.json');
    expect(() => readConfig({ MCP_AUTH_TOKEN: TOKEN, PORT: 'eighty' })).toThrow(/PORT/);
  });

  it('turns demo switches on only for an explicit "true"', () => {
    const on = readConfig({ MCP_AUTH_TOKEN: TOKEN, DEMO_SLOW_TOOL: 'true', DEMO_POISONED_DESCRIPTION: 'TRUE' });
    expect(on.demo).toEqual({ slowTool: true, poisonedDescription: true });
    expect(readConfig({ MCP_AUTH_TOKEN: TOKEN, DEMO_SLOW_TOOL: 'false' }).demo.slowTool).toBe(false);
    expect(() => readConfig({ MCP_AUTH_TOKEN: TOKEN, DEMO_SLOW_TOOL: 'yes' })).toThrow(/DEMO_SLOW_TOOL/);
  });
});
