import { useEffect } from 'react';
import { Outlet } from 'react-router-dom';
import type { ReactNode } from 'react';
import { cn } from '@/components/ui';
import { applyTheme } from '@/lib/theme';
import { useAuthStore } from '@/stores';
import { PLATFORM_THEME } from '@/routes/platform-theme';
import { Sidebar } from './Sidebar';

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
}

/**
 * Contêiner de página de leitura: `max-width 1180px`, `padding 30px 36px 48px`
 * (PAGES.md §3). Telas full-bleed (inbox, orçamento) NÃO usam este contêiner.
 */
export function PageContainer({ children, className }: PageContainerProps) {
  return (
    <div
      style={{ maxWidth: 1180, padding: '30px 36px 48px' }}
      className={cn('mx-auto flex w-full min-w-0 flex-col gap-lg', className)}
    >
      {children}
    </div>
  );
}
