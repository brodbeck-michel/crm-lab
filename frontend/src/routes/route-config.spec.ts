import { describe, expect, it } from 'vitest';
import { APP_ROUTES, canAccess, sidebarRoutesFor } from './route-config';

/**
 * `route-config.ts` — Onda 10 (PAGES.md "Telas do LIS").
 * Testa as funções puras que a Sidebar e o guard de rota consomem; o
 * comportamento de guard em si (redirect/toast) já é coberto por
 * `guards.spec.tsx`.
 */
describe('route-config — domínio LIS (Onda 10)', () => {
  it('atendente vê /sales no trilho (TENANT_ROLES) mas não as telas gestor+', () => {
    const paths = sidebarRoutesFor('attendant').map((r) => r.path);

    expect(paths).toContain('/sales');
    expect(paths).not.toContain('/results');
    expect(paths).not.toContain('/reconciliation');
    expect(paths).not.toContain('/active-search');
    expect(paths).not.toContain('/settings/attendants');
    expect(paths).not.toContain('/settings/commissions');
  });

  it('gestor (manager) vê as 3 telas de leitura do LIS + Atendentes + Comissão', () => {
    const paths = sidebarRoutesFor('manager').map((r) => r.path);

    expect(paths).toEqual(
      expect.arrayContaining([
        '/results',
        '/reconciliation',
        '/active-search',
        '/settings/attendants',
        '/settings/commissions',
        '/sales',
      ]),
    );
  });

  it('platform_operator não vê nenhuma rota do domínio LIS', () => {
    const paths = sidebarRoutesFor('platform_operator').map((r) => r.path);

    for (const path of [
      '/results',
      '/reconciliation',
      '/active-search',
      '/sales',
      '/settings/attendants',
      '/settings/commissions',
    ]) {
      expect(paths).not.toContain(path);
    }
  });

  it('cada rota nova do LIS declara os papéis do PAGES.md §14-19', () => {
    const byPath = Object.fromEntries(APP_ROUTES.map((r) => [r.path, r]));

    expect(canAccess('manager', byPath['/results']!.requiredRoles)).toBe(true);
    expect(canAccess('attendant', byPath['/results']!.requiredRoles)).toBe(false);

    expect(canAccess('attendant', byPath['/sales']!.requiredRoles)).toBe(true);
    expect(canAccess('manager', byPath['/sales']!.requiredRoles)).toBe(true);

    expect(canAccess('manager', byPath['/settings/commissions']!.requiredRoles)).toBe(true);
    expect(canAccess('admin', byPath['/settings/commissions']!.requiredRoles)).toBe(true);
  });
});
