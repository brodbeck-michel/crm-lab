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
  | 'reconciliation'
  | 'active-search'
  | 'sales'
  | 'channels'
  | 'operation'
  | 'insurances'
  | 'attendants'
  | 'commissions'
  | 'users'
  | 'theme'
  | 'tenants'
  | 'billing';

/** Papéis de tenant. `platform_operator` NÃO entra — o console é isolado (PAGES.md §11). */
export const TENANT_ROLES: readonly UserRole[] = ['attendant', 'manager', 'admin'] as const;
export const MANAGER_PLUS: readonly UserRole[] = ['manager', 'admin'] as const;
export const ADMIN_ONLY: readonly UserRole[] = ['admin'] as const;
export const PLATFORM_ONLY: readonly UserRole[] = ['platform_operator'] as const;

/** Grupos (accordion) do trilho da Sidebar — CRMLAB-4/D-129. */
export type NavGroupId = 'comunicacao' | 'gestao' | 'configuracoes';

export interface NavGroup {
  id: NavGroupId;
  label: string;
}

/**
 * Ordem de exibição dos grupos na Sidebar (decidida no CRMLAB-4, revisada em
 * D-129: "Comercial" + "LIS / Operação Laboratorial" viraram um único grupo
 * "Gestão"). Itens sem `group` aparecem soltos, antes de todos os grupos.
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  { id: 'comunicacao', label: 'Comunicação' },
  { id: 'gestao', label: 'Gestão' },
  { id: 'configuracoes', label: 'Configurações' },
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
    path: '/patients',
    label: 'Pacientes',
    requiredRoles: TENANT_ROLES,
    inSidebar: true,
    icon: 'patients',
  },
  { path: '/patients/:id', label: 'Ficha do Paciente', requiredRoles: TENANT_ROLES, inSidebar: false },
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
    inSidebar: true,
    icon: 'catalog',
    group: 'configuracoes',
  },
  {
    path: '/analytics',
    label: 'Conversão',
    requiredRoles: TENANT_ROLES,
    inSidebar: true,
    icon: 'analytics',
    group: 'gestao',
  },
  {
    path: '/internal-chat',
    label: 'Chat Interno',
    requiredRoles: TENANT_ROLES,
    inSidebar: true,
    icon: 'chat',
    group: 'comunicacao',
  },
  {
    path: '/quick-replies',
    label: 'Respostas rápidas',
    requiredRoles: TENANT_ROLES,
    inSidebar: true,
    icon: 'quick-replies',
    group: 'comunicacao',
  },
  {
    path: '/sales',
    label: 'Vendas',
    requiredRoles: TENANT_ROLES,
    inSidebar: true,
    icon: 'sales',
  },
  {
    path: '/decisions',
    label: 'Decisões',
    requiredRoles: MANAGER_PLUS,
    inSidebar: true,
    icon: 'decisions',
    group: 'gestao',
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
    inSidebar: true,
    icon: 'reconciliation',
    group: 'gestao',
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
    inSidebar: true,
    icon: 'insurances',
    group: 'configuracoes',
  },
  {
    path: '/settings/attendants',
    label: 'Atendentes',
    requiredRoles: MANAGER_PLUS,
    inSidebar: true,
    icon: 'attendants',
    group: 'configuracoes',
  },
  {
    path: '/settings/commissions',
    label: 'Comissão',
    requiredRoles: MANAGER_PLUS,
    inSidebar: true,
    icon: 'commissions',
    group: 'configuracoes',
  },
  {
    path: '/settings/users',
    label: 'Usuários & Permissões',
    requiredRoles: ADMIN_ONLY,
    inSidebar: true,
    icon: 'users',
    group: 'configuracoes',
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
export function sidebarRoutesFor(role: UserRole | null | undefined): AppRoute[] {
  return APP_ROUTES.filter((route) => route.inSidebar && canAccess(role, route.requiredRoles));
}

export interface SidebarGroupSection {
  id: NavGroupId;
  label: string;
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
    items: visible.filter((route) => route.group === group.id),
  })).filter((group) => group.items.length > 0);

  return { ungrouped, groups };
}
