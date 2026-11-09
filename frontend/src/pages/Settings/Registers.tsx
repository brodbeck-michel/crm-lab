import { Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { SegmentedControl } from '@/components/ui';
import { useAuthStore, selectRole } from '@/stores';
import { homeFor, registerTabsFor } from '@/routes/route-config';

/**
 * Cadastros (CRMLAB-143) — uma entrada só no trilho para Usuários, Exames,
 * Respostas rápidas, Atendentes e Convênios. Cada aba é a tela que já existia,
 * no endereço de sempre; este layout só desenha a faixa de abas acima dela.
 * O perfil vê apenas as abas que já podia abrir (`registerTabsFor`).
 */
export function RegistersLayout() {
  const role = useAuthStore(selectRole);
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const tabs = registerTabsFor(role);
  const current = tabs.find((tab) => tab.path === pathname)?.path ?? '';

  return (
    <>
      {tabs.length > 1 && (
        // Mesma caixa do `PageContainer` (1180px, 36px de lado) para alinhar com a tela abaixo.
        <div style={{ maxWidth: 1180, padding: '30px 36px 0' }} className="mx-auto w-full min-w-0">
          <div style={{ maxWidth: 160 * tabs.length }}>
            <SegmentedControl
              aria-label="Cadastros"
              options={tabs.map((tab) => ({ value: tab.path, label: tab.label }))}
              value={current}
              onChange={(path) => navigate(path)}
            />
          </div>
        </div>
      )}
      <Outlet />
    </>
  );
}

/** `/settings/registers` → primeira aba que o perfil enxerga. */
export function RegistersRedirect() {
  const role = useAuthStore(selectRole);
  const first = registerTabsFor(role)[0];
  return <Navigate to={first ? first.path : homeFor(role)} replace />;
}
