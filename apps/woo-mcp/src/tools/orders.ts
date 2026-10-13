import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { UserInputError } from '../errors.ts';
import { dayWindow, parseInstant, resolveStoreDate, toNaiveUtc, toZonedIso, wooGmtToZonedIso } from '../time.ts';
import { WooApiError } from '../woo/client.ts';
import { int, READ_ONLY, runTool, str, type ToolDeps } from './result.ts';

/** The parts of a WooCommerce order we read (GET /orders). Optional everywhere: never trust the shape. */
interface WooOrder {
  id?: number;
  number?: string;
  status?: string;
  currency?: string;
  date_created_gmt?: string | null;
  date_paid_gmt?: string | null;
  date_completed_gmt?: string | null;
  total?: string;
  discount_total?: string;
  shipping_total?: string;
  total_tax?: string;
  payment_method_title?: string;
  customer_note?: string;
  billing?: { first_name?: string; last_name?: string; email?: string; phone?: string; city?: string };
  line_items?: { name?: string; sku?: string; quantity?: number; total?: string }[];
}

/** Statuses an order can be moved to. "refunded" only changes the status; it does not return any money. */
const ORDER_STATUSES = ['pending', 'processing', 'on-hold', 'completed', 'cancelled', 'refunded', 'failed'] as const;

const ORDER_LIST_FIELDS =
  'id,number,status,currency,date_created_gmt,total,billing,line_items,payment_method_title';

const customerName = (o: WooOrder) => `${str(o.billing?.first_name)} ${str(o.billing?.last_name)}`.trim();

const orderSummary = z.object({
  id: z.int(),
  number: z.string().describe('Order number shown to the customer'),
  status: z.string(),
  date_created: z.string().nullable().describe('When the order was placed, store-local ISO 8601 with offset'),
  total: z.string(),
  currency: z.string(),
  customer: z.object({ name: z.string(), email: z.string() }),
  items: z.array(z.string()).describe('"<product> × <quantity>" per line item'),
  payment_method_title: z.string(),
});

// get_order: the summary's fields minus the list-only shortcuts, plus the detail a shop manager needs.
// Street addresses are deliberately left out (less personal data flowing into model context).
const orderDetail = orderSummary.omit({ customer: true, items: true }).extend({
  date_paid: z.string().nullable(),
  date_completed: z.string().nullable(),
  customer_note: z.string().describe('Note the customer wrote at checkout'),
  billing: z.object({ name: z.string(), email: z.string(), phone: z.string(), city: z.string() }),
  line_items: z.array(z.object({ name: z.string(), sku: z.string(), quantity: z.int(), total: z.string() })),
  totals: z.object({ discount: z.string(), shipping: z.string(), tax: z.string(), total: z.string() }),
});

const orderId = z.int().positive().describe('WooCommerce order ID');

interface DateFilter {
  /** Echoed back to the model so it can see which range was searched. */
  window: { date: string | null; timezone: string; from: string | null; to: string | null } | null;
  /** Naive UTC strings for WooCommerce, sent with dates_are_gmt=true (see time.ts for why). */
  after?: string;
  before?: string;
}

/** Turns list_orders' date arguments into WooCommerce's after/before plus a readable store-local window. */
function dateFilter(args: { date?: string; after?: string; before?: string }, storeTz: string, now: Date): DateFilter {
  if (args.date && (args.after || args.before)) {
    throw new UserInputError('use either `date` or `after`/`before`, not both');
  }
  if (args.date) {
    const day = dayWindow(resolveStoreDate(args.date, storeTz, now), storeTz);
    return {
      window: { date: day.date, timezone: storeTz, from: day.from, to: day.to },
      after: day.wooAfter,
      before: day.wooBefore,
    };
  }
  if (!args.after && !args.before) return { window: null };

  const afterMs = args.after ? parseInstant(args.after, storeTz, 'after') : undefined;
  const beforeMs = args.before ? parseInstant(args.before, storeTz, 'before') : undefined;
  if (afterMs !== undefined && beforeMs !== undefined && afterMs >= beforeMs) {
    throw new UserInputError('`after` must be earlier than `before`');
  }
  return {
    window: {
      date: null,
      timezone: storeTz,
      from: afterMs === undefined ? null : toZonedIso(afterMs, storeTz),
      to: beforeMs === undefined ? null : toZonedIso(beforeMs, storeTz),
    },
    after: afterMs === undefined ? undefined : toNaiveUtc(afterMs),
    before: beforeMs === undefined ? undefined : toNaiveUtc(beforeMs),
  };
}

