import { describe, expect, it } from 'vitest';
import { UserInputError } from './errors.ts';
import { assertTimeZone, dayWindow, parseInstant, resolveStoreDate, toNaiveUtc, wooGmtToZonedIso } from './time.ts';

const KOLKATA = 'Asia/Kolkata';
const NEW_YORK = 'America/New_York';

describe('resolveStoreDate', () => {
  // 20:00 UTC on 13 Oct is already 01:30 on 14 Oct in India: "today" must follow the store, not UTC.
  const now = new Date('2026-10-13T20:00:00Z');

  it('resolves today and yesterday in the store zone', () => {
    expect(resolveStoreDate('today', KOLKATA, now)).toBe('2026-10-14');
    expect(resolveStoreDate('yesterday', KOLKATA, now)).toBe('2026-10-13');
    expect(resolveStoreDate(' Today ', KOLKATA, now)).toBe('2026-10-14');
    expect(resolveStoreDate('today', 'UTC', now)).toBe('2026-10-13');
  });

  it('crosses month and year boundaries for yesterday', () => {
    expect(resolveStoreDate('yesterday', KOLKATA, new Date('2026-01-01T03:00:00Z'))).toBe('2025-12-31');
  });

  it('accepts real calendar dates and rejects anything else', () => {
    expect(resolveStoreDate('2026-10-02', KOLKATA, now)).toBe('2026-10-02');
    for (const bad of ['2026-02-30', '13/10/2026', 'tomorrow', '2026-10-2']) {
      expect(() => resolveStoreDate(bad, KOLKATA, now)).toThrow(UserInputError);
    }
  });
});

describe('dayWindow', () => {
  it('turns an Indian store day into naive UTC bounds', () => {
    expect(dayWindow('2026-10-14', KOLKATA)).toEqual({
      date: '2026-10-14',
      timezone: KOLKATA,
      from: '2026-10-14T00:00:00+05:30',
      to: '2026-10-15T00:00:00+05:30',
      wooAfter: '2026-10-13T18:29:59', // exclusive bound one second before local midnight
      wooBefore: '2026-10-14T18:30:00',
    });
  });

  it('handles the 23-hour day when New York springs forward (8 Mar 2026)', () => {
    const w = dayWindow('2026-03-08', NEW_YORK);
    expect(w.from).toBe('2026-03-08T00:00:00-05:00');
    expect(w.to).toBe('2026-03-09T00:00:00-04:00');
    expect(w.wooAfter).toBe('2026-03-08T04:59:59');
    expect(w.wooBefore).toBe('2026-03-09T04:00:00');
  });

  it('handles the 25-hour day when New York falls back (1 Nov 2026)', () => {
    const w = dayWindow('2026-11-01', NEW_YORK);
    expect(w.from).toBe('2026-11-01T00:00:00-04:00');
    expect(w.to).toBe('2026-11-02T00:00:00-05:00');
    expect(w.wooAfter).toBe('2026-11-01T03:59:59');
    expect(w.wooBefore).toBe('2026-11-02T05:00:00');
  });
});

describe('parseInstant', () => {
  it('uses an explicit offset as given', () => {
    expect(toNaiveUtc(parseInstant('2026-10-13T09:00:00+05:30', NEW_YORK, 'after'))).toBe('2026-10-13T03:30:00');
    expect(toNaiveUtc(parseInstant('2026-10-13T09:00:00Z', KOLKATA, 'after'))).toBe('2026-10-13T09:00:00');
  });

  it('reads dates and date-times without an offset as store time', () => {
    expect(toNaiveUtc(parseInstant('2026-10-13', KOLKATA, 'after'))).toBe('2026-10-12T18:30:00');
    expect(toNaiveUtc(parseInstant('2026-10-13T09:00', KOLKATA, 'after'))).toBe('2026-10-13T03:30:00');
    expect(toNaiveUtc(parseInstant('2026-07-01T12:00:00', NEW_YORK, 'before'))).toBe('2026-07-01T16:00:00');
  });

  it('names the field in its error', () => {
    expect(() => parseInstant('last tuesday', KOLKATA, 'before')).toThrow(/^before must be ISO 8601/);
    expect(() => parseInstant('2026-10-13T25:00:00', KOLKATA, 'after')).toThrow(UserInputError);
  });
});

describe('wooGmtToZonedIso', () => {
  it('shows WooCommerce GMT timestamps in store time', () => {
    expect(wooGmtToZonedIso('2026-10-13T20:05:09', KOLKATA)).toBe('2026-10-14T01:35:09+05:30');
    expect(wooGmtToZonedIso(null, KOLKATA)).toBeNull();
  });
});

describe('assertTimeZone', () => {
  it('accepts IANA zones and rejects typos', () => {
    expect(() => assertTimeZone(KOLKATA)).not.toThrow();
    expect(() => assertTimeZone('Asia/Kolkatta')).toThrow(/unknown time zone/);
  });
});
