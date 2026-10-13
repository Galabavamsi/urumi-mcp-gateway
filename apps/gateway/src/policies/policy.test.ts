import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICIES, isToolDenied, type ToolPolicy } from './policy.ts';

describe('isToolDenied', () => {
  it('applies the default policies to members only', () => {
    expect(isToolDenied(DEFAULT_POLICIES, 'member', 'woo', 'create_product')).toBe(true);
    expect(isToolDenied(DEFAULT_POLICIES, 'member', 'woo', 'update_order_status')).toBe(true);
    expect(isToolDenied(DEFAULT_POLICIES, 'member', 'woo', 'list_orders')).toBe(false);
    expect(isToolDenied(DEFAULT_POLICIES, 'admin', 'woo', 'create_product')).toBe(false);
  });

  it('matches the server slug, so the same tool name on another server is unaffected', () => {
    expect(isToolDenied(DEFAULT_POLICIES, 'member', 'supplier', 'create_product')).toBe(false);
  });

  it('supports wildcards for server and tool', () => {
    const wholeServer: ToolPolicy[] = [{ role: 'member', server: 'mail', tool: '*', effect: 'deny' }];
    expect(isToolDenied(wholeServer, 'member', 'mail', 'send_message')).toBe(true);
    expect(isToolDenied(wholeServer, 'member', 'woo', 'send_message')).toBe(false);

    const toolEverywhere: ToolPolicy[] = [{ role: 'member', server: '*', tool: 'send_message', effect: 'deny' }];
    expect(isToolDenied(toolEverywhere, 'member', 'mail', 'send_message')).toBe(true);
    expect(isToolDenied(toolEverywhere, 'member', 'mail', 'list_inboxes')).toBe(false);
  });

  it('allows everything when there are no policies', () => {
    expect(isToolDenied([], 'member', 'woo', 'create_product')).toBe(false);
  });
});
