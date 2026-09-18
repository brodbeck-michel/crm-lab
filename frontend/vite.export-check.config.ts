import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';
export default defineConfig({
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  base: './',
  build: {
    outDir: process.env.EXPORT_CHECK_OUT!,
    emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL('./export-check.html', import.meta.url)) },
  },
});
