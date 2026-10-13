// Store-local calendar maths without a date library. Intl tells us the wall-clock time in any IANA zone;
// from that we derive the zone's UTC offset at an instant, and turn "midnight on 2026-10-14 in Asia/Kolkata"
// into a UTC instant.
//
// WooCommerce side: we always send order date filters as *naive UTC* strings with dates_are_gmt=true, so
// WooCommerce compares them with the UTC column (date_created_gmt). Sending an offset like +05:30 together
// with dates_are_gmt=true would be wrong: WordPress' date query re-reads offset strings as site-local time.
import { UserInputError } from './errors.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAIVE_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/;
const DATE_TIME_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

interface WallClock {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23', // 00-23; plain hour12:false can print midnight as "24"
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** Throws unless `timeZone` is an IANA zone this Node.js knows (e.g. `Asia/Kolkata`). */
export function assertTimeZone(timeZone: string): void {
  try {
    formatterFor(timeZone);
  } catch {
    throw new Error(`unknown time zone ${JSON.stringify(timeZone)} (expected an IANA name like Asia/Kolkata)`);
  }
}

function wallClockAt(epochMs: number, timeZone: string): WallClock {
  const parts: Record<string, number> = {};
  for (const part of formatterFor(timeZone).formatToParts(new Date(epochMs))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year!,
    month: parts.month!,
    day: parts.day!,
    hour: parts.hour!,
    minute: parts.minute!,
    second: parts.second!,
  };
}

/** The zone's offset from UTC at that instant, in ms (Asia/Kolkata: +19 800 000). */
function offsetMs(epochMs: number, timeZone: string): number {
  const w = wallClockAt(epochMs, timeZone);
  const wallAsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return wallAsUtc - Math.floor(epochMs / 1000) * 1000;
}

/** The UTC instant at which the clocks in `timeZone` show the given wall-clock time. */
function zonedToEpoch(w: WallClock, timeZone: string): number {
  const wallAsUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  // First guess: subtract the offset the zone has at `wallAsUtc` (read as an instant). Then redo it with the
  // offset at the guessed instant. The second pass matters on DST change days, when the two offsets differ.
  const guess = wallAsUtc - offsetMs(wallAsUtc, timeZone);
  return wallAsUtc - offsetMs(guess, timeZone);
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const ymd = (w: Pick<WallClock, 'year' | 'month' | 'day'>) => `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;

/** `2026-10-13T18:30:00`: UTC without an offset, the format WooCommerce wants with dates_are_gmt=true. */
export function toNaiveUtc(epochMs: number): string {
  return new Date(Math.floor(epochMs / 1000) * 1000).toISOString().slice(0, 19);
}

/** `2026-10-14T00:00:00+05:30`: what a shop owner in that zone would call that moment. */
export function toZonedIso(epochMs: number, timeZone: string): string {
  const w = wallClockAt(epochMs, timeZone);
  const offsetMinutes = Math.round(offsetMs(epochMs, timeZone) / 60000);
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  return `${ymd(w)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** WooCommerce's `*_gmt` fields (`2026-10-13T08:35:00`, UTC, no offset) shown in store time; null stays null. */
export function wooGmtToZonedIso(gmt: string | null | undefined, timeZone: string): string | null {
  if (!gmt) return null;
  const epochMs = Date.parse(`${gmt}Z`);
  return Number.isNaN(epochMs) ? null : toZonedIso(epochMs, timeZone);
}

function parseCalendarDate(value: string): Pick<WallClock, 'year' | 'month' | 'day'> | null {
  const m = DATE_ONLY.exec(value);
  if (!m) return null;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  // Reject dates JavaScript would silently roll over, like 2026-02-30.
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** Resolves "today", "yesterday" or "YYYY-MM-DD" to a calendar date in the store's zone. */
export function resolveStoreDate(spec: string, timeZone: string, now: Date): string {
  const trimmed = spec.trim().toLowerCase();
  if (trimmed === 'today' || trimmed === 'yesterday') {
    const today = wallClockAt(now.getTime(), timeZone);
    if (trimmed === 'today') return ymd(today);
    const yesterday = new Date(Date.UTC(today.year, today.month - 1, today.day) - DAY_MS);
    return yesterday.toISOString().slice(0, 10);
  }
  if (!parseCalendarDate(trimmed)) {
    throw new UserInputError(`date must be "today", "yesterday" or a calendar date like 2026-10-13, got ${JSON.stringify(spec)}`);
  }
  return trimmed;
}

export interface DayWindow {
  /** Calendar date in the store's zone, YYYY-MM-DD. */
  date: string;
  timezone: string;
  /** Start of the day, store-local ISO 8601 (inclusive). */
  from: string;
  /** Start of the next day, store-local ISO 8601 (exclusive). */
  to: string;
  /** Naive UTC for WooCommerce's `after` param (see dayWindow). */
  wooAfter: string;
  /** Naive UTC for WooCommerce's `before` param. */
  wooBefore: string;
}

/**
 * The store-local day as a UTC window for WooCommerce. A day is not always 24 h: DST change days are 23 or
 * 25 h long, which is why both ends are computed from local midnights instead of adding 24 h.
 */
export function dayWindow(date: string, timeZone: string): DayWindow {
  const day = parseCalendarDate(date);
  if (!day) throw new UserInputError(`not a calendar date: ${JSON.stringify(date)}`);
  const start = zonedToEpoch({ ...day, hour: 0, minute: 0, second: 0 }, timeZone);
  const next = new Date(Date.UTC(day.year, day.month - 1, day.day) + DAY_MS);
  const end = zonedToEpoch(
    { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(), hour: 0, minute: 0, second: 0 },
    timeZone,
  );
  return {
    date,
    timezone: timeZone,
    from: toZonedIso(start, timeZone),
    to: toZonedIso(end, timeZone),
    // WooCommerce's after/before are both exclusive (WP_Date_Query, inclusive=false) and dates have
    // one-second precision, so "after 23:59:59" is how we say "from 00:00:00 inclusive".
    wooAfter: toNaiveUtc(start - 1000),
    wooBefore: toNaiveUtc(end),
  };
}

/**
 * Parses a caller-supplied instant for after/before. With an offset (`Z`, `+05:30`) it is unambiguous;
 * a bare date or date-time is read as store-local time, which is what a shop owner means by "since 9am".
 */
export function parseInstant(value: string, timeZone: string, field: string): number {
  const trimmed = value.trim();
  if (DATE_TIME_WITH_OFFSET.test(trimmed)) {
    const epochMs = Date.parse(trimmed);
    if (!Number.isNaN(epochMs)) return epochMs;
  }
  const date = parseCalendarDate(trimmed);
  if (date) return zonedToEpoch({ ...date, hour: 0, minute: 0, second: 0 }, timeZone);
  const m = NAIVE_DATE_TIME.exec(trimmed);
  const day = m && parseCalendarDate(`${m[1]}-${m[2]}-${m[3]}`);
  if (m && day && Number(m[4]) < 24 && Number(m[5]) < 60 && Number(m[6] ?? 0) < 60) {
    return zonedToEpoch({ ...day, hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6] ?? 0) }, timeZone);
  }
  throw new UserInputError(
    `${field} must be ISO 8601 like 2026-10-13T09:00:00+05:30 (or without an offset for store time), got ${JSON.stringify(value)}`,
  );
}
