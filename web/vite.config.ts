import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

/**
 * The SPA builds into `../public`, which is what the Express server serves
 * and what Plesk's document root points at.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // The web app consumes the shared package as source, so types and
      // helpers stay in step without a build step between them.
      '@sw/shared': fileURLToPath(new URL('../shared/src/index.ts', import.meta.url)),
    },
  },
  build: {
    outDir: '../public',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        // React is split out so it stays cached across app deploys.
        manualChunks: (id: string) => (id.includes('node_modules/react') ? 'react' : undefined),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/healthz': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});
