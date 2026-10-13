// Small display helpers for dates and durations. Everything is shown in the viewer's local time zone.

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const dateTime = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
const timeWithSeconds = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dayMonth = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

/** "12 seconds ago", "in 3 days". Null-safe: returns `fallback` when there is no date. */
export function formatRelative(iso: string | null | undefined, fallback = 'Never', now = Date.now()): string {
  if (!iso) return fallback;
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 5) return 'just now';
  if (abs < 60) return relative.format(seconds, 'second');
  if (abs < 3600) return relative.format(Math.round(seconds / 60), 'minute');
  if (abs < 86_400) return relative.format(Math.round(seconds / 3600), 'hour');
  return relative.format(Math.round(seconds / 86_400), 'day');
}

export function formatDateTime(iso: string | null | undefined, fallback = 'Never'): string {
  return iso ? dateTime.format(new Date(iso)) : fallback;
}

/** Audit timestamps: time with seconds for today, plus the date for older rows. */
export function formatAuditTime(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const sameDay = date.toDateString() === now.toDateString();
  return sameDay ? timeWithSeconds.format(date) : `${dayMonth.format(date)}, ${timeWithSeconds.format(date)}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}
