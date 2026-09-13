/**
 * Fluxo 17: importação de planilha do LIS + tela `/results` (PAGES.md §14,
 * BUSINESS_RULES.md §11). Pendência registrada no STATUS.md ao fim da Onda 10
 * — os testes de componente provam cálculo isolado, mas nenhum verifica o
 * caminho real: upload de um `.xlsx` de verdade → parser (`lis-spreadsheet.ts`,
 * aliases de cabeçalho) → `LisImportService` → `GET /lis-budgets/summary` →
 * números na tela.
 *
 * A planilha é gerada em memória com `exceljs` (mesma lib do parser do
 * backend) e enviada via `setInputFiles({ buffer })`, sem tocar disco — três
 * linhas desenhadas para que Total Orçado, Em Requisição e Recebido caiam em
 * três valores DIFERENTES (nenhum é soma/subconjunto óbvio dos outros), o
 * suficiente para saber que cada KPI lê a coluna certa e não reaproveita o
 * número de outro cartão por acidente.
 */
import { test, expect } from '@playwright/test';
import ExcelJS from 'exceljs';
import { API_URL, E2E_USERS, apiLogin, authHeaders, gotoScreen, loginAs } from './helpers.js';

const RESULTS = '/results';
const HEADING = 'Resultados';
const ATTENDANT_NAME = 'Carla Consultora E2E';

/** Cabeçalhos canônicos de BUSINESS_RULES.md §11.9 (um alias por campo). */
const HEADER = [
  'ORCAMENTO',
  'DATA_ORCAMENTO',
  'NM_PACIENTE',
  'CONVENIO1',
  'VL_TOTAL1',
  'USUARIO',
  'REQUISICAO',
  'VALOR_REQUISICAO',
  'VALOR_PAGO',
  'DATA_PAGAMENTO',
] as const;

interface FixtureRow {
  number: string;
  issuedOn: Date;
  patientName: string;
  insurance1: string;
  value1: number;
  attendantName: string;
  requisitionNumber?: string;
  requisitionValue?: number;
  paidValue?: number;
  paidOn?: Date;
}

/**
 * Três orçamentos do MESMO atendente, dentro de 2026-08 (fora da janela
 * padrão de 30 dias — o teste ajusta o `PeriodFilter` explicitamente):
 *  - #1: emitido, com requisição, PAGO.
 *  - #2: emitido, com requisição, ainda SEM pagamento (fica em Busca Ativa).
 *  - #3: emitido, sem requisição nenhuma (só orçado).
 *
 * issued = 1000+500+300 = 1800 · requisição = 1000+500 = 1500 · pago = 1000.
 */
const ROWS: FixtureRow[] = [
  {
    number: 'E2E-17001',
    issuedOn: new Date(Date.UTC(2026, 7, 5)),
    patientName: 'Paciente Um E2E',
    insurance1: 'Unimed Tubarão',
    value1: 1000,
    attendantName: ATTENDANT_NAME,
    requisitionNumber: 'REQ-E2E-1',
    requisitionValue: 1000,
    paidValue: 1000,
    paidOn: new Date(Date.UTC(2026, 7, 10)),
  },
  {
    number: 'E2E-17002',
    issuedOn: new Date(Date.UTC(2026, 7, 6)),
    patientName: 'Paciente Dois E2E',
    insurance1: 'Unimed Tubarão',
    value1: 500,
    attendantName: ATTENDANT_NAME,
    requisitionNumber: 'REQ-E2E-2',
    requisitionValue: 500,
  },
  {
    number: 'E2E-17003',
    issuedOn: new Date(Date.UTC(2026, 7, 7)),
    patientName: 'Paciente Três E2E',
    insurance1: 'Unimed Tubarão',
    value1: 300,
    attendantName: ATTENDANT_NAME,
  },
];

