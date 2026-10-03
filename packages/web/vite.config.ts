import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Vite configuration.
 *
 * `outDir` is the directory the server serves as a static UI. The dev server proxies
 * `/api` to the backend so the UI and API share an origin during development, which
 * avoids CORS entirely in the common case.
 */
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: true,
    // Fail the build if the bundle grows unexpectedly rather than shipping it silently.
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5_173,
    strictPort: true,
    proxy: {
      '/api': {
        target: process.env.REPOATLAS_API_URL ?? 'http://127.0.0.1:4300',
        changeOrigin: true,
      },
    },
  },
});