import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { PageTabsContext } from '@/components/layout';
import { SegmentedControl } from '@/components/ui';
import { useAuthStore, selectRole } from '@/stores';
import { homeFor, registerTabsFor } from '@/routes/route-config';

/**
 * Cadastros (CRMLAB-143) — uma entrada só no trilho para Usuários, Exames,
 * Respostas rápidas, Atendentes e Convênios. Cada aba é a tela que já existia,
 * no endereço de sempre; este layout só fornece a faixa de abas, que o
 * `PageHeader` da tela desenha acima do título (`PageTabsContext`).
 * O perfil vê apenas as abas que já podia abrir (`registerTabsFor`).
 */
export function RegistersLayout() {
  const role = useAuthStore(selectRole);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const tabs = registerTabsFor(role);
  const current = tabs.find((tab) => tab.path === pathname)?.path ?? '';

  const strip =
    tabs.length > 1 ? (
      <SegmentedControl
        aria-label="Cadastros"
        size="md"
        fullWidth={false}
        options={tabs.map((tab) => ({ value: tab.path, label: tab.label }))}
        value={current}
        onChange={(path) => navigate(path)}
      />
    ) : null;

  return (
    <PageTabsContext.Provider value={strip}>
      <Outlet />
    </PageTabsContext.Provider>
  );
}

/** `/settings/registers` → primeira aba que o perfil enxerga. */
export function RegistersRedirect() {
  const role = useAuthStore(selectRole);
  const first = registerTabsFor(role)[0];
  return <Navigate to={first ? first.path : homeFor(role)} replace />;
}
