import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { UserInputError } from '../errors.ts';
import { int, READ_ONLY, runTool, str, untrustedText, type ToolDeps } from './result.ts';

/** The parts of a WooCommerce product we read (GET /products). Everything is optional: never trust the shape. */
interface WooProduct {
  id?: number;
  name?: string;
  type?: string;
  status?: string;
  permalink?: string;
  sku?: string;
  price?: string;
  regular_price?: string;
  sale_price?: string;
  stock_status?: string;
  manage_stock?: boolean | string;
  stock_quantity?: number | null;
  virtual?: boolean;
  description?: string;
  short_description?: string;
  categories?: { name?: string }[];
  date_created_gmt?: string | null;
}

const PRODUCT_LIST_FIELDS = 'id,name,sku,price,regular_price,status,stock_status,permalink';

/**
 * WooCommerce wants prices as strings ("499.00"); models send 499, 499.5 or "₹499". Accept plain numbers
 * and numeric strings, refuse anything we would have to guess about (currency symbols, thousands separators,
 * more than 2 decimals), and always send exactly 2 decimals.
 */
export function toWooPrice(value: number | string): string {
  const text = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : value.trim();
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(text);
  if (!match) {
    throw new UserInputError(
      `regular_price must be a plain amount in the store currency with at most 2 decimals, like 499 or 499.50; got ${JSON.stringify(value)}`,
    );
  }
  return `${BigInt(match[1]!)}.${(match[2] ?? '').padEnd(2, '0')}`; // BigInt drops leading zeros without float rounding
}

const productSummary = z.object({
  id: z.int(),
  name: z.string(),
  sku: z.string(),
  price: z.string().describe('Current price (sale price if on sale), store currency'),
  regular_price: z.string(),
  status: z.string().describe('publish, draft, pending or private'),
  stock_status: z.string().describe('instock, outofstock or onbackorder'),
  permalink: z.string().describe('Public product page URL'),
});

function toSummary(p: WooProduct): z.infer<typeof productSummary> {
  return {
    id: int(p.id) ?? 0,
    name: str(p.name),
    sku: str(p.sku),
    price: str(p.price),
    regular_price: str(p.regular_price),
    status: str(p.status),
    stock_status: str(p.stock_status),
    permalink: str(p.permalink),
  };
}

/** Product descriptions are HTML written by store members; the model needs the words, not the markup. */
function plainText(html: unknown, maxLength = 1000): string {
  return untrustedText(str(html).replace(/<[^>]*>/g, ' '), maxLength);
}

const productDetail = productSummary.extend({
  type: z.string(),
  sale_price: z.string(),
  manage_stock: z.boolean(),
  stock_quantity: z.int().nullable(),
  virtual: z.boolean(),
  categories: z.array(z.string()),
  short_description: z.string(),
  description: z.string().describe('Plain text, truncated to 1000 characters'),
});

const productId = z.int().positive().describe('WooCommerce product ID');

