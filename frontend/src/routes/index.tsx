import type { RouteObject } from 'react-router-dom';
import { AppShell, PlatformShell } from '@/components/layout';
import { NotFoundPlaceholder } from '@/pages/_placeholders';
import { Attendance } from '@/pages/Attendance';
import PatientProfile, { PatientsList } from '@/pages/Patients';
import { Login } from '@/pages/Login';
import { ForgotPassword } from '@/pages/ForgotPassword';
import { ResetPassword } from '@/pages/ResetPassword';
import BudgetNew from '@/pages/Budget/New';
import Proposals from '@/pages/Proposals';
import Catalog from '@/pages/Catalog';
import Analytics from '@/pages/Analytics';
import ChannelsSettings from '@/pages/Settings/Channels';
import OperationSettings from '@/pages/Settings/Operation';
import Insurances from '@/pages/Settings/Insurances';
import AttendantsSettings from '@/pages/Settings/Attendants';
import CommissionsSettings from '@/pages/Settings/Commissions';
import AccountSettings from '@/pages/Settings/Account';
import ThemeSettings from '@/pages/Settings/Theme';
import UsersSettings from '@/pages/Settings/Users';
import InternalChat from '@/pages/InternalChat';
import QuickReplies from '@/pages/QuickReplies';
import Decisions from '@/pages/Decisions';
import Results from '@/pages/Results';
import Reconciliation from '@/pages/Reconciliation';
import ActiveSearch from '@/pages/ActiveSearch';
import Sales from '@/pages/Sales';
import PlatformTenants from '@/pages/Platform/Tenants';
import PlatformTenantDetail from '@/pages/Platform/TenantDetail';
import PlatformBilling from '@/pages/Platform/Billing';
import { RequireAuth, RequireRoles, RoleHomeRedirect } from './guards';
import { ADMIN_ONLY, MANAGER_PLUS, PLATFORM_ONLY, TENANT_ROLES } from './route-config';

/**
 * Árvore de rotas — docs/frontend/PAGES.md ("Mapa de Rotas").
 *
 * Como uma tela de verdade se pluga aqui:
 *   1. o agente da tela cria `src/pages/Attendance.tsx` exportando o componente;
 *   2. troca `element: <AttendancePlaceholder />` por `element: <Attendance />`;
 *   3. nada mais muda — guard, papéis, shell e sidebar já estão montados.
 *
 * Camadas (de fora para dentro):
 *   RequireAuth → RequireRoles(papéis da área) → Shell(sidebar + Outlet) → tela
 *
 * `/platform/*` usa `PlatformShell` porque tem identidade visual própria e não
 * herda o tema do tenant (PAGES.md §11).
 */
export const appRoutes: RouteObject[] = [
  { path: '/login', element: <Login /> },
  { path: '/forgot-password', element: <ForgotPassword /> },
  { path: '/reset-password', element: <ResetPassword /> },

  {
    element: <RequireAuth />,
    children: [
      // `/` → tela inicial do perfil (atendente → /attendance)
      { index: true, element: <RoleHomeRedirect /> },

      // ── Operação do laboratório ─────────────────────────────────────────
      {
        element: <RequireRoles requiredRoles={TENANT_ROLES} />,
        children: [
          {
            element: <AppShell />,
            children: [
              { path: 'attendance', element: <Attendance /> },
              { path: 'patients', element: <PatientsList /> },
              { path: 'patients/:id', element: <PatientProfile /> },
              { path: 'budget/new', element: <BudgetNew /> },
              { path: 'proposals', element: <Proposals /> },
              { path: 'catalog', element: <Catalog /> },
              { path: 'analytics', element: <Analytics /> },
              { path: 'internal-chat', element: <InternalChat /> },
              { path: 'quick-replies', element: <QuickReplies /> },
              { path: 'sales', element: <Sales /> },
              { path: 'settings/account', element: <AccountSettings /> },
            ],
          },
        ],
      },

      // ── Configuração: gestor+ ───────────────────────────────────────────
      {
        element: <RequireRoles requiredRoles={MANAGER_PLUS} />,
        children: [
          {
            element: <AppShell />,
            children: [
              { path: 'decisions', element: <Decisions /> },
              { path: 'results', element: <Results /> },
              { path: 'reconciliation', element: <Reconciliation /> },
              { path: 'active-search', element: <ActiveSearch /> },
              { path: 'settings/channels', element: <ChannelsSettings /> },
              { path: 'settings/operation', element: <OperationSettings /> },
              { path: 'settings/insurances', element: <Insurances /> },
              { path: 'settings/attendants', element: <AttendantsSettings /> },
              { path: 'settings/commissions', element: <CommissionsSettings /> },
            ],
          },
        ],
      },

      // ── Configuração: admin ─────────────────────────────────────────────
      {
        element: <RequireRoles requiredRoles={ADMIN_ONLY} />,
        children: [
          {
            element: <AppShell />,
            children: [
              { path: 'settings/users', element: <UsersSettings /> },
              { path: 'settings/theme', element: <ThemeSettings /> },
            ],
          },
        ],
      },

      // ── Console da plataforma (isolado) ─────────────────────────────────
      {
        element: <RequireRoles requiredRoles={PLATFORM_ONLY} />,
        children: [
          {
            element: <PlatformShell />,
            children: [
              { path: 'platform/tenants', element: <PlatformTenants /> },
              { path: 'platform/tenants/:id', element: <PlatformTenantDetail /> },
              { path: 'platform/billing', element: <PlatformBilling /> },
            ],
          },
        ],
      },

      { path: '*', element: <NotFoundPlaceholder /> },
    ],
  },
];

export { RequireAuth, RequireRoles, RoleHomeRedirect } from './guards';
export {
  APP_ROUTES,
  ROLE_HOME,
  TENANT_ROLES,
  MANAGER_PLUS,
  ADMIN_ONLY,
  PLATFORM_ONLY,
  canAccess,
  homeFor,
  sidebarRoutesFor,
} from './route-config';
export type { AppRoute, NavIcon } from './route-config';
export { PLATFORM_THEME } from './platform-theme';
