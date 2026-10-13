import { readFileSync } from 'node:fs';
import { z } from 'zod';

/**
 * One wholesale item a supplier sells to our store. Prices are the supplier's UNIT COST in rupees
 * (what we pay), not the retail price the store charges its customers.
 * The same zod schema validates a catalog file (CATALOG_PATH) and documents the tools' output.
 */
export const SupplierItem = z.object({
  sku: z.string().regex(/^[A-Z0-9-]{3,32}$/, 'SKU must be 3-32 chars of A-Z, 0-9 or -'),
  name: z.string().min(1).max(120),
  category: z.string().min(1).max(40),
  unit_cost_inr: z.number().positive(),
  moq: z.number().int().positive().describe('minimum order quantity, in units'),
  stock: z.number().int().nonnegative().describe('units the supplier can ship right now'),
  lead_time_days: z.number().int().nonnegative().describe('days from order to delivery at our store'),
});
export type SupplierItem = z.infer<typeof SupplierItem>;

/**
 * Built-in catalog. The first four are the supplier's versions of the products the store already sells
 * (same names as the store seed, SKUs prefixed SUP- instead of URU-). The rest are items the store does
 * NOT sell yet, which is what the cross-server demo prompt ("find products we don't sell yet...") finds.
 */
export const BUILT_IN_CATALOG: readonly SupplierItem[] = [
  { sku: 'SUP-CHAI-250', name: 'Masala Chai Tin (250g)', category: 'tea', unit_cost_inr: 165, moq: 24, stock: 480, lead_time_days: 5 },
  { sku: 'SUP-TOTE-01', name: 'Handloom Cotton Tote', category: 'bags', unit_cost_inr: 260, moq: 20, stock: 150, lead_time_days: 10 },
  { sku: 'SUP-DIYA-02', name: 'Brass Diya Set (2 pcs)', category: 'home-decor', unit_cost_inr: 430, moq: 12, stock: 60, lead_time_days: 14 },
  { sku: 'SUP-TURM-200', name: 'Organic Turmeric Powder (200g)', category: 'spices', unit_cost_inr: 95, moq: 30, stock: 900, lead_time_days: 4 },
  { sku: 'SUP-CARD-100', name: 'Cardamom Pods (100g)', category: 'spices', unit_cost_inr: 210, moq: 24, stock: 320, lead_time_days: 6 },
  { sku: 'SUP-CUSH-01', name: 'Block-Print Cushion Cover', category: 'home-decor', unit_cost_inr: 240, moq: 15, stock: 40, lead_time_days: 12 },
  { sku: 'SUP-COPB-1L', name: 'Copper Water Bottle (1L)', category: 'kitchen', unit_cost_inr: 520, moq: 10, stock: 75, lead_time_days: 12 },
  // Out of stock on purpose: first-flush tea is seasonal, so check_stock has a realistic "not available" answer.
  { sku: 'SUP-DARJ-100', name: 'Darjeeling First Flush Tea (100g)', category: 'tea', unit_cost_inr: 340, moq: 20, stock: 0, lead_time_days: 21 },
  { sku: 'SUP-SAFF-1G', name: 'Kashmiri Saffron (1g)', category: 'spices', unit_cost_inr: 280, moq: 50, stock: 200, lead_time_days: 9 },
  { sku: 'SUP-INCN-50', name: 'Sandalwood Incense Sticks (50 pcs)', category: 'home-decor', unit_cost_inr: 60, moq: 100, stock: 2000, lead_time_days: 7 },
];

/** Validates a whole catalog: every item well-formed, at least one item, no duplicate SKUs. */
export function parseCatalog(data: unknown): SupplierItem[] {
  const items = z.array(SupplierItem).min(1).parse(data);
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.sku)) throw new Error(`duplicate SKU in catalog: ${item.sku}`);
    seen.add(item.sku);
  }
  return items;
}

/**
 * Loads the catalog once at startup: from a JSON array file when `path` is set (mounted from a
 * ConfigMap in Kubernetes), otherwise the built-in list. Throws on a bad file so the pod fails
 * fast and visibly instead of serving an empty or half-parsed catalog.
 */
export function loadCatalog(path?: string): SupplierItem[] {
  if (!path) return parseCatalog(BUILT_IN_CATALOG);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`cannot read catalog ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  try {
    return parseCatalog(raw);
  } catch (err) {
    throw new Error(`invalid catalog ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** SKUs are matched case-insensitively and ignoring surrounding spaces (LLMs are not always exact). */
export function findBySku(catalog: readonly SupplierItem[], sku: string): SupplierItem | undefined {
  const wanted = sku.trim().toUpperCase();
  return catalog.find((item) => item.sku === wanted);
}

export interface ProductFilter {
  /** Case-insensitive substring of the name or SKU. */
  search?: string;
  /** Exact category, case-insensitive. */
  category?: string;
}

export function searchCatalog(catalog: readonly SupplierItem[], filter: ProductFilter = {}): SupplierItem[] {
  const search = filter.search?.trim().toLowerCase();
  const category = filter.category?.trim().toLowerCase();
  return catalog.filter(
    (item) =>
      (!search || item.name.toLowerCase().includes(search) || item.sku.toLowerCase().includes(search)) &&
      (!category || item.category.toLowerCase() === category),
  );
}

/** Distinct categories, sorted, so the list_products description can tell the model what exists. */
export function categoriesOf(catalog: readonly SupplierItem[]): string[] {
  return [...new Set(catalog.map((item) => item.category))].sort();
}

/** Answer of check_stock: the item's ordering facts plus a yes/no for the requested quantity. */
export const StockCheck = SupplierItem.pick({
  sku: true,
  name: true,
  stock: true,
  moq: true,
  lead_time_days: true,
  unit_cost_inr: true,
}).extend({
  quantity: z.number().int().describe('the quantity that was checked (the MOQ when none was given)'),
  available: z.boolean().describe('true when an order of `quantity` can be placed now: it meets the MOQ and is in stock'),
  reason: z.string(),
});
export type StockCheck = z.infer<typeof StockCheck>;

export function checkStock(item: SupplierItem, quantity: number = item.moq): StockCheck {
  let reason: string;
  if (quantity < item.moq) reason = `below the minimum order quantity of ${item.moq}`;
  else if (item.stock < quantity) reason = item.stock === 0 ? 'out of stock' : `only ${item.stock} in stock`;
  else reason = `in stock, delivered in about ${item.lead_time_days} days`;

  return {
    sku: item.sku,
    name: item.name,
    quantity,
    available: quantity >= item.moq && item.stock >= quantity,
    reason,
    stock: item.stock,
    moq: item.moq,
    lead_time_days: item.lead_time_days,
    unit_cost_inr: item.unit_cost_inr,
  };
}