async function buildFixtureWorkbook(rows: FixtureRow[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Orçamentos');
  sheet.addRow([...HEADER]);
  for (const row of rows) {
    sheet.addRow([
      row.number,
      row.issuedOn,
      row.patientName,
      row.insurance1,
      row.value1,
      row.attendantName,
      row.requisitionNumber ?? null,
      row.requisitionValue ?? null,
      row.paidValue ?? null,
      row.paidOn ?? null,
    ]);
  }
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

test.describe('Fluxo 17: importação do LIS + Resultados', () => {
  test('gestor importa planilha e os KPIs de /results batem com a fixture', async ({
    page,
    request,
  }) => {
    // Setup: atendente pré-cadastrado (a planilha resolve por folded_name —
    // sem o cadastro prévio, a linha gravaria attendant_id NULL, D-112).
    const managerToken = await apiLogin(request, E2E_USERS.alfaManager);
    const created = await request.post(`${API_URL}/attendants`, {
      headers: authHeaders(managerToken),
      data: { name: ATTENDANT_NAME },
    });
    expect([201, 409]).toContain(created.status());

    await loginAs(page, E2E_USERS.alfaManager);
    await gotoScreen(page, RESULTS, HEADING);

    // Ajusta o período ANTES de importar: as datas da fixture (ago/2026)
    // caem fora da janela padrão de 30 dias — sem isso a tela mostraria
    // "Nenhum orçamento importado neste período" mesmo com a importação ok.
    await page.getByLabel('Data inicial').fill('2020-01-01');
    await page.getByLabel('Data final').fill('2030-12-31');

    await page.getByRole('button', { name: 'Importar' }).click();
    const dialog = page.getByRole('dialog', { name: 'Importar planilha do LIS' });
    await expect(dialog).toBeVisible();

    const buffer = await buildFixtureWorkbook(ROWS);
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'lis-import-e2e.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer,
    });

    await expect(
      page.getByRole('status').filter({ hasText: 'Importação concluída: 3 linha(s) aceitas, 0 rejeitada(s).' }),
    ).toBeVisible();
    await expect(dialog).toBeHidden();

    // O filtro de período dispara 4 fetches em paralelo (summary, período
    // anterior, relatório executivo, vendas) — dá tempo de sobra antes de ler
    // os cartões, em vez de deixar cada `toContainText` correr contra o
    // timeout padrão de 10s enquanto a tela ainda está "Carregando...".
    await expect(page.getByText('Carregando...')).toHaveCount(0, { timeout: 20_000 });

    // `<p>` não tem nome acessível computado — o padrão do projeto (ver
    // flow-4-analytics.spec.ts) é `getByRole('paragraph')` + `.filter({hasText})`,
    // nunca a opção `name` do `getByRole` aqui.

    // Cartão "Total Orçado": 1000+500+300 = 1800, 3 orçamentos.
    const totalOrcadoLabel = page.getByRole('paragraph').filter({ hasText: /^Total Orçado$/ });
    const totalOrcadoCard = totalOrcadoLabel.locator('xpath=..');
    await expect(totalOrcadoCard).toContainText('R$ 1.800,00');
    await expect(totalOrcadoCard).toContainText('3 orçamentos');

    // Cartão "Em Requisição": só #1 e #2 tem REQUISICAO -> 1000+500 = 1500,
    // 1500/1800 = 83.3% do total.
    const emRequisicaoLabel = page.getByRole('paragraph').filter({ hasText: /^Em Requisição$/ });
    const emRequisicaoCard = emRequisicaoLabel.locator('xpath=..');
    await expect(emRequisicaoCard).toContainText('R$ 1.500,00');
    await expect(emRequisicaoCard).toContainText('2 req.');
    await expect(emRequisicaoCard).toContainText('83.3% do total');

    // Cartão "Recebido": só #1 foi pago -> 1000, 1000/1800 = 55.6% do orçamento.
    const recebidoLabel = page.getByRole('paragraph').filter({ hasText: /^Recebido$/ });
    const recebidoCard = recebidoLabel.locator('xpath=..');
    await expect(recebidoCard).toContainText('R$ 1.000,00');
    await expect(recebidoCard).toContainText('1 pagos');
    await expect(recebidoCard).toContainText('55.6% do orçamento');

    // Cartão "Atendentes": só a Carla teve orçamento no período.
    const atendentesLabel = page.getByRole('paragraph').filter({ hasText: /^Atendentes$/ });
    const atendentesCard = atendentesLabel.locator('xpath=..');
    await expect(atendentesCard).toContainText('1 ativo(s) no período');

    // "Detalhe por atendente": 3 orç., R$ 1.000,00 recebido, conversão
    // 1/3 = 33.3%, comissão sobre orçamento 2% de 1000 = R$ 20,00 (default
    // de D-113, tenant sem override).
    const row = page.getByRole('row', { name: new RegExp(ATTENDANT_NAME) });
    await expect(row).toContainText('R$ 1.000,00');
    await expect(row).toContainText('33.3%');
    await expect(row).toContainText('R$ 20,00');

    // Reimportar a MESMA planilha não duplica (BUSINESS_RULES §11.1) — upsert
    // por `number`, upsert idempotente.
    await page.getByRole('button', { name: 'Importar' }).click();
    await expect(dialog).toBeVisible();
    await dialog.locator('input[type="file"]').setInputFiles({
      name: 'lis-import-e2e.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      buffer,
    });
    await expect(
      page.getByRole('status').filter({ hasText: 'Importação concluída: 3 linha(s) aceitas, 0 rejeitada(s).' }),
    ).toBeVisible();
    await expect(totalOrcadoCard).toContainText('R$ 1.800,00');
    await expect(totalOrcadoCard).toContainText('3 orçamentos');
  });
});
