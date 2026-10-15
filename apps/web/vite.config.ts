import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = process.env.VITE_DEV_API ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Same-origin in development: the browser talks only to Vite, which forwards API/auth calls.
    proxy: {
      '/api': { target: api, ws: true },
      '/auth': { target: api },
      '/ingest': { target: api },
    },
  },
  build: {
    sourcemap: false,
  },
});
