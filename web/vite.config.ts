import { fileURLToPath, URL } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react()],
  build: {
    outDir: fileURLToPath(new URL('./dist', import.meta.url)),
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'react-vendor',
              test: /node_modules\/(?:react|react-dom|scheduler)\//u,
            },
            {
              name: 'antd-vendor',
              test: /node_modules\/(?:antd|@ant-design|rc-[^/]+)\//u,
            },
          ],
        },
      },
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5174,
    proxy: {
      '/api': 'http://127.0.0.1:8051',
      '/web-api': 'http://127.0.0.1:8051',
    },
  },
});
