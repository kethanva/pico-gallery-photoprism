import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: '.',
  publicDir: 'public',
  // Resolve workspace types straight from source so the client neither needs nor
  // goes stale against a prebuilt shared/dist (dev and build stay in lockstep).
  resolve: {
    alias: {
      '@pico/shared': resolve(__dirname, '../shared/src/index.ts'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8188', changeOrigin: true },
    },
  },
});
