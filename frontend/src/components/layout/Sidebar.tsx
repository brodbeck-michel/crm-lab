import { useEffect } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { cn } from '@/components/ui';
import { Avatar } from '@/components/shared';
import { useAuthStore, useUIStore, selectRole, selectUser } from '@/stores';
import { sidebarRoutesFor } from '@/routes/route-config';
import { NavGlyph } from './NavGlyph';

/**
 * Sidebar — docs/frontend/COMPONENTS.md (`layout/`) + DESIGN_TOKENS.md (Layouts).
 *
 * 244px expandido / 72px recolhido, `position: sticky`, altura de viewport.
 * Item: ícone (`flex: 0 0 38px`) + label; hover `accent-100`; ativo
 * `accent-200` + `shadow-sm`.
 *
 * **O CONTEÚDO do trilho muda por perfil; a ESTRUTURA não** — os itens saem de
 * `sidebarRoutesFor(role)`, mesma fonte que o guard de rota usa.
 *
 * Recolhe sozinho para atendente na tela de inbox (PAGES.md §2).
 */

const EXPANDED_WIDTH = 244;
const COLLAPSED_WIDTH = 72;

export function Sidebar() {
  const role = useAuthStore(selectRole);
  const user = useAuthStore(selectUser);
  const tenant = useAuthStore((state) => state.tenant);
  const collapsed = useUIStore((state) => state.sidebarCollapsed);
  const setSidebarCollapsed = useUIStore((state) => state.setSidebarCollapsed);
  const toggleSidebar = useUIStore((state) => state.toggleSidebar);
  const { pathname } = useLocation();

  // Atendente no inbox: trilho recolhido para dar as 3 colunas inteiras à tela.
  useEffect(() => {
    if (role === 'attendant' && pathname.startsWith('/attendance')) {
      setSidebarCollapsed(true);
    }
  }, [role, pathname, setSidebarCollapsed]);

  const items = sidebarRoutesFor(role);
  const brand = tenant?.theme.brandName ?? tenant?.name ?? 'CRM Laboratório';

  return (
    <aside
      data-testid="sidebar"
      data-collapsed={collapsed ? 'true' : 'false'}
      aria-label="Navegação principal"
      style={{
        width: collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH,
        flex: `0 0 ${collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH}px`,
        padding: '26px 16px',
      }}
      className="sticky top-0 flex h-screen flex-col gap-xl overflow-y-auto bg-surface"
    >
      <div className="flex items-center gap-sm">
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label={collapsed ? 'Expandir menu' : 'Recolher menu'}
          aria-expanded={!collapsed}
          style={{ flex: '0 0 38px' }}
          className="flex h-[38px] cursor-pointer items-center justify-center rounded-pill border-none bg-transparent font-body text-label text-text hover:bg-accent-100"
        >
          <span aria-hidden="true">{collapsed ? '»' : '«'}</span>
        </button>
        {!collapsed && (
          <span className="min-w-0 truncate font-heading text-section text-text">{brand}</span>
        )}
      </div>

      <nav className="flex min-h-0 flex-1 flex-col gap-xs">
        {items.map((route) => (
          <NavLink
            key={route.path}
            to={route.path}
            title={collapsed ? route.label : undefined}
            className={({ isActive }) =>
              cn(
                'flex items-center gap-sm rounded-md px-xs py-xs font-body text-label no-underline',
                'text-text transition-colors',
                isActive ? 'bg-accent-200 shadow-sm' : 'hover:bg-accent-100',
              )
            }
          >
            <span
              style={{ flex: '0 0 38px' }}
              className="flex h-[38px] items-center justify-center"
              aria-hidden="true"
            >
              {route.icon && <NavGlyph name={route.icon} />}
            </span>
            {!collapsed && <span className="min-w-0 truncate">{route.label}</span>}
          </NavLink>
        ))}
      </nav>

      {user && (
        <div className="flex items-center gap-sm">
          <Avatar name={user.name} size={36} />
          {!collapsed && (
            <span className="min-w-0 truncate font-body text-caption text-neutral-700">
              {user.name}
            </span>
          )}
        </div>
      )}
    </aside>
  );
}
