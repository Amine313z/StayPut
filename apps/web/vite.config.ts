import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// In development, the Worker runs next to Vite (`npm run dev:worker`, port 8787): the paths it
// answers are forwarded to it, as in production where both share one origin.
const worker = 'http://localhost:8787';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': worker,
      '/webhooks': worker,
      '/health': worker,
      '^/badge/': worker,
      '^/v/': worker,
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
});
