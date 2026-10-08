import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    rollupOptions: {
      output: {
        // react 全家桶拆 vendor:业务代码改动不再打穿长缓存的基础包
        manualChunks(id) {
          // 第三方依赖统一入 vendor:业务迭代不再打穿长缓存的基础包
          if (id.includes("node_modules")) return "vendor";
        },
      },
    },
  },
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
