import { describe, expect, it } from 'vitest';
import type { CachedTool } from '../db/schema.ts';
import { buildCatalog, type CatalogServer } from './catalog.ts';

const tool = (name: string, extra: Partial<CachedTool> = {}): CachedTool => ({
  name,
  description: `does ${name}`,
  inputSchema: { type: 'object' },
  ...extra,
});

const woo: CatalogServer = {
  id: 'id-woo',
  slug: 'woo',
  enabled: true,
  inCluster: true,
  toolAllowlist: null,
  tools: [tool('list_products'), tool('create_product', { annotations: { destructiveHint: true } })],
};
const supplier: CatalogServer = {
  id: 'id-sup',
  slug: 'supplier',
  enabled: true,
  inCluster: true,
  toolAllowlist: null,
  tools: [tool('list_products'), tool('check_stock')],
};

describe('buildCatalog', () => {
  it('namespaces colliding tool names and routes each to its own server', () => {
    const catalog = buildCatalog([woo, supplier]);
    expect(catalog.byExposedName.get('woo__list_products')).toMatchObject({ serverId: 'id-woo', originalName: 'list_products' });
    expect(catalog.byExposedName.get('supplier__list_products')).toMatchObject({ serverId: 'id-sup', originalName: 'list_products' });
  });

  it('lists in a stable order: by slug, then tool name, whatever the input order', () => {
    const names = (servers: CatalogServer[]) => buildCatalog(servers).listed.map((e) => e.exposedName);
    const expected = ['supplier__check_stock', 'supplier__list_products', 'woo__create_product', 'woo__list_products'];
    expect(names([woo, supplier])).toEqual(expected);
    expect(names([supplier, { ...woo, tools: [...woo.tools].reverse() }])).toEqual(expected);
  });

  it('exposes cleaned descriptions and keeps annotations, not outputSchema', () => {
    const entry = buildCatalog([woo]).byExposedName.get('woo__create_product');
    expect(entry?.tool).toEqual({
      name: 'woo__create_product',
      description: '[woo] does create_product',
      inputSchema: { type: 'object' },
      annotations: { destructiveHint: true },
    });
  });

  it('applies the per-server allowlist', () => {
    const catalog = buildCatalog([{ ...supplier, toolAllowlist: ['check_stock'] }]);
    expect(catalog.listed.map((e) => e.exposedName)).toEqual(['supplier__check_stock']);
    expect(catalog.byExposedName.has('supplier__list_products')).toBe(false);
    expect(catalog.exposure.get('id-sup')?.get('list_products')).toBeNull();
  });

  it('hides a disabled server from the list but still knows its tools (for a clear rejection)', () => {
    const catalog = buildCatalog([{ ...woo, enabled: false }, supplier]);
    expect(catalog.listed.every((e) => e.serverSlug === 'supplier')).toBe(true);
    expect(catalog.byExposedName.get('woo__list_products')?.serverEnabled).toBe(false);
  });

  it('exposes only the first of two upstream names that clean to the same exposed name', () => {
    const catalog = buildCatalog([{ ...woo, tools: [tool('get.order'), tool('get_order')] }]);
    expect(catalog.listed.map((e) => [e.exposedName, e.originalName])).toEqual([['woo__get_order', 'get.order']]);
    expect(catalog.exposure.get('id-woo')?.get('get_order')).toBeNull();
  });
});

describe('buildCatalog: untrusted upstream text inside schemas and annotations', () => {
  const schemaWith = (properties: Record<string, unknown>) => ({ type: 'object' as const, properties });
  const exposedSchema = (server: CatalogServer, name: string) => buildCatalog([server]).byExposedName.get(name)?.tool.inputSchema;

  it('cleans property descriptions and titles, but never property names or values', () => {
    const inputSchema = schemaWith({
      sku: { type: 'string', title: 'S\u200bKU', description: `Product code\u200b\u{E0049}\u{E0047}. ${'x'.repeat(3000)}` },
      // A property literally NAMED "description": an object, walked into, and kept.
      description: { type: 'string', description: 'The product text\u202e', enum: ['short', 'long'] },
    });
    const schema = exposedSchema({ ...woo, tools: [tool('create_product', { inputSchema })] }, 'woo__create_product') as any;
    expect(schema.properties.sku.title).toBe('SKU');
    expect(schema.properties.sku.description.startsWith('Product code. xxx')).toBe(true);
    expect(Array.from(schema.properties.sku.description as string)).toHaveLength(1500);
    expect(schema.properties.description).toEqual({ type: 'string', description: 'The product text', enum: ['short', 'long'] });
  });

  it('does not expose a tool whose schema is too large, or has invisible characters it could not clean', () => {
    const huge = schemaWith({ blob: { type: 'string', default: 'z'.repeat(40_000) } });
    const hiddenEnum = schemaWith({ mode: { type: 'string', enum: ['fast\u200b'] } });
    const catalog = buildCatalog([{ ...woo, tools: [tool('huge', { inputSchema: huge }), tool('sneaky', { inputSchema: hiddenEnum }), tool('fine')] }]);
    expect(catalog.listed.map((e) => e.exposedName)).toEqual(['woo__fine']);
    expect(catalog.exposure.get('id-woo')?.get('huge')).toBeNull();
    expect(catalog.exposure.get('id-woo')?.get('sneaky')).toBeNull();
  });

  it("keeps only the four MCP hints from our own servers, and gives a third-party server's tools the worst case", () => {
    const annotations = { readOnlyHint: true, destructiveHint: false, openWorldHint: false, title: 'Lists\u200b', vendorFlag: 'trust me' };
    const own = buildCatalog([{ ...woo, tools: [tool('list_products', { annotations })] }]).byExposedName.get('woo__list_products');
    expect(own?.tool.annotations).toEqual({ title: 'Lists', readOnlyHint: true, destructiveHint: false, openWorldHint: false });
    const thirdParty = buildCatalog([{ ...woo, inCluster: false, tools: [tool('list_products', { annotations })] }]).byExposedName.get(
      'woo__list_products',
    );
    expect(thirdParty?.tool.annotations).toEqual({ title: 'Lists', readOnlyHint: false, destructiveHint: true, openWorldHint: true });
    expect(thirdParty?.serverInCluster).toBe(false);
  });
});
