import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // API_URL=https://localhost:3000 when the API server runs with HTTPS; its self-signed localhost certificate is accepted by the dev proxy only.
  server: { port: 5173, proxy: Object.fromEntries(['/api', '/auth'].map((p) => [p, { target: process.env.API_URL || 'http://localhost:3000', secure: false, ws: true }])) },
  build: { outDir: 'dist', sourcemap: false },
  test: { environment: 'jsdom', globals: true, setupFiles: ['./test/setup.js'], include: ['test/**/*.test.{js,jsx}'] },
});
