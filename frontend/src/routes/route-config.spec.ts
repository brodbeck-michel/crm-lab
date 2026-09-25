import { describe, expect, it } from 'vitest';
import { APP_ROUTES, NAV_GROUPS, canAccess, sidebarRoutesFor, sidebarSectionsFor } from './route-config';

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
    expect(paths).not.toContain('/settings/lis-integration');
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
        '/settings/lis-integration',
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
      '/settings/lis-integration',
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

describe('sidebarSectionsFor — grupos do trilho (CRMLAB-4, revisado em D-129)', () => {
  it('admin vê todos os grupos, na ordem Comunicação → Gestão → Configurações', () => {
    const { groups } = sidebarSectionsFor('admin');

    expect(groups.map((g) => g.id)).toEqual(['comunicacao', 'gestao', 'configuracoes']);
    expect(groups.map((g) => g.label)).toEqual(NAV_GROUPS.map((g) => g.label));
  });

  it('grupo Gestão reúne Conversão, Decisões, Resultados, Conferência, Busca Ativa e Gestão da Operação, nessa ordem (D-129: fusão de Comercial + LIS)', () => {
    const { groups } = sidebarSectionsFor('admin');
    const gestao = groups.find((g) => g.id === 'gestao');

    expect(gestao?.items.map((r) => r.label)).toEqual([
      'Conversão',
      'Decisões',
      'Resultados',
      'Conferência',
      'Busca Ativa',
      'Gestão da Operação',
    ]);
  });

  it('grupo Configurações inclui "Cadastro de Exames" (ex-Catálogo, movido em D-129), antes de Canais & Equipe', () => {
    const { groups } = sidebarSectionsFor('admin');
    const configuracoes = groups.find((g) => g.id === 'configuracoes');

    expect(configuracoes?.items.map((r) => r.label)).toEqual([
      'Cadastro de Exames',
      'Canais & Equipe',
      'Convênios',
      'Atendentes',
      'Comissão',
      'Integração LIS',
      'Usuários & Permissões',
      // CRMLAB-35: trocar a propria senha nao e privilegio de admin — e o
      // unico item TENANT_ROLES deste grupo alem de "Cadastro de Exames".
      'Minha Conta',
      'Personalização',
    ]);
  });

  it('itens soltos (fora de qualquer grupo) ficam em `ungrouped`', () => {
    const { ungrouped } = sidebarSectionsFor('admin');

    expect(ungrouped.map((r) => r.label)).toEqual(['Atendimento', 'Pacientes', 'Propostas', 'Vendas']);
  });

  it('atendente vê Gestão só com Conversão e Configurações com Cadastro de Exames + Minha Conta (únicos itens TENANT_ROLES dos grupos)', () => {
    const { groups } = sidebarSectionsFor('attendant');

    expect(groups.map((g) => g.id)).toEqual(['comunicacao', 'gestao', 'configuracoes']);
    expect(groups.find((g) => g.id === 'gestao')?.items.map((r) => r.label)).toEqual(['Conversão']);
    expect(groups.find((g) => g.id === 'configuracoes')?.items.map((r) => r.label)).toEqual([
      'Cadastro de Exames',
      // CRMLAB-35: trocar a propria senha nao e privilegio de admin.
      'Minha Conta',
    ]);
  });

  it('operador da plataforma não vê nenhum grupo — só os itens soltos do console', () => {
    const { groups, ungrouped } = sidebarSectionsFor('platform_operator');

    expect(groups).toEqual([]);
    expect(ungrouped.map((r) => r.path)).toEqual(['/platform/tenants', '/platform/billing']);
  });
});