export function registerProductTools(server: McpServer, deps: ToolDeps): void {
  const { woo } = deps;

  server.registerTool(
    'list_products',
    {
      title: 'List store products',
      description:
        'List products in our WooCommerce store, newest first. Use `search` to find products by name or ' +
        'description, or `sku` for an exact SKU match (e.g. to check whether we already sell a supplier item). ' +
        'Returns compact product summaries plus `total` (matches across all pages) for paging.',
      inputSchema: z.object({
        search: z.string().min(1).max(200).optional().describe('Text to search for in product names and descriptions'),
        sku: z.string().min(1).max(100).optional().describe('Exact SKU to look up, e.g. URU-CHAI-250'),
        status: z
          .enum(['any', 'publish', 'draft', 'private'])
          .default('any')
          .describe('Only products with this status; "any" (default) includes drafts and private products'),
        per_page: z.int().min(1).max(50).default(20).describe('Products per page (1-50, default 20)'),
        page: z.int().min(1).default(1).describe('Page number, starting at 1'),
      }),
      outputSchema: z.object({
        products: z.array(productSummary),
        count: z.int().describe('Products on this page'),
        total: z.int().nullable().describe('Products matching across all pages'),
        page: z.int(),
        total_pages: z.int().nullable(),
      }),
      annotations: READ_ONLY,
    },
    (args, ctx) =>
      runTool('list_products', async () => {
        const res = await woo.get<WooProduct[]>(
          '/products',
          {
            search: args.search,
            sku: args.sku,
            status: args.status,
            per_page: args.per_page,
            page: args.page,
            _fields: PRODUCT_LIST_FIELDS, // ask WordPress for just these columns: smaller, faster responses
          },
          ctx.mcpReq.signal,
        );
        const products = res.data.map(toSummary);
        return { products, count: products.length, total: res.total, page: args.page, total_pages: res.totalPages };
      }),
  );

  server.registerTool(
    'get_product',
    {
      title: 'Get one product',
      description: 'Get the details of one product in our store by its ID: prices, stock, categories and description.',
      inputSchema: z.object({ id: productId }),
      outputSchema: productDetail,
      annotations: READ_ONLY,
    },
    (args, ctx) =>
      runTool('get_product', async () => {
        const { data: p } = await woo.get<WooProduct>(`/products/${args.id}`, undefined, ctx.mcpReq.signal);
        return {
          ...toSummary(p),
          type: str(p.type),
          sale_price: str(p.sale_price),
          manage_stock: p.manage_stock === true,
          stock_quantity: int(p.stock_quantity),
          virtual: p.virtual === true,
          categories: (p.categories ?? []).map((c) => str(c.name)),
          short_description: plainText(p.short_description),
          description: plainText(p.description),
        } satisfies z.infer<typeof productDetail>;
      }),
  );

  server.registerTool(
    'create_product',
    {
      title: 'Create a product',
      description:
        'Create a new simple product in our store. It is published (visible on the storefront) unless you set ' +
        'status to draft or private. Prices are in the store currency (INR); give regular_price as a number like 499. ' +
        'Not idempotent: each call creates another product, so after a timeout check with list_products ' +
        '(sku, or search by name) before retrying.',
      inputSchema: z.object({
        name: z.string().trim().min(1).max(200).describe('Product name shown to shoppers'),
        regular_price: z
          .union([z.number(), z.string()])
          .describe('Price in the store currency, e.g. 499 or "499.00" (no currency symbol)'),
        description: z.string().max(5000).optional().describe('Long description (plain text or simple HTML)'),
        short_description: z.string().max(1000).optional().describe('One or two sentences shown near the price'),
        sku: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .optional()
          .describe(
            'Unique stock-keeping unit, e.g. URU-TOTE-01. Recommended: WooCommerce rejects a duplicate SKU ' +
              '(400 product_invalid_sku), so a retry cannot create a second copy.',
          ),
        status: z.enum(['publish', 'draft', 'private']).default('publish').describe('Default publish'),
        manage_stock: z.boolean().optional().describe('Track stock for this product (implied when stock_quantity is set)'),
        stock_quantity: z.int().min(0).optional().describe('Units in stock'),
        virtual: z.boolean().default(false).describe('True for non-physical products that need no shipping'),
      }),
      outputSchema: z.object({
        id: z.int(),
        name: z.string(),
        sku: z.string(),
        price: z.string(),
        regular_price: z.string(),
        status: z.string(),
        permalink: z.string(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false, // adds a product; changes nothing that exists
        idempotentHint: false, // calling twice creates two products
        openWorldHint: false,
      },
    },
    (args, ctx) =>
      runTool('create_product', async () => {
        const body = {
          name: args.name,
          type: 'simple',
          status: args.status,
          regular_price: toWooPrice(args.regular_price), // WooCommerce's schema type for prices is string
          description: args.description,
          short_description: args.short_description,
          sku: args.sku,
          manage_stock: args.manage_stock ?? (args.stock_quantity !== undefined ? true : undefined),
          stock_quantity: args.stock_quantity,
          virtual: args.virtual,
        };
        const { data: p } = await woo.post<WooProduct>('/products', body, ctx.mcpReq.signal);
        const { id, name, sku, price, regular_price, status, permalink } = toSummary(p);
        return { id, name, sku, price, regular_price, status, permalink };
      }),
  );
}
