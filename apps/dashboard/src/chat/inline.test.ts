import { describe, expect, it } from 'vitest';
import { parseInline } from './inline';

describe('parseInline', () => {
  it('splits bold and code out of plain text', () => {
    expect(parseInline('Created **Blue Mug** with `woo__create_product`.')).toEqual([
      { kind: 'text', text: 'Created ' },
      { kind: 'bold', text: 'Blue Mug' },
      { kind: 'text', text: ' with ' },
      { kind: 'code', text: 'woo__create_product' },
      { kind: 'text', text: '.' },
    ]);
  });

  it('leaves unmatched markers and HTML as plain text', () => {
    expect(parseInline('5 * 3 = 15 and **open <b>x</b>')).toEqual([{ kind: 'text', text: '5 * 3 = 15 and **open <b>x</b>' }]);
  });

  it('does not let bold span lines', () => {
    expect(parseInline('**a\nb**')).toEqual([{ kind: 'text', text: '**a\nb**' }]);
  });
});
