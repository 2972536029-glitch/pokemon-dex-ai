import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  server: {
    port: 5177,
    open: true,
    // Dev-only: forward /api to the TS server (npm run dev:ai, port 5178).
    // Production doesn't need this — Express serves dist/ and /api itself.
    proxy: {
      '/api': 'http://127.0.0.1:5178',
    },
  },
});
