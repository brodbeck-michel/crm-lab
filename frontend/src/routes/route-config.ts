import type { UserRole } from '@crm-lab/shared';

/**
 * Mapa de Rotas — docs/frontend/PAGES.md.
 *
 * Fonte única de: caminho, rótulo pt-BR, papéis exigidos e presença no trilho
 * da Sidebar. A Sidebar lê DAQUI; o guard de rota lê DAQUI. Não existe uma
 * segunda lista para manter em sincronia.
 *
 * Lembrete: "a UI esconde, o servidor recusa". Este arquivo é UX, não
 * segurança (docs/contracts/FRONTEND_BACKEND.md §4).
 */

export type NavIcon =
  | 'inbox'
  | 'patients'
  | 'pipeline'
  | 'catalog'
  | 'analytics'
  | 'chat'
  | 'quick-replies'
  | 'decisions'
  | 'results'
  | 'active-search'
  | 'sales'
  | 'channels'
  | 'operation'
  | 'insurances'
  | 'attendants'
  | 'commissions'
  | 'rules'
  | 'integration'
  | 'users'
  | 'theme'
  | 'tenants'
  | 'billing'
  | 'account'
  | 'visitation'
  | 'doctors'
  | 'agenda';

/** Papéis de tenant. `platform_operator` NÃO entra — o console é isolado (PAGES.md §11). */
export const TENANT_ROLES: readonly UserRole[] = ['attendant', 'manager', 'admin'] as const;
export const MANAGER_PLUS: readonly UserRole[] = ['manager', 'admin'] as const;
export const ADMIN_ONLY: readonly UserRole[] = ['admin'] as const;
export const PLATFORM_ONLY: readonly UserRole[] = ['platform_operator'] as const;

/** Grupos (accordion) do trilho da Sidebar — CRMLAB-4/D-129; `visitacao` desde CRMLAB-86 (D-255). */
export type NavGroupId = 'visitacao' | 'gestao' | 'configuracoes';

export interface NavGroup {
  id: NavGroupId;
  label: string;
  /** Ícone do cabeçalho do grupo (CRMLAB-44, anatomia "trilho flutuante"). */
  icon: NavIcon;
}

/**
 * Ordem de exibição dos grupos na Sidebar (decidida no CRMLAB-4, revisada em
 * D-129: "Comercial" + "LIS / Operação Laboratorial" viraram um único grupo
 * "Gestão"). Itens sem `group` aparecem soltos, antes de todos os grupos.
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  // CRMLAB-85/86/87 (D-255, D-256): épico próprio — Agenda e Médicos.
  { id: 'visitacao', label: 'Visitação Médica', icon: 'visitation' },
  { id: 'gestao', label: 'Gestão', icon: 'analytics' },
  { id: 'configuracoes', label: 'Configurações', icon: 'operation' },
] as const;

export interface AppRoute {
  path: string;
  label: string;
  requiredRoles: readonly UserRole[];
  /** Aparece no trilho da Sidebar (o conteúdo muda por perfil; a estrutura não). */
  inSidebar: boolean;
  icon?: NavIcon;
  /** Grupo (accordion) do trilho. Ausente = item solto, fora de qualquer grupo. */
  group?: NavGroupId;
  /**
   * Caminhos que também acendem este item no trilho (CRMLAB-143): "Cadastros"
   * fica ativo em qualquer uma das suas abas, que mantêm o endereço próprio.
   */
  activePaths?: readonly string[];
}

/**
 * Abas da página "Cadastros" (CRMLAB-143). Cada aba é a tela que já existia,
 * no MESMO endereço de antes — favoritos e links salvos seguem valendo. Os
 * papéis são os da própria tela: o perfil só vê as abas que já podia abrir.
 */
export interface RegisterTab {
  path: string;
  label: string;
  requiredRoles: readonly UserRole[];
}

export const REGISTERS_PATH = '/settings/registers';

export const REGISTER_TABS: readonly RegisterTab[] = [
  { path: '/settings/users', label: 'Usuários', requiredRoles: ADMIN_ONLY },
  { path: '/catalog', label: 'Exames', requiredRoles: TENANT_ROLES },
  { path: '/quick-replies', label: 'Respostas rápidas', requiredRoles: TENANT_ROLES },
  { path: '/settings/attendants', label: 'Atendentes', requiredRoles: MANAGER_PLUS },
  { path: '/settings/insurances', label: 'Convênios', requiredRoles: MANAGER_PLUS },
] as const;

