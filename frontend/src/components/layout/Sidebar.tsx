import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { cn, Badge } from '@/components/ui';
import { Avatar } from '@/components/shared';
import { useAuthStore, useUIStore, useSidebarGroupsStore, selectRole, selectUser } from '@/stores';
import { useLogout } from '@/hooks';
import { sidebarSectionsFor, type AppRoute } from '@/routes/route-config';
import { internalChatApi, operationApi, queryKeys, staleTimes } from '@/api';
import { NavGlyph } from './NavGlyph';

/**
 * Sidebar — docs/frontend/COMPONENTS.md (`layout/`) + DESIGN_TOKENS.md (Layouts).
 * Variante "Trilho de grupo" (CRMLAB-4, 2ª rodada — v1 rejeitada pelo usuário).
 *
 * 272px expandido / 64px recolhido, `position: sticky`, altura de viewport.
 * Item: ícone (`flex: 0 0 38px`) + label; hover `accent-100`; ativo com fundo
 * `accent-500` sólido e texto `text-bg` (único destaque preenchido por vez —
 * a faixa de grupo nunca usa a cor do ativo, só `accent-100`).
 *
 * **O CONTEÚDO do trilho muda por perfil; a ESTRUTURA não** — os itens saem de
 * `sidebarSectionsFor(role)`, que filtra as mesmas rotas de `sidebarRoutesFor`
 * (fonte que o guard de rota usa), só que organizadas em soltos + grupos.
 *
 * Grupos (accordion, CRMLAB-4): abertos por padrão, estado por grupo
 * persistido em localStorage por usuário (`sidebar-groups.store`). Grupo sem
 * nenhum item visível para o perfil não aparece. Cabeçalho de grupo MESMO
 * TAMANHO do item (`text-label`), diferença só no peso (bold × medium) — v1
 * usava `font-heading text-section` maior, o usuário não aprovou (D-127
 * superseded). Um único divisor entre os itens soltos e o bloco de grupos;
 * filhos indentados atrás de um trilho vertical (`border-l`).
 *
 * Recolhe sozinho para atendente na tela de inbox (PAGES.md §2).
 */

const EXPANDED_WIDTH = 272;
const COLLAPSED_WIDTH = 64;

/**
 * Ambiente do BUILD (`VITE_APP_ENV`, build-time como as outras `VITE_*`).
 * `production` (default) nao mostra nada; qualquer outro valor pinta um selo
 * no rodape do trilho. Existe para uma coisa so: ninguem confundir a aba de
 * homologacao com a de producao e mexer no dado real achando que era teste.
 * Ver docs/guides/ENVIRONMENTS.md.
 */
