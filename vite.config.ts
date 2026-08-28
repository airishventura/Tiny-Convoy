import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
    // No manual chunking. Rollup splits on the lazy-import boundaries the app
    // already has, which is what keeps Rapier out of the first load: only the
    // playable scene imports it, and only the playable scene is a lazy route.
  },
});
