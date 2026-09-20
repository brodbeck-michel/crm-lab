/// <reference types="vitest" />
import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

/**
 * Versão do app = a do `package.json` da RAIZ do monorepo (fonte única — os
 * workspaces individuais ficam em `"*"`/1.0.0 e não são consumidos por
 * ninguém). Lida em build-time e inlinada como constante: sem chamada de
 * rede, sem endpoint novo só para isso.
 */
const rootPkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf-8'),
) as { version: string };

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  define: {
    __APP_VERSION__: JSON.stringify(rootPkg.version),
  },
  server: {
    port: 5173,
    // Mesmo origin em dev também (D-142) — o refresh token do CRMLAB-32 vive
    // num cookie httpOnly que só volta em requisição same-origin. Sem este
    // proxy, `VITE_API_URL`/`VITE_WS_URL` absolutos (`.env.example`) fariam o
    // browser chamar `localhost:3000` a partir de `localhost:5173`: origins
    // diferentes por porta, cookie nunca é enviado de volta, refresh sempre
    // 401 → tela de login em loop. Mesmo proxy que o nginx faz em produção
    // (D-051), só que aqui é o dev server que assume o papel.
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.spec.{ts,tsx}'],
    css: false,
  },
});
