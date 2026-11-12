import { describe, expect, it } from 'vitest';
import {
  APP_ROUTES,
  NAV_GROUPS,
  REGISTERS_PATH,
  canAccess,
  isRouteActive,
  registerTabsFor,
  sidebarRoutesFor,
  sidebarSectionsFor,
} from './route-config';

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

  it('gestor (manager) vê Resultados e Busca Ativa + Regras (com a comissão); Atendentes virou aba de Cadastros e Conferência saiu do trilho', () => {
    const paths = sidebarRoutesFor('manager').map((r) => r.path);

    expect(paths).toEqual(
      expect.arrayContaining([
        '/results',
        '/active-search',
        REGISTERS_PATH,
        '/settings/rules',
        '/settings/lis-integration',
        '/sales',
      ]),
    );
    // CRMLAB-56 (D-194): a comissão virou seção de Regras; a rota antiga só redireciona.
    expect(paths).not.toContain('/settings/commissions');
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

    // CRMLAB-56: Regras é de todo perfil de laboratório (atendente só vê).
    expect(canAccess('attendant', byPath['/settings/rules']!.requiredRoles)).toBe(true);
    expect(canAccess('platform_operator', byPath['/settings/rules']!.requiredRoles)).toBe(false);
  });
});

describe('sidebarSectionsFor — grupos do trilho (CRMLAB-4, D-129, enxugado no CRMLAB-143)', () => {
  it('admin vê os grupos na ordem Visitação Médica → Gestão → Configurações (Comunicação saiu)', () => {
    const { groups } = sidebarSectionsFor('admin');

    expect(groups.map((g) => g.id)).toEqual(['visitacao', 'gestao', 'configuracoes']);
    expect(groups.map((g) => g.label)).toEqual(NAV_GROUPS.map((g) => g.label));
  });

  it('grupo Gestão: Resultados, Busca Ativa e Gestão da Operação (Conversão, Decisões e Conferência saíram do trilho)', () => {
    const { groups } = sidebarSectionsFor('admin');
    const gestao = groups.find((g) => g.id === 'gestao');

    expect(gestao?.items.map((r) => r.label)).toEqual([
      'Resultados',
      'Busca Ativa',
      'Gestão da Operação',
    ]);
  });

  it('grupo Configurações tem 5 itens, com Cadastros e Regras na frente', () => {
    const { groups } = sidebarSectionsFor('admin');
    const configuracoes = groups.find((g) => g.id === 'configuracoes');

    expect(configuracoes?.items.map((r) => r.label)).toEqual([
      'Cadastros',
      'Regras',
      'Canais & Equipe',
      'Integração LIS',
      'Personalização',
    ]);
  });

  it('itens soltos: Atendimento, Chat Interno, Propostas, Vendas, Contatos e Decisões, nessa ordem', () => {
    const { ungrouped } = sidebarSectionsFor('admin');

    expect(ungrouped.map((r) => r.label)).toEqual([
      'Atendimento',
      'Chat Interno',
      'Propostas',
      'Vendas',
      'Contatos',
      // CRMLAB-146 (D-318): a aprovação saiu do chat e voltou para cá.
      'Decisões',
    ]);
  });

  it('Decisões fica só para gestor e admin (CRMLAB-146)', () => {
    expect(sidebarSectionsFor('manager').ungrouped.map((r) => r.path)).toContain('/decisions');
    expect(sidebarSectionsFor('attendant').ungrouped.map((r) => r.path)).not.toContain(
      '/decisions',
    );
  });

  it('atendente não tem grupo Gestão; Configurações mostra Cadastros + Regras', () => {
    const { groups } = sidebarSectionsFor('attendant');

    expect(groups.map((g) => g.id)).toEqual(['visitacao', 'configuracoes']);
    expect(groups.find((g) => g.id === 'configuracoes')?.items.map((r) => r.label)).toEqual([
      'Cadastros',
      // CRMLAB-56: a atendente vê as Regras do laboratório (sem editar).
      'Regras',
    ]);
  });

  it('telas que saíram do trilho continuam com rota e papéis (URL direta segue abrindo)', () => {
    const byPath = Object.fromEntries(APP_ROUTES.map((r) => [r.path, r]));

    for (const path of [
      '/analytics',
      '/reconciliation',
      '/settings/account',
      '/catalog',
      '/quick-replies',
    ]) {
      expect(byPath[path]?.inSidebar).toBe(false);
    }
    // CRMLAB-35: trocar a própria senha não é privilégio de admin.
    expect(canAccess('attendant', byPath['/settings/account']!.requiredRoles)).toBe(true);
    expect(canAccess('attendant', byPath['/decisions']!.requiredRoles)).toBe(false);
  });

  it('grupo Visitação Médica tem Agenda e Médicos para todo papel do laboratório (CRMLAB-86/87, D-255/D-256)', () => {
    for (const role of ['attendant', 'manager', 'admin'] as const) {
      const visitacao = sidebarSectionsFor(role).groups.find((g) => g.id === 'visitacao');
      expect(visitacao?.label).toBe('Visitação Médica');
      expect(visitacao?.items.map((r) => [r.label, r.path])).toEqual([
        ['Agenda', '/visitation/agenda'],
        ['Médicos', '/visitation/doctors'],
      ]);
    }
    expect(sidebarRoutesFor('platform_operator').map((r) => r.path)).not.toContain('/visitation/doctors');
    expect(sidebarRoutesFor('platform_operator').map((r) => r.path)).not.toContain('/visitation/agenda');
  });

  it('operador da plataforma não vê nenhum grupo — só os itens soltos do console', () => {
    const { groups, ungrouped } = sidebarSectionsFor('platform_operator');

    expect(groups).toEqual([]);
    expect(ungrouped.map((r) => r.path)).toEqual(['/platform/tenants', '/platform/billing']);
  });
});

describe('Cadastros — abas por perfil (CRMLAB-143)', () => {
  it('admin vê as 5 abas, na ordem pedida', () => {
    expect(registerTabsFor('admin').map((t) => [t.label, t.path])).toEqual([
      ['Usuários', '/settings/users'],
      ['Exames', '/catalog'],
      ['Respostas rápidas', '/quick-replies'],
      ['Atendentes', '/settings/attendants'],
      ['Convênios', '/settings/insurances'],
    ]);
  });

  it('gestor não vê Usuários; atendente só vê Exames e Respostas rápidas', () => {
    expect(registerTabsFor('manager').map((t) => t.label)).toEqual([
      'Exames',
      'Respostas rápidas',
      'Atendentes',
      'Convênios',
    ]);
    expect(registerTabsFor('attendant').map((t) => t.label)).toEqual(['Exames', 'Respostas rápidas']);
    expect(registerTabsFor('platform_operator')).toEqual([]);
  });

  it('cada aba exige os MESMOS papéis da rota da tela (a aba não abre o que a rota recusa)', () => {
    const byPath = Object.fromEntries(APP_ROUTES.map((r) => [r.path, r]));
    for (const tab of registerTabsFor('admin')) {
      expect(byPath[tab.path]?.requiredRoles).toEqual(tab.requiredRoles);
    }
  });

  it('o item "Cadastros" do trilho fica ativo em qualquer aba, e só nelas', () => {
    const cadastros = APP_ROUTES.find((r) => r.path === REGISTERS_PATH)!;

    expect(isRouteActive(cadastros, '/catalog')).toBe(true);
    expect(isRouteActive(cadastros, '/settings/users')).toBe(true);
    expect(isRouteActive(cadastros, REGISTERS_PATH)).toBe(true);
    expect(isRouteActive(cadastros, '/settings/rules')).toBe(false);
  });
});