/** Abas de Cadastros visíveis para o perfil, na ordem de exibição. */
export function registerTabsFor(role: UserRole | null | undefined): RegisterTab[] {
  return REGISTER_TABS.filter((tab) => canAccess(role, tab.requiredRoles));
}

export const APP_ROUTES: readonly AppRoute[] = [
  // ── Operação do laboratório ──────────────────────────────────────────────
  {
    path: '/attendance',
    label: 'Atendimento',
    requiredRoles: TENANT_ROLES,
    inSidebar: true,
    icon: 'inbox',
  },
  {
    path: '/internal-chat',
    label: 'Chat Interno',
    requiredRoles: TENANT_ROLES,
    inSidebar: true,
    icon: 'chat',
  },
  { path: '/contacts/:id', label: 'Ficha do Contato', requiredRoles: TENANT_ROLES, inSidebar: false },
  { path: '/budget/new', label: 'Novo Orçamento', requiredRoles: TENANT_ROLES, inSidebar: false },
  {
    path: '/proposals',
    label: 'Propostas',
    requiredRoles: TENANT_ROLES,
    inSidebar: true,
    icon: 'pipeline',
  },
  {
    path: '/catalog',
    label: 'Cadastro de Exames',
    requiredRoles: TENANT_ROLES,
    inSidebar: false,
  },
  {
    path: '/analytics',
    label: 'Conversão',
    requiredRoles: TENANT_ROLES,
    inSidebar: false,
  },
  {
    path: '/quick-replies',
    label: 'Respostas rápidas',
    requiredRoles: TENANT_ROLES,
    inSidebar: false,
  },
  {
    // CRMLAB-87 (D-256): agenda de visitas — todos os papéis do laboratório veem e mexem em todas.
    path: '/visitation/agenda',
    label: 'Agenda',
    requiredRoles: TENANT_ROLES,
    inSidebar: true,
    icon: 'agenda',
    group: 'visitacao',
  },
  {
    // CRMLAB-86 (D-255): todos os papéis do laboratório veem e editam.
    path: '/visitation/doctors',
    label: 'Médicos',
    requiredRoles: TENANT_ROLES,
    inSidebar: true,
    icon: 'doctors',
    group: 'visitacao',
  },
  // CRMLAB-89 (D-261): ficha do médico com a linha do tempo — aberta pela lista, fora da Sidebar.
  { path: '/visitation/doctors/:id', label: 'Ficha do Médico', requiredRoles: TENANT_ROLES, inSidebar: false },
  {
    path: '/sales',
    label: 'Vendas',
    requiredRoles: TENANT_ROLES,
    inSidebar: true,
    icon: 'sales',
  },
  {
    path: '/contacts',
    label: 'Contatos',
    requiredRoles: TENANT_ROLES,
    inSidebar: true,
    icon: 'patients',
  },
  {
    path: '/decisions',
    label: 'Decisões',
    requiredRoles: MANAGER_PLUS,
    inSidebar: false,
  },

  // ── Domínio LIS (Onda 10) ────────────────────────────────────────────────
  {
    path: '/results',
    label: 'Resultados',
    requiredRoles: MANAGER_PLUS,
    inSidebar: true,
    icon: 'results',
    group: 'gestao',
  },
  {
    path: '/reconciliation',
    label: 'Conferência',
    requiredRoles: MANAGER_PLUS,
    inSidebar: false,
  },
  {
    path: '/active-search',
    label: 'Busca Ativa',
    requiredRoles: MANAGER_PLUS,
    inSidebar: true,
    icon: 'active-search',
    group: 'gestao',
  },

  // ── Configuração ────────────────────────────────────────────────────────
  {
    // CRMLAB-143: uma entrada só no trilho para os cinco cadastros (abas).
    path: REGISTERS_PATH,
    label: 'Cadastros',
    requiredRoles: TENANT_ROLES,
    inSidebar: true,
    icon: 'catalog',
    group: 'configuracoes',
    activePaths: REGISTER_TABS.map((tab) => tab.path),
  },
  {
    // CRMLAB-56 (D-190..D-194): regras do funil + comissão (seção 6). Todos
    // veem; gestor/admin editam. `/settings/commissions` redireciona para cá.
    path: '/settings/rules',
    label: 'Regras',
    requiredRoles: TENANT_ROLES,
    inSidebar: true,
    icon: 'rules',
    group: 'configuracoes',
  },
  {
    path: '/settings/channels',
    label: 'Canais & Equipe',
    requiredRoles: MANAGER_PLUS,
    inSidebar: true,
    icon: 'channels',
    group: 'configuracoes',
  },
  {
    path: '/settings/operation',
    label: 'Gestão da Operação',
    requiredRoles: MANAGER_PLUS,
    inSidebar: true,
    icon: 'operation',
    group: 'gestao',
  },
  {
    path: '/settings/insurances',
    label: 'Convênios',
    requiredRoles: MANAGER_PLUS,
    inSidebar: false,
  },
  {
    path: '/settings/attendants',
    label: 'Atendentes',
    requiredRoles: MANAGER_PLUS,
    inSidebar: false,
  },
  {
    path: '/settings/lis-integration',
    label: 'Integração LIS',
    requiredRoles: MANAGER_PLUS,
    inSidebar: true,
    icon: 'integration',
    group: 'configuracoes',
  },
  {
    path: '/settings/users',
    label: 'Usuários & Permissões',
    requiredRoles: ADMIN_ONLY,
    inSidebar: false,
  },
  {
    path: '/settings/account',
    label: 'Minha Conta',
    requiredRoles: TENANT_ROLES,
    inSidebar: false,
  },
  {
    path: '/settings/theme',
    label: 'Personalização',
    requiredRoles: ADMIN_ONLY,
    inSidebar: true,
    icon: 'theme',
    group: 'configuracoes',
  },

  // ── Console da plataforma (isolado) ─────────────────────────────────────
  {
    path: '/platform/tenants',
    label: 'Laboratórios Clientes',
    requiredRoles: PLATFORM_ONLY,
    inSidebar: true,
    icon: 'tenants',
  },
  {
    path: '/platform/billing',
    label: 'Assinaturas & Uso',
    requiredRoles: PLATFORM_ONLY,
    inSidebar: true,
    icon: 'billing',
  },
] as const;

