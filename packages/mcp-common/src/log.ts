// One JSON object per line on stdout, so `kubectl logs` output is greppable and machine-readable.
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const order: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = order[(process.env.LOG_LEVEL as LogLevel) ?? 'info'] ?? order.info;

export function log(level: LogLevel, msg: string, fields: Record<string, unknown> = {}): void {
  if (order[level] < threshold) return;
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), level, msg, ...fields })}\n`);
}
