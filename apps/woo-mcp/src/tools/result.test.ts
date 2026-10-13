import { describe, expect, it } from 'vitest';
import { untrustedText } from './result.ts';

describe('untrustedText', () => {
  it('removes characters a reader cannot see but a model reads', () => {
    const hidden = String.fromCodePoint(0xe0041, 0xe0042); // Unicode tag characters spell "AB" invisibly
    const text = `Leave​ at‮ the⁦ door﻿${hidden}\u0007`;
    expect(untrustedText(text, 500)).toBe('Leave at the door');
  });

  it('collapses whitespace and newlines to single spaces', () => {
    expect(untrustedText('  Ring\n\n\tthe   bell \r\n', 500)).toBe('Ring the bell');
  });

  it('caps a 5 KB note at the limit, ellipsis included', () => {
    const note = `${'a​'.repeat(2500)}${String.fromCodePoint(0xe0049)}`; // ~5 KB with invisible padding
    const out = untrustedText(note, 500);
    expect([...out]).toHaveLength(500);
    expect(out.endsWith('…')).toBe(true);
    expect(out).not.toMatch(/[​\u{E0000}-\u{E007F}]/u);
  });

  it('never cuts a surrogate pair in half', () => {
    const out = untrustedText('🙂'.repeat(10), 5);
    expect(out).toBe('🙂🙂🙂🙂…');
  });

  it('turns null and numbers into strings like str()', () => {
    expect(untrustedText(null, 10)).toBe('');
    expect(untrustedText(42, 10)).toBe('42');
  });
});