/**
 * Destino do redirect de `/` por perfil.
 * PAGES.md fixa `atendente → /attendance`; os demais seguem a tela que o
 * perfil mais usa (registrado em PAGES.md — "Redirect por perfil").
 */
export const ROLE_HOME: Readonly<Record<UserRole, string>> = {
  attendant: '/attendance',
  manager: '/proposals',
  admin: '/proposals',
  platform_operator: '/platform/tenants',
};

export function homeFor(role: UserRole | null | undefined): string {
  return role ? ROLE_HOME[role] : '/login';
}

export function canAccess(role: UserRole | null | undefined, required: readonly UserRole[]): boolean {
  return role !== null && role !== undefined && required.includes(role);
}

/** Itens do trilho visíveis para o perfil. A ESTRUTURA é a mesma; o conteúdo muda. */
/** O item do trilho está ativo neste caminho? (o próprio `path` ou um de `activePaths`) */
export function isRouteActive(route: AppRoute, pathname: string): boolean {
  return route.path === pathname || (route.activePaths?.includes(pathname) ?? false);
}

export function sidebarRoutesFor(role: UserRole | null | undefined): AppRoute[] {
  return APP_ROUTES.filter((route) => route.inSidebar && canAccess(role, route.requiredRoles));
}

export interface SidebarGroupSection {
  id: NavGroupId;
  label: string;
  icon: NavIcon;
  items: AppRoute[];
}

export interface SidebarSections {
  /** Itens sem `group`, sempre visíveis, sem accordion. */
  ungrouped: AppRoute[];
  /** Grupos com ao menos um item visível para o perfil, na ordem de NAV_GROUPS. */
  groups: SidebarGroupSection[];
}

/**
 * Mesmos itens de `sidebarRoutesFor`, organizados em soltos + grupos
 * (accordion) para a Sidebar (CRMLAB-4). Grupo sem nenhum item visível para
 * o perfil não aparece.
 */
export function sidebarSectionsFor(role: UserRole | null | undefined): SidebarSections {
  const visible = sidebarRoutesFor(role);
  const ungrouped = visible.filter((route) => !route.group);
  const groups = NAV_GROUPS.map((group) => ({
    id: group.id,
    label: group.label,
    icon: group.icon,
    items: visible.filter((route) => route.group === group.id),
  })).filter((group) => group.items.length > 0);

  return { ungrouped, groups };
}
