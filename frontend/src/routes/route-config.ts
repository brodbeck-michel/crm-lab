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
  | 'pipeline'
  | 'catalog'
  | 'analytics'
  | 'chat'
  | 'channels'
  | 'operation'
  | 'insurances'
  | 'users'
  | 'theme'
  | 'tenants'
  | 'billing';

/** Papéis de tenant. `platform_operator` NÃO entra — o console é isolado (PAGES.md §11). */
export const TENANT_ROLES: readonly UserRole[] = ['attendant', 'manager', 'admin'] as const;
export const MANAGER_PLUS: readonly UserRole[] = ['manager', 'admin'] as const;
export const ADMIN_ONLY: readonly UserRole[] = ['admin'] as const;
export const PLATFORM_ONLY: readonly UserRole[] = ['platform_operator'] as const;

export interface AppRoute {
  path: string;
  label: string;
  requiredRoles: readonly UserRole[];
  /** Aparece no trilho da Sidebar (o conteúdo muda por perfil; a estrutura não). */
  inSidebar: boolean;
  icon?: NavIcon;
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
    label: 'Catálogo',
    requiredRoles: TENANT_ROLES,
    inSidebar: true,
    icon: 'catalog',
  },
  {
    path: '/analytics',
    label: 'Conversão',
    requiredRoles: TENANT_ROLES,
    inSidebar: true,
    icon: 'analytics',
  },
  {
    path: '/internal-chat',
    label: 'Chat Interno',
    requiredRoles: TENANT_ROLES,
    inSidebar: true,
    icon: 'chat',
  },

  // ── Configuração ────────────────────────────────────────────────────────
  {
    path: '/settings/channels',
    label: 'Canais & Equipe',
    requiredRoles: MANAGER_PLUS,
    inSidebar: true,
    icon: 'channels',
  },
  {
    path: '/settings/operation',
    label: 'Gestão da Operação',
    requiredRoles: MANAGER_PLUS,
    inSidebar: true,
    icon: 'operation',
  },
  {
    path: '/settings/insurances',
    label: 'Convênios',
    requiredRoles: MANAGER_PLUS,
    inSidebar: true,
    icon: 'insurances',
  },
  {
    path: '/settings/users',
    label: 'Usuários & Permissões',
    requiredRoles: ADMIN_ONLY,
    inSidebar: true,
    icon: 'users',
  },
  {
    path: '/settings/theme',
    label: 'Personalização',
    requiredRoles: ADMIN_ONLY,
    inSidebar: true,
    icon: 'theme',
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