const APP_ENV = import.meta.env.VITE_APP_ENV ?? 'production';
const IS_PRODUCTION = APP_ENV === 'production';

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

  const { ungrouped, groups } = sidebarSectionsFor(role);
  const brand = tenant?.theme.brandName ?? tenant?.name ?? 'CRM Laboratório';
  // Seleciona `openByUser` (não a função `isGroupOpen`) para re-renderizar quando o estado muda.
  const openGroupsByUser = useSidebarGroupsStore((state) => state.openByUser);
  const toggleGroup = useSidebarGroupsStore((state) => state.toggleGroup);
  const userId = user?.id ?? '';

  // Sino de "Decisões" (PAGES.md §12): mesmo retrato de §10, cache compartilhado
  // com Operation.tsx e Decisions.tsx — não é uma segunda chamada.
  const hasDecisionsRoute =
    ungrouped.some((route) => route.path === '/decisions') ||
    groups.some((group) => group.items.some((route) => route.path === '/decisions'));
  const overviewQuery = useQuery({
    queryKey: queryKeys.operationOverview({}),
    queryFn: () => operationApi.overview({}),
    enabled: hasDecisionsRoute,
    staleTime: staleTimes.operation,
    refetchInterval: 60_000,
  });
  const pendingDecisionsCount = overviewQuery.data?.pendingDecisions.total ?? 0;

  // Badge de "Chat Interno" (D-130): mesma query/cache da tela de chat
  // (`queryKeys.internalChannels()`) — sem endpoint novo, já invalidada por
  // `internal_chat.new_message` e por `markRead` em `api/ws.ts`.
  const hasInternalChatRoute =
    ungrouped.some((route) => route.path === '/internal-chat') ||
    groups.some((group) => group.items.some((route) => route.path === '/internal-chat'));
  const channelsQuery = useQuery({
    queryKey: queryKeys.internalChannels(),
    queryFn: () => internalChatApi.channels(),
    enabled: hasInternalChatRoute,
  });
  const internalChatUnreadCount =
    channelsQuery.data?.channels.reduce((total, channel) => total + channel.unreadCount, 0) ?? 0;

  const navigate = useNavigate();
  const logout = useLogout();
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const userMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!userMenuOpen) return;
    function onPointerDown(event: MouseEvent) {
      if (!userMenuRef.current?.contains(event.target as Node)) setUserMenuOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setUserMenuOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [userMenuOpen]);

  const handleLogout = async () => {
    setUserMenuOpen(false);
    await logout();
    navigate('/login');
  };

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
      className="sticky top-0 flex h-screen flex-col gap-xl overflow-hidden bg-surface"
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

      <nav
        className="flex min-h-0 flex-1 flex-col gap-xs overflow-y-auto"
        style={{ scrollbarWidth: 'thin', scrollbarColor: 'var(--color-neutral-400) transparent' }}
      >
        {ungrouped.map((route) => (
          <SidebarNavItem
            key={route.path}
            route={route}
            collapsed={collapsed}
            pendingDecisionsCount={pendingDecisionsCount}
            internalChatUnreadCount={internalChatUnreadCount}
          />
        ))}

        {groups.length > 0 && <hr className="my-sm border-t border-neutral-300" />}

        {groups.map((group) => {
          const open = openGroupsByUser[userId]?.[group.id] ?? true;
          const hasActiveChild = group.items.some((route) => route.path === pathname);
          // D-130: só o grupo que contém "Chat Interno" herda o total de não lidas.
          const groupUnreadCount = group.items.some((route) => route.path === '/internal-chat')
            ? internalChatUnreadCount
            : 0;
          return (
            <div key={group.id}>
              <button
                type="button"
                onClick={() => toggleGroup(userId, group.id)}
                title={collapsed ? group.label : undefined}
                aria-expanded={open}
                className={cn(
                  'flex w-full items-start gap-sm rounded-md px-xs py-xs text-left',
                  'font-body text-label font-bold text-text',
                  open ? 'bg-accent-100' : 'hover:bg-neutral-100',
                  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-500 focus-visible:outline-offset-2',
                )}
              >
                <span
                  style={{ flex: '0 0 38px', paddingTop: '4px' }}
                  className="flex h-[16px] items-center justify-center text-neutral-500 transition-transform"
                  aria-hidden="true"
                >
                  <span
                    className="inline-block transition-transform duration-150"
                    style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)' }}
                  >
                    ▶
                  </span>
                </span>
                {!collapsed && (
                  <span className="min-w-0 flex-1 text-left" style={{ lineHeight: 1.3 }}>
                    {group.label}
                  </span>
                )}
                {!collapsed && !open && groupUnreadCount > 0 && (
                  <Badge
                    count={groupUnreadCount}
                    label={`${groupUnreadCount} mensagens não lidas em ${group.label}`}
                  />
                )}
                {!collapsed && !open && groupUnreadCount <= 0 && hasActiveChild && (
                  <span
                    aria-hidden="true"
                    className="mt-[6px] h-[6px] w-[6px] flex-none rounded-pill bg-accent-500"
                  />
                )}
              </button>
              {open && (
                <div className="ml-lg mt-xs flex flex-col gap-xs border-l-2 border-neutral-300 pl-sm">
                  {group.items.map((route) => (
                    <SidebarNavItem
                      key={route.path}
                      route={route}
                      collapsed={collapsed}
                      pendingDecisionsCount={pendingDecisionsCount}
                      internalChatUnreadCount={internalChatUnreadCount}
                      child
                    />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </nav>

      {user && (
        <div ref={userMenuRef} className="relative">
          <button
            type="button"
            onClick={() => setUserMenuOpen((open) => !open)}
            aria-haspopup="menu"
            aria-expanded={userMenuOpen}
            title={collapsed ? user.name : undefined}
            className="flex w-full min-w-0 items-center gap-sm rounded-md border-none bg-transparent p-0 text-left hover:bg-accent-100"
          >
            <Avatar name={user.name} size={36} />
            {!collapsed && (
              <span className="min-w-0 truncate font-body text-caption text-neutral-700">
                {user.name}
              </span>
            )}
          </button>

          {userMenuOpen && (
            <div
              role="menu"
              className={cn(
                'absolute bottom-full z-50 mb-xs w-[180px] rounded-md border border-neutral-200',
                'bg-surface py-xs shadow-md',
                collapsed ? 'left-0' : 'left-0 right-0 w-auto',
              )}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => void handleLogout()}
                className="w-full cursor-pointer border-none bg-transparent px-md py-xs text-left font-body text-label text-text hover:bg-accent-100"
              >
                Sair
              </button>
            </div>
          )}
        </div>
      )}

      {/* Selo de ambiente — ausente em produção, de propósito (ver APP_ENV). */}
      {!IS_PRODUCTION && (
        <span
          aria-label={`Ambiente de ${APP_ENV}`}
          className={cn(
            'inline-flex items-center justify-center self-start rounded-pill',
            'bg-accent2 px-sm font-body text-micro font-bold uppercase text-bg',
          )}
        >
          {collapsed ? 'HML' : APP_ENV}
        </span>
      )}

      {/* Versão do build — só o número, sem rótulo, quando o trilho recolhe. */}
      <span className="truncate font-body text-caption text-neutral-600">
        {collapsed ? __APP_VERSION__ : `v${__APP_VERSION__}`}
      </span>
    </aside>
  );
}

interface SidebarNavItemProps {
  route: AppRoute;
  collapsed: boolean;
  pendingDecisionsCount: number;
  /** Soma de `Channel.unreadCount` do Chat Interno (D-130). */
  internalChatUnreadCount: number;
  /** Item filho de um grupo (raio menor: `rounded-md` × `rounded-lg`). */
  child?: boolean;
}

/**
 * Um item de navegação (link), solto ou dentro de um grupo. Ativo: fundo
 * `accent-500` sólido + texto `text-bg` (único destaque preenchido do trilho —
 * a faixa de grupo nunca compete com essa cor).
 */
function SidebarNavItem({
  route,
  collapsed,
  pendingDecisionsCount,
  internalChatUnreadCount,
  child = false,
}: SidebarNavItemProps) {
  return (
    <NavLink
      to={route.path}
      title={collapsed ? route.label : undefined}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-sm px-xs py-xs font-body text-label no-underline transition-colors',
          child ? 'rounded-md' : 'rounded-lg',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-500 focus-visible:outline-offset-2',
          isActive ? 'bg-accent-500 font-semibold text-bg' : 'text-text hover:bg-accent-100',
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
      {route.path === '/decisions' && (
        <Badge count={pendingDecisionsCount} label={`${pendingDecisionsCount} decisão(ões) pendente(s)`} />
      )}
      {route.path === '/internal-chat' && (
        <Badge
          count={internalChatUnreadCount}
          label={`${internalChatUnreadCount} mensagens não lidas`}
        />
      )}
    </NavLink>
  );
}
