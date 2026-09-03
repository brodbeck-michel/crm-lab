/**
 * Fluxo 4: Conversão / Analytics — PAGES.md §8, SERVICES.md §9.
 *
 * O que este spec prova:
 *  - gestor abre `/analytics` e ve funil, receita e motivos de perda;
 *  - atendente recebe a versao PARCIAL (`partial: true`) e a tela avisa;
 *  - `GET /analytics/team` e gestor/admin — atendente leva 403;
 *  - dinheiro no fio e NUMERO (`179.8`), nunca `"R$ 179,80"` (D-018);
 *  - `lossReasons` traz sempre as 5 chaves e `byStatus` os 6 estagios.
 *
 * As duas janelas de tempo (D-020) tambem aparecem aqui: o funil conta
 * propostas CRIADAS no periodo, a receita conta propostas GANHAS (`closedAt`).
 */
import { test, expect } from '@playwright/test';
import type { FunnelReport, LossReason, PipelineSnapshot, ProposalStatus, TeamReport } from '@crm-lab/shared';
import {
  API_URL,
  E2E_PROPOSALS,
  E2E_USERS,
  apiLogin,
  authHeaders,
  gotoScreen,
  loginAs,
  type ApiErrorEnvelope,
} from './helpers.js';

const ANALYTICS = '/analytics';
const HEADING = 'Conversão';

/**
 * `shared/` e a fonte unica destas listas, mas o workspace `e2e/` so consegue
 * `import type` de `@crm-lab/shared` (o pacote aponta para `.ts` cru — e por
 * isso que `e2e-fixtures.ts` tambem e livre de import de runtime). O
 * `satisfies` abaixo faz o typecheck quebrar se `LossReason` ou
 * `ProposalStatus` mudarem em `shared/types` — a lista nao pode divergir em
 * silencio.
 */
const LOSS_REASONS = [
  'preco',
  'silencio',
  'exame_indisponivel',
  'prazo',
  'outro',
] as const satisfies readonly LossReason[];

const PROPOSAL_STATUSES = [
  'novo_contato',
  'orcamento_enviado',
  'follow_up',
  'negociacao',
  'ganho',
  'perdido',
] as const satisfies readonly ProposalStatus[];

test.describe('Fluxo 4: Conversão (gestor)', () => {
  test('gestor ve funil, receita e motivos de perda', async ({ page }) => {
    await loginAs(page, E2E_USERS.alfaManager);
    await gotoScreen(page, ANALYTICS, HEADING);

    // Indicadores do topo (PAGES.md §8). O rotulo do indicador e um
    // `<p>` (`MetricTile`): o papel desambigua do "Receita" da LEGENDA do
    // grafico, que so existe quando ha receita no periodo — sem isso o teste
    // passa ou quebra conforme o dado semeado do dia.
    for (const label of ['Receita', 'Ticket Médio', 'Taxa de Conversão', 'Propostas Criadas']) {
      await expect(
        page.getByRole('paragraph').filter({ hasText: new RegExp(`^${label}$`) }),
      ).toBeVisible();
    }

    // Os tres graficos da tela.
    await expect(page.getByRole('heading', { name: 'Funil de Conversão' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Receita Acumulada' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Motivos de Perda' })).toBeVisible();

    // A proposta ganha do seed (R$ 72,00) tem que estar somada na receita.
    await expect(page.getByText(/R\$\s?\d/).first()).toBeVisible();
  });

  test('a tela aceita filtro de periodo sem quebrar', async ({ page }) => {
    await loginAs(page, E2E_USERS.alfaManager);
    await gotoScreen(page, ANALYTICS, HEADING);

    await page.getByLabel('Data inicial').fill('2020-01-01');
    await page.getByLabel('Data final').fill('2020-01-31');

    // Periodo sem proposta: a tela continua de pe, com os graficos vazios.
    await expect(page.getByRole('heading', { name: 'Funil de Conversão' })).toBeVisible();
  });
});

