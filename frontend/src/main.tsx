import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@/styles/tokens.css';
import { App } from './App';

/**
 * Bootstrap do frontend (pendência registrada em docs/STATUS.md pelo
 * Agent-UI-Foundation: `index.html` aponta para `/src/main.tsx`).
 *
 * `tokens.css` entra ANTES da árvore: as CSS vars precisam existir antes do
 * primeiro paint. `applyTheme()` do tenant sobrescreve só as 5 cores base
 * depois, no login ou na restauração da sessão (D-005).
 *
 * `<ToastProvider>` envolve a árvore dentro de `App` — o guard de rota
 * depende dele para avisar quando o perfil não tem permissão.
 */
const container = document.getElementById('root');
if (!container) {
  throw new Error('Elemento #root não encontrado em index.html');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
