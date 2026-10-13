// drizzle-kit only generates SQL from src/db/schema.ts here (no database connection needed).
// The generated files under ./drizzle are committed and applied by the gateway at startup.
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
