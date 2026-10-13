// The Docker image copies only apps/gateway/dist/, so files the bundle reads at runtime must be in dist/ too.
// Today that is the SQL migrations: drizzle/ -> dist/drizzle/ (server.mjs resolves them next to itself).
import { cpSync, rmSync } from 'node:fs';

rmSync('dist/drizzle', { recursive: true, force: true });
cpSync('drizzle', 'dist/drizzle', { recursive: true });
console.log('copied drizzle/ -> dist/drizzle/');
