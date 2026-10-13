import { describe, expect, it } from 'vitest';
import { hiddenReason } from './toolReason';

describe('hiddenReason', () => {
  it('says why a tool is not exposed: server disabled first, then the allowlist, else the gateway refused it', () => {
    const tool = { name: 'list_products' };
    expect(hiddenReason({ enabled: false, toolAllowlist: null }, tool)).toBe('server_disabled');
    expect(hiddenReason({ enabled: false, toolAllowlist: ['other'] }, tool)).toBe('server_disabled');
    expect(hiddenReason({ enabled: true, toolAllowlist: ['other'] }, tool)).toBe('allowlist');
    expect(hiddenReason({ enabled: true, toolAllowlist: ['list_products'] }, tool)).toBe('not_exposed');
    expect(hiddenReason({ enabled: true, toolAllowlist: null }, tool)).toBe('not_exposed');
  });
});
