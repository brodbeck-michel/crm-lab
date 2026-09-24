import { useEffect, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { PanelLeftClose, PanelLeftOpen, ChevronRight, LogOut } from 'lucide-react';
import type { UserRole } from '@crm-lab/shared';
import { cn, Badge } from '@/components/ui';
import { Avatar } from '@/components/shared';
import { initials } from '@/lib/format';
import { useAuthStore, useUIStore, useSidebarGroupsStore, selectRole, selectUser } from '@/stores';
import { useLogout } from '@/hooks';
import { sidebarSectionsFor, type AppRoute } from '@/routes/route-config';
import { internalChatApi, operationApi, queryKeys, staleTimes } from '@/api';
import { NavGlyph } from './NavGlyph';

/**
 * Sidebar — docs/frontend/COMPONENTS.md (`layout/`) + DESIGN_TOKENS.md (Layouts).
 * Variante "Trilho flutuante" (CRMLAB-44, 3ª rodada — anatomia de
 * `Sidebar CRM - Design System.md`, mapeada para os tokens de tema do
 * tenant já existentes; a paleta fixa do documento NÃO foi adotada, ver
 * decisão registrada em CRMLAB-44).
 *
 * 264px expandido / 76px recolhido, `position: sticky`, flutuante (margem
 * 12px + `shadow-lg` + `rounded-lg`), altura de viewport menos a margem.
 *
 * **O CONTEÚDO do trilho muda por perfil; a ESTRUTURA não** — os itens saem
 * de `sidebarSectionsFor(role)`, que filtra as mesmas rotas de
 * `sidebarRoutesFor` (fonte que o guard de rota usa), só que organizadas em
 * soltos + grupos.
 *
 * Item ativo: fundo `accent-100` translúcido + barra de 3px à esquerda
 * (`accent-500`) — único destaque do trilho. Grupos (accordion, CRMLAB-4):
 * abertos por padrão, estado por grupo persistido em localStorage por
 * usuário (`sidebar-groups.store`); grupo sem nenhum item visível para o
 * perfil não aparece. Cabeçalho de grupo com ícone + label + chevron que
 * gira 90° ao abrir; filhos indentados atrás de um trilho vertical
 * (`border-l`).
 *
 * Recolhe sozinho para atendente na tela de inbox (PAGES.md §2). No modo
 * recolhido, clicar num grupo expande o trilho e abre o grupo.
 */

const EXPANDED_WIDTH = 264;
const COLLAPSED_WIDTH = 76;
const SIDEBAR_MARGIN = 12;

const ROLE_LABELS: Record<UserRole, string> = {
  attendant: 'Atendente',
  manager: 'Gerente',
  admin: 'Administrador',
  platform_operator: 'Operador da Plataforma',
};

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
      aria-label="Menu principal"
      style={{
        width: collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH,
        flex: `0 0 ${collapsed ? COLLAPSED_WIDTH : EXPANDED_WIDTH}px`,
        height: `calc(100vh - ${SIDEBAR_MARGIN * 2}px)`,
        margin: `${SIDEBAR_MARGIN}px 0 ${SIDEBAR_MARGIN}px ${SIDEBAR_MARGIN}px`,
        padding: '18px 12px 14px',
        transition: 'width 220ms ease',
      }}
      className="sticky top-[12px] flex flex-col gap-md rounded-lg bg-surface shadow-lg"
    >
      <div
        className={cn(
          'flex gap-sm px-xs',
          // Recolhido (76px): logo + botão não cabem lado a lado — o botão desce
          // para abaixo do logo, como no documento de especificação (CRMLAB-44).
          collapsed ? 'flex-col items-center' : 'items-center',
        )}
      >
        <span
          aria-hidden="true"
          style={{ width: 34, height: 34, flex: '0 0 34px' }}
          className="flex items-center justify-center rounded-md bg-accent-300 font-heading text-label font-bold text-accent-900"
        >
          {initials(brand)}
        </span>
        {!collapsed && (
          <span className="min-w-0 flex-1 truncate font-heading text-section text-text">{brand}</span>
        )}
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label={collapsed ? 'Expandir menu' : 'Recolher menu'}
          aria-expanded={!collapsed}
          style={{ flex: '0 0 30px' }}
          className="flex h-[30px] w-[30px] cursor-pointer items-center justify-center rounded-md border-none bg-transparent text-neutral-600 hover:bg-neutral-100"
        >
          {collapsed ? (
            <PanelLeftOpen size={18} strokeWidth={1.7} aria-hidden="true" />
          ) : (
            <PanelLeftClose size={18} strokeWidth={1.7} aria-hidden="true" />
          )}
        </button>
      </div>

      <hr className="border-t border-neutral-300" />

      <nav
        aria-label="Navegação principal"
        className="flex min-h-0 flex-1 flex-col gap-xs overflow-y-auto px-xs"
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
          const showActiveBg = open || (collapsed && hasActiveChild);
          const groupId = `sidebar-group-${group.id}`;
          return (
            <div key={group.id}>
              <button
                type="button"
                onClick={() => {
                  if (collapsed) {
                    setSidebarCollapsed(false);
                    if (!open) toggleGroup(userId, group.id);
                  } else {
                    toggleGroup(userId, group.id);
                  }
                }}
                title={collapsed ? group.label : undefined}
                aria-expanded={open}
                aria-controls={groupId}
                className={cn(
                  'flex w-full items-center gap-sm rounded-lg px-xs py-xs text-left',
                  'font-body text-label font-bold text-text',
                  showActiveBg ? 'bg-accent-100' : 'hover:bg-neutral-100',
                  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-500 focus-visible:outline-offset-2',
                )}
              >
                <span
                  style={{ flex: '0 0 38px' }}
                  className="relative flex h-[38px] items-center justify-center"
                  aria-hidden="true"
                >
                  <NavGlyph name={group.icon} />
                  {collapsed && groupUnreadCount > 0 && (
                    <span className="absolute right-0 top-0 h-[8px] w-[8px] rounded-pill border-2 border-surface bg-accent2" />
                  )}
                </span>
                {!collapsed && <span className="min-w-0 flex-1 truncate">{group.label}</span>}
                {!collapsed && (
                  <span
                    aria-hidden="true"
                    className="flex-none text-neutral-500 transition-transform duration-150"
                    style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', opacity: 0.7 }}
                  >
                    <ChevronRight size={15} strokeWidth={1.7} />
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
                    className="h-[6px] w-[6px] flex-none rounded-pill bg-accent-500"
                  />
                )}
              </button>
              {open && !collapsed && (
                <div
                  id={groupId}
                  className="ml-lg mt-xs flex flex-col gap-xs border-l-2 border-neutral-300 pl-sm"
                >
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

      <hr className="border-t border-neutral-300" />

      {user && (
        <div ref={userMenuRef} className="relative px-xs">
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
              <span className="min-w-0 flex-1 truncate">
                <span className="block truncate font-body text-label font-semibold text-text">
                  {user.name}
                </span>
                <span className="block truncate font-body text-caption text-neutral-600">
                  {ROLE_LABELS[user.role]} · v{__APP_VERSION__}
                </span>
              </span>
            )}
          </button>

          {userMenuOpen && (
            <div
              role="menu"
              className={cn(
                'absolute bottom-full z-50 mb-xs w-[180px] rounded-md border border-neutral-200',
                'bg-surface py-xs shadow-md',
                collapsed ? 'left-0' : 'left-xs right-xs w-auto',
              )}
            >
              <button
                type="button"
                role="menuitem"
                onClick={() => void handleLogout()}
                className="flex w-full cursor-pointer items-center gap-sm border-none bg-transparent px-md py-xs text-left font-body text-label text-text hover:bg-accent-100"
              >
                <LogOut size={16} strokeWidth={1.7} aria-hidden="true" />
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
            'mx-xs inline-flex items-center justify-center self-start rounded-pill',
            'bg-accent2 px-sm font-body text-micro font-bold uppercase text-bg',
          )}
        >
          {collapsed ? 'HML' : APP_ENV}
        </span>
      )}

      {/* Rodapé recolhido: só a versão, sem cargo (não cabe no ícone). */}
      {collapsed && (
        <span className="truncate px-xs font-body text-caption text-neutral-600">
          {__APP_VERSION__}
        </span>
      )}
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
 * `accent-100` translúcido + barra de 3px à esquerda (`accent-500`) — único
 * destaque preenchido do trilho (a faixa de grupo nunca compete com essa
 * cor). Recolhido: contador vira um dot de 8px sobre o ícone (CRMLAB-44).
 */
function SidebarNavItem({
  route,
  collapsed,
  pendingDecisionsCount,
  internalChatUnreadCount,
  child = false,
}: SidebarNavItemProps) {
  const count =
    route.path === '/decisions'
      ? pendingDecisionsCount
      : route.path === '/internal-chat'
        ? internalChatUnreadCount
        : 0;
  const badgeLabel =
    route.path === '/decisions'
      ? `${count} decisão(ões) pendente(s)`
      : route.path === '/internal-chat'
        ? `${count} mensagens não lidas`
        : undefined;

  return (
    <NavLink
      to={route.path}
      title={collapsed ? route.label : undefined}
      className={({ isActive }) =>
        cn(
          'relative flex items-center gap-sm px-xs py-xs font-body text-label no-underline transition-colors',
          child ? 'rounded-md' : 'rounded-lg',
          'focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent-500 focus-visible:outline-offset-2',
          isActive
            ? cn(
                'bg-accent-100 font-semibold text-text',
                "before:absolute before:inset-y-[9px] before:left-0 before:w-[3px] before:content-['']",
                'before:rounded-r-sm before:bg-accent-500',
              )
            : 'text-text hover:bg-neutral-100',
        )
      }
    >
      <span
        style={{ flex: '0 0 38px' }}
        className="relative flex h-[38px] items-center justify-center"
        aria-hidden="true"
      >
        {route.icon && <NavGlyph name={route.icon} />}
        {collapsed && count > 0 && (
          <span
            aria-hidden="true"
            className="absolute right-0 top-0 h-[8px] w-[8px] rounded-pill border-2 border-surface bg-accent2"
          />
        )}
      </span>
      {!collapsed && <span className="min-w-0 flex-1 truncate">{route.label}</span>}
      {!collapsed && count > 0 && <Badge count={count} label={badgeLabel} />}
    </NavLink>
  );
}
