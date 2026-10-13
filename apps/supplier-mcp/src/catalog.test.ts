import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BUILT_IN_CATALOG, checkStock, findBySku, loadCatalog, parseCatalog, searchCatalog, type SupplierItem } from './catalog.ts';

// The store seed (charts/woo-store) sells these; the supplier must offer the same names as SUP- SKUs.
const STORE_SEED = [
  { name: 'Masala Chai Tin (250g)', sku: 'URU-CHAI-250', price: 299 },
  { name: 'Handloom Cotton Tote', sku: 'URU-TOTE-01', price: 499 },
  { name: 'Brass Diya Set (2 pcs)', sku: 'URU-DIYA-02', price: 799 },
  { name: 'Organic Turmeric Powder (200g)', sku: 'URU-TURM-200', price: 199 },
];
const NOT_IN_STORE = ['Cardamom Pods (100g)', 'Block-Print Cushion Cover', 'Copper Water Bottle (1L)', 'Darjeeling First Flush Tea (100g)'];

const catalog = loadCatalog();
const item = (sku: string): SupplierItem => {
  const found = findBySku(catalog, sku);
  if (!found) throw new Error(`test fixture missing ${sku}`);
  return found;
};

describe('built-in catalog', () => {
  it('is valid and has about ten items with unique SKUs', () => {
    expect(() => parseCatalog(BUILT_IN_CATALOG)).not.toThrow();
    expect(catalog.length).toBeGreaterThanOrEqual(8);
    expect(new Set(catalog.map((i) => i.sku)).size).toBe(catalog.length);
  });

  it('offers every store product under the same name with a SUP- SKU, cheaper than retail', () => {
    for (const product of STORE_SEED) {
      const supplierSku = product.sku.replace(/^URU-/, 'SUP-');
      const match = findBySku(catalog, supplierSku);
      expect(match?.name, supplierSku).toBe(product.name);
      expect(match!.unit_cost_inr).toBeLessThan(product.price); // wholesale cost leaves the store a margin
    }
  });

  it('includes items the store does not sell yet', () => {
    const names = catalog.map((i) => i.name);
    for (const name of NOT_IN_STORE) expect(names).toContain(name);
    expect(catalog.every((i) => i.sku.startsWith('SUP-'))).toBe(true);
  });
});

describe('searchCatalog', () => {
  it('returns everything without filters', () => {
    expect(searchCatalog(catalog)).toHaveLength(catalog.length);
  });

  it('matches name or SKU substrings case-insensitively', () => {
    expect(searchCatalog(catalog, { search: 'CHAI' }).map((i) => i.sku)).toEqual(['SUP-CHAI-250']);
    expect(searchCatalog(catalog, { search: 'sup-card' }).map((i) => i.name)).toEqual(['Cardamom Pods (100g)']);
  });

  it('filters by exact category and combines filters', () => {
    expect(searchCatalog(catalog, { category: 'TEA' }).map((i) => i.sku).sort()).toEqual(['SUP-CHAI-250', 'SUP-DARJ-100']);
    expect(searchCatalog(catalog, { category: 'tea', search: 'darjeeling' })).toHaveLength(1);
    expect(searchCatalog(catalog, { category: 'te' })).toEqual([]); // no partial category match
    expect(searchCatalog(catalog, { search: 'no such thing' })).toEqual([]);
  });
});

describe('findBySku', () => {
  it('ignores case and surrounding spaces', () => {
    expect(findBySku(catalog, '  sup-chai-250 ')?.name).toBe('Masala Chai Tin (250g)');
  });

  it('does not confuse store SKUs with supplier SKUs', () => {
    expect(findBySku(catalog, 'URU-CHAI-250')).toBeUndefined();
  });
});

describe('checkStock', () => {
  it('checks the MOQ when no quantity is given', () => {
    const chai = item('SUP-CHAI-250');
    expect(checkStock(chai)).toMatchObject({ quantity: chai.moq, available: true, stock: chai.stock, moq: chai.moq });
  });

  it('rejects quantities below the MOQ', () => {
    const result = checkStock(item('SUP-CHAI-250'), 5);
    expect(result.available).toBe(false);
    expect(result.reason).toMatch(/minimum order quantity/);
  });

  it('rejects quantities above the stock', () => {
    const diya = item('SUP-DIYA-02');
    const result = checkStock(diya, diya.stock + 1);
    expect(result).toMatchObject({ available: false, reason: `only ${diya.stock} in stock` });
  });

  it('reports out-of-stock items', () => {
    expect(checkStock(item('SUP-DARJ-100'))).toMatchObject({ available: false, reason: 'out of stock', stock: 0 });
  });
});

describe('parseCatalog / loadCatalog', () => {
  const valid = { sku: 'SUP-X-1', name: 'X', category: 'misc', unit_cost_inr: 10, moq: 1, stock: 5, lead_time_days: 2 };

  it('rejects empty catalogs, bad items and duplicate SKUs', () => {
    expect(() => parseCatalog([])).toThrow();
    expect(() => parseCatalog([{ ...valid, unit_cost_inr: -1 }])).toThrow();
    expect(() => parseCatalog([{ ...valid, sku: 'lower-case' }])).toThrow();
    expect(() => parseCatalog([valid, { ...valid, name: 'Y' }])).toThrow(/duplicate SKU/);
  });

  it('loads a JSON catalog file and explains bad ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'supplier-catalog-'));
    const good = join(dir, 'good.json');
    const broken = join(dir, 'broken.json');
    writeFileSync(good, JSON.stringify([valid]));
    writeFileSync(broken, '{ not json');

    expect(loadCatalog(good)).toEqual([valid]);
    expect(() => loadCatalog(broken)).toThrow(/cannot read catalog .*broken\.json/);
    expect(() => loadCatalog(join(dir, 'missing.json'))).toThrow(/cannot read catalog/);
  });
});
