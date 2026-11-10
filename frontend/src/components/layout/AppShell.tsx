import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import { useNewMessageAlerts } from '@/hooks/useNewMessageAlerts';
import { applyTheme } from '@/lib/theme';
import { useAuthStore, useUIStore } from '@/stores';
import { PLATFORM_THEME } from '@/routes/platform-theme';
import ProposalModal from '@/components/proposal/ProposalModal';
import { Sidebar } from './Sidebar';
import { TrafficNotice } from './TrafficNotice';

/**
 * Modais globais do tenant (proposta hoje). MORA DENTRO do `<AppShell/>`, que é
 * um elemento de ROTA — `RouterProvider` só dá contexto de router (`useNavigate`
 * etc.) para o que ele mesmo renderiza. Um irmão de `<RouterProvider/>` em
 * `App.tsx` (como era antes) fica FORA dessa árvore: `ProposalModal` usa
 * `useNavigate` (D-104, "Enviar orçamento"), e sem o contexto o React derruba
 * a árvore inteira — tela em branco ao abrir qualquer card do pipeline.
 */
function GlobalModals() {
  const modal = useUIStore((s) => s.activeModal);
  const closeModal = useUIStore((s) => s.closeModal);

  if (!modal) return null;

  if (modal.kind === 'proposal' && modal.id) {
    return <ProposalModal proposalId={modal.id} onClose={closeModal} />;
  }

  return null;
}

/**
 * AppShell — Sidebar + área de conteúdo com `<Outlet />`
 * (COMPONENTS.md `layout/`).
 *
 * A área de conteúdo é `min-w-0`: sem isso, uma tabela larga dentro dela
 * empurraria a sidebar (bug clássico de flex).
 *
 * Aviso de mensagem nova (CRMLAB-72, D-241 item 5): montado AQUI, e não só no
 * Atendimento, para avisar em qualquer tela do laboratório — como o WhatsApp
 * Web, que avisa enquanto a aba estiver aberta.
 *
 * `TrafficNotice` (CRMLAB-122, D-288): aviso de 429 em espera / várias abas.
 */
export function AppShell() {
  useNewMessageAlerts();
  return (
    <div className="flex min-h-screen w-full bg-bg font-body text-body text-text">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </main>
      <GlobalModals />
      <TrafficNotice />
    </div>
  );
}

/**
 * PlatformShell — mesmo esqueleto, identidade visual PRÓPRIA (PAGES.md §11).
 * Ao entrar em `/platform/*` o tema do tenant é substituído; ao sair, volta.
 */
export function PlatformShell() {
  const tenantTheme = useAuthStore((state) => state.theme);

  useEffect(() => {
    applyTheme(PLATFORM_THEME);
    return () => {
      if (tenantTheme) applyTheme(tenantTheme);
    };
  }, [tenantTheme]);

  return (
    <div
      data-platform-console="true"
      className="flex min-h-screen w-full bg-bg font-body text-body text-text"
    >
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </main>
    </div>
  );
}

// O contêiner de página mora em arquivo próprio (sem dependência da Sidebar).
export { PageContainer, PAGE_MAX_WIDTH, PAGE_PADDING } from './PageContainer';
export type { PageContainerProps } from './PageContainer';
