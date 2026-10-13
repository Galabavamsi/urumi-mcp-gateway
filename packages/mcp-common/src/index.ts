export { bearerMatches } from './auth.ts';
export { log, type LogLevel } from './log.ts';
export { serveMcp, type DrainOptions, type McpHttpServer, type ServeMcpOptions } from './serve.ts';

/** Reads a required environment variable or exits with a clear message (fail fast at startup). */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    process.stderr.write(`missing required environment variable ${name}\n`);
    process.exit(1);
  }
  return value;
}
