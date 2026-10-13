import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

// In production the SPA and the gateway share one origin (Traefik routes /api and /mcp to the gateway,
// everything else to nginx). In development we recreate that: Vite serves the SPA and proxies /api and /mcp
// to a running gateway, so the browser still sees a single origin and the session cookie just works.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const target = env.VITE_PROXY_TARGET || 'http://app.127-0-0-1.sslip.io';

  return {
    plugins: [react(), tailwindcss()],
    server: {
      port: 5173,
      proxy: {
        // changeOrigin rewrites the Host header so Traefik routes the request to the gateway.
        '/api': { target, changeOrigin: true },
        '/mcp': { target, changeOrigin: true },
      },
    },
    build: {
      // Hashed file names under /assets/ let nginx cache them for a year (see nginx.conf).
      assetsDir: 'assets',
      sourcemap: false,
    },
  };
});
