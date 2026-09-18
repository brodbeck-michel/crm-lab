import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import type { ReactNode } from 'react';
import { cn } from '@/components/ui';
import { applyTheme } from '@/lib/theme';
import { useAuthStore, useUIStore } from '@/stores';
import { PLATFORM_THEME } from '@/routes/platform-theme';
import ProposalModal from '@/components/proposal/ProposalModal';
import { Sidebar } from './Sidebar';

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
 */
export function AppShell() {
  return (
    <div className="flex min-h-screen w-full bg-bg font-body text-body text-text">
      <Sidebar />
      <main className="flex min-w-0 flex-1 flex-col">
        <Outlet />
      </main>
      <GlobalModals />
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

export interface PageContainerProps {
  children: ReactNode;
  className?: string;
  /**
   * Largura de PAINEL (1440px) em vez da largura de leitura (1180px). Reservado
   * a telas cujo conteúdo é uma GRADE de dados — `/results` (4 KPIs + 2 gráficos
   * + tabela de 10 colunas). Texto corrido continua no padrão: 1440px de linha
   * seria ilegível.
   */
  wide?: boolean;
}

/**
 * Contêiner de página de leitura: `max-width 1180px`, `padding 30px 36px 48px`
 * (PAGES.md §3). Com `wide`, 1440px e topo mais curto — ver PAGES.md §3.
 * Telas full-bleed (inbox, orçamento) NÃO usam este contêiner.
 */
export function PageContainer({ children, className, wide = false }: PageContainerProps) {
  return (
    <div
      style={{
        maxWidth: wide ? 1440 : 1180,
        padding: wide ? '24px 32px 48px' : '30px 36px 48px',
      }}
      className={cn('mx-auto flex w-full min-w-0 flex-col gap-lg', className)}
    >
      {children}
    </div>
  );
}