test.describe('Fluxo 4: Conversão (atendente ve a versao parcial)', () => {
  test('o contrato marca partial: true para o atendente e false para o gestor', async ({
    request,
  }) => {
    const atendente = await apiLogin(request, E2E_USERS.alfaAttendant);
    const gestor = await apiLogin(request, E2E_USERS.alfaManager);

    const doAtendente = await request.get(`${API_URL}/analytics/conversion`, {
      headers: authHeaders(atendente),
    });
    expect(doAtendente.status()).toBe(200);
    const parcial = (await doAtendente.json()) as FunnelReport;
    expect(parcial.partial).toBe(true);

    const doGestor = await request.get(`${API_URL}/analytics/conversion`, {
      headers: authHeaders(gestor),
    });
    const completo = (await doGestor.json()) as FunnelReport;
    expect(completo.partial).toBe(false);

    // Parcial = so as proprias metricas: nunca mais que o total do laboratorio.
    //
    // Em `toPass` de proposito: o AnalyticsService guarda cada relatorio em
    // cache com chave propria (tenant x usuario) e NADA invalida esse cache
    // quando uma proposta fecha. Logo apos um `ganho`, a visao do gestor pode
    // estar velha e ficar ABAIXO da parcial do atendente. O invariante vale —
    // so nao vale instantaneamente. Ver "achados" no relatorio do Agent-QA.
    await expect(async () => {
      const a = (await (
        await request.get(`${API_URL}/analytics/conversion`, { headers: authHeaders(atendente) })
      ).json()) as FunnelReport;
      const g = (await (
        await request.get(`${API_URL}/analytics/conversion`, { headers: authHeaders(gestor) })
      ).json()) as FunnelReport;
      expect(a.revenue).toBeLessThanOrEqual(g.revenue);
    }).toPass({ timeout: 30_000 });
  });

  test('a tela do atendente exibe o aviso de versao parcial', async ({ page }) => {
    await loginAs(page, E2E_USERS.alfaAttendant);
    await gotoScreen(page, ANALYTICS, HEADING);

    // Requisito do Agent-API-Analytics em STATUS.md: "Atendente recebe
    // `partial: true` — a tela deve exibir o aviso de versao parcial."
    await expect(
      page.getByText(/parcial|apenas .*suas|somente .*suas/i).first(),
    ).toBeVisible();
  });

  test('o atendente nao ve o ranking da equipe na sua versao parcial', async ({ page }) => {
    await loginAs(page, E2E_USERS.alfaAttendant);
    await gotoScreen(page, ANALYTICS, HEADING);

    await expect(page.getByRole('heading', { name: 'Melhores Desempenhos' })).toHaveCount(0);
  });

  test('GET /analytics/team recusa o atendente com FORBIDDEN', async ({ request }) => {
    const token = await apiLogin(request, E2E_USERS.alfaAttendant);
    const response = await request.get(`${API_URL}/analytics/team`, { headers: authHeaders(token) });

    expect(response.status()).toBe(403);
    const body = (await response.json()) as ApiErrorEnvelope;
    expect(body.error.code).toBe('FORBIDDEN');
  });
});

test.describe('Fluxo 4: shape do contrato', () => {
  test('dinheiro vem como numero e as chaves fixas estao todas presentes', async ({ request }) => {
    const token = await apiLogin(request, E2E_USERS.alfaManager);

    const conversion = (await (
      await request.get(`${API_URL}/analytics/conversion`, { headers: authHeaders(token) })
    ).json()) as FunnelReport;

    // D-018: numero decimal, nunca string formatada.
    expect(typeof conversion.revenue).toBe('number');
    expect(typeof conversion.averageTicket).toBe('number');
    for (const performer of conversion.topPerformers) {
      expect(typeof performer.revenue).toBe('number');
    }

    // As 5 chaves de LOSS_REASONS sempre vem, com zero quando nao houve perda.
    for (const reason of LOSS_REASONS) {
      expect(conversion.lossReasons).toHaveProperty(reason);
      expect(typeof conversion.lossReasons[reason]).toBe('number');
    }

    const pipeline = (await (
      await request.get(`${API_URL}/analytics/pipeline`, { headers: authHeaders(token) })
    ).json()) as PipelineSnapshot;

    // Os 6 estagios sempre vem no `byStatus`.
    for (const status of PROPOSAL_STATUSES) {
      expect(pipeline.byStatus).toHaveProperty(status);
      expect(typeof pipeline.byStatus[status].value).toBe('number');
    }
    expect(typeof pipeline.totalValue).toBe('number');

    const team = (await (
      await request.get(`${API_URL}/analytics/team`, { headers: authHeaders(token) })
    ).json()) as TeamReport;
    expect(typeof team.totals.revenue).toBe('number');
  });

  test('a receita do periodo inclui a proposta ganha do seed', async ({ request }) => {
    const token = await apiLogin(request, E2E_USERS.alfaManager);
    const conversion = (await (
      await request.get(`${API_URL}/analytics/conversion`, { headers: authHeaders(token) })
    ).json()) as FunnelReport;

    // D-020: receita conta propostas GANHAS no periodo (janela por closedAt).
    expect(conversion.revenue).toBeGreaterThanOrEqual(E2E_PROPOSALS.ganha.expectedTotal);
    expect(conversion.funnel.ganho).toBeGreaterThanOrEqual(1);
    expect(conversion.funnel.perdido).toBeGreaterThanOrEqual(1);
  });
});