export function registerOrderTools(server: McpServer, deps: ToolDeps): void {
  const { woo, storeTz } = deps;

  function toSummary(o: WooOrder): z.infer<typeof orderSummary> {
    return {
      id: int(o.id) ?? 0,
      number: str(o.number),
      status: str(o.status),
      date_created: wooGmtToZonedIso(o.date_created_gmt, storeTz),
      total: str(o.total),
      currency: str(o.currency),
      customer: { name: customerName(o), email: str(o.billing?.email) },
      items: (o.line_items ?? []).map((li) => `${str(li.name)} × ${int(li.quantity) ?? 0}`),
      payment_method_title: str(o.payment_method_title),
    };
  }

  server.registerTool(
    'list_orders',
    {
      title: 'List store orders',
      description:
        `List orders placed in our WooCommerce store, newest first. Dates follow the store's time zone (${storeTz}). ` +
        'For one day use `date` ("today", "yesterday" or YYYY-MM-DD); for any other range use `after`/`before`; ' +
        'with neither you get the latest orders. Returns each order with number, status, time, total, ' +
        'customer name and email, items and payment method, plus `count` (this page) and `total` (all pages).',
      inputSchema: z.object({
        date: z
          .string()
          .optional()
          .describe(`"today", "yesterday" or a calendar date YYYY-MM-DD, as a day in ${storeTz}`),
        after: z
          .string()
          .optional()
          .describe('Only orders placed after this moment, ISO 8601 (e.g. 2026-10-13T09:00:00+05:30; no offset = store time)'),
        before: z.string().optional().describe('Only orders placed before this moment, ISO 8601'),
        status: z
          .enum(['any', ...ORDER_STATUSES, 'checkout-draft'])
          .default('any')
          .describe('Only orders with this status. "any" (default) means every status except checkout-draft (abandoned carts)'),
        per_page: z.int().min(1).max(50).default(20).describe('Orders per page (1-50, default 20)'),
        page: z.int().min(1).default(1).describe('Page number, starting at 1'),
      }),
      outputSchema: z.object({
        window: z
          .object({
            date: z.string().nullable(),
            timezone: z.string(),
            from: z.string().nullable().describe('Store-local start of the range'),
            to: z.string().nullable().describe('Store-local end of the range'),
          })
          .nullable()
          .describe('The time range that was searched; null when no date filter was given'),
        orders: z.array(orderSummary),
        count: z.int().describe('Orders on this page'),
        total: z.int().nullable().describe('Orders matching across all pages'),
        page: z.int(),
        total_pages: z.int().nullable(),
      }),
      annotations: READ_ONLY,
    },
    (args, ctx) =>
      runTool('list_orders', async () => {
        const { window, after, before } = dateFilter(args, storeTz, deps.now());
        const res = await woo.get<WooOrder[]>(
          '/orders',
          {
            after,
            before,
            dates_are_gmt: after || before ? true : undefined,
            status: args.status,
            per_page: args.per_page,
            page: args.page,
            _fields: ORDER_LIST_FIELDS,
          },
          ctx.mcpReq.signal,
        );
        const orders = res.data.map(toSummary);
        return { window, orders, count: orders.length, total: res.total, page: args.page, total_pages: res.totalPages };
      }),
  );

  server.registerTool(
    'get_order',
    {
      title: 'Get one order',
      description:
        'Get one order by its ID: status, dates (store time), line items, totals, payment method, the customer ' +
        "note and the billing contact (name, email, phone, city). Street addresses are left out on purpose.",
      inputSchema: z.object({ id: orderId }),
      outputSchema: orderDetail,
      annotations: READ_ONLY,
    },
    (args, ctx) =>
      runTool('get_order', async () => {
        const { data: o } = await woo.get<WooOrder>(`/orders/${args.id}`, undefined, ctx.mcpReq.signal);
        const { customer: _customer, items: _items, ...summary } = toSummary(o);
        return {
          ...summary,
          date_paid: wooGmtToZonedIso(o.date_paid_gmt, storeTz),
          date_completed: wooGmtToZonedIso(o.date_completed_gmt, storeTz),
          customer_note: str(o.customer_note),
          billing: {
            name: customerName(o),
            email: str(o.billing?.email),
            phone: str(o.billing?.phone),
            city: str(o.billing?.city),
          },
          line_items: (o.line_items ?? []).map((li) => ({
            name: str(li.name),
            sku: str(li.sku),
            quantity: int(li.quantity) ?? 0,
            total: str(li.total),
          })),
          totals: {
            discount: str(o.discount_total),
            shipping: str(o.shipping_total),
            tax: str(o.total_tax),
            total: str(o.total),
          },
        } satisfies z.infer<typeof orderDetail>;
      }),
  );

  server.registerTool(
    'update_order_status',
    {
      title: 'Change an order status',
      description:
        'Move an order to a new status, e.g. processing → completed when it has been delivered, or → cancelled. ' +
        'WooCommerce may email the customer and adjust stock as a result. Setting "refunded" does NOT send money ' +
        'back; it only changes the status. Optionally adds a private order note (not shown to the customer) ' +
        'explaining the change. Returns the previous and the new status.',
      inputSchema: z.object({
        id: orderId,
        status: z.enum(ORDER_STATUSES).describe('New status'),
        note: z.string().trim().min(1).max(1000).optional().describe('Private note to add to the order, e.g. why'),
      }),
      outputSchema: z.object({
        id: z.int(),
        number: z.string(),
        previous_status: z.string(),
        status: z.string(),
        changed: z.boolean().describe('False when the order already had this status'),
        note_added: z.boolean(),
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true, // overwrites the status and can trigger emails, stock changes
        idempotentHint: false, // each call with a note adds another note
        openWorldHint: false,
      },
    },
    (args, ctx) =>
      runTool('update_order_status', async () => {
        const route = `/orders/${args.id}`;
        // Read first so we can report the previous status (and skip a pointless write).
        const { data: before } = await woo.get<WooOrder>(route, { _fields: 'id,number,status' }, ctx.mcpReq.signal);
        const previous = str(before.status);

        let current = previous;
        if (previous !== args.status) {
          const { data: after } = await woo.put<WooOrder>(route, { status: args.status }, ctx.mcpReq.signal);
          current = str(after.status);
        }

        let noteAdded = false;
        if (args.note) {
          try {
            await woo.post(`${route}/notes`, { note: args.note, customer_note: false }, ctx.mcpReq.signal);
            noteAdded = true;
          } catch (err) {
            if (!(err instanceof WooApiError)) throw err;
            // The status change already happened; say so, or the model may think nothing changed and retry.
            throw new WooApiError(
              err.status,
              err.code,
              `${err.message} (adding the note failed, but the status change succeeded: order ${args.id} is now "${current}", was "${previous}")`,
            );
          }
        }

        return {
          id: int(before.id) ?? args.id,
          number: str(before.number),
          previous_status: previous,
          status: current,
          changed: current !== previous,
          note_added: noteAdded,
        };
      }),
  );
}
