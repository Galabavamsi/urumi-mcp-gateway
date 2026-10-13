// Bundles one Node service into a single ESM file with esbuild, so container images only need
// `node` + the bundle (no node_modules at runtime). Usage: node scripts/build-app.mjs <entry.ts> <out.mjs>
import { build } from 'esbuild';

const [entry, outfile] = process.argv.slice(2);
if (!entry || !outfile) {
  console.error('usage: node scripts/build-app.mjs <entry.ts> <out.mjs>');
  process.exit(1);
}

await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  sourcemap: true,
  legalComments: 'none',
  // Some dependencies are CommonJS and call require(); give the ESM bundle a real require.
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
});
console.log(`built ${outfile}`);
