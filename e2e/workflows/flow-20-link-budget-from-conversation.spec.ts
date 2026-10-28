/**
 * Fluxo 20: "Vincular orçamento" pela conversa (CRMLAB-129, D-298/D-299).
 *
 * Conversa aberta → "Vincular orçamento" → escolhe o orçamento do Bitlab em
 * "Novo orçamento" → confere a mensagem → Enviar. Prova pelo EFEITO no
 * servidor: o cartão fica ligado a esta conversa, com a atendente como dona,
 * em "Orçamento enviado", e some da lista de candidatos; no Pipeline ele
 * aparece na coluna certa.
 *
 * O cartão nasce pelo caminho real (planilha do LIS → `createBitlabProposals`,
 * D-196), com data de emissão HOJE para cair depois da marca
 * `bitlab_proposals_since`. Número único por execução.
 *
 * ESCRITO, NÃO EXECUTADO no card (regra da release v1.42.0): roda na integração.
 */
import { test, expect } from '@playwright/test';
import ExcelJS from 'exceljs';
import type { ListProposalsResponse } from '@crm-lab/shared';
import {
  API_URL,
  E2E_CONVERSATIONS,
  E2E_USERS,
  apiLogin,
  authHeaders,
  loginAs,
} from './helpers.js';

const CONVERSATION = E2E_CONVERSATIONS.atribuida;

async function workbookWith(number: string, patientName: string): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Orçamentos');
  sheet.addRow(['ORCAMENTO', 'DATA_ORCAMENTO', 'NM_PACIENTE', 'CONVENIO1', 'VL_TOTAL1', 'USUARIO']);
  sheet.addRow([number, new Date(), patientName, 'PARTICULAR', 150.5, 'RECEPCAO E2E']);
  return Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64');
}

test.describe('Fluxo 20: vincular orçamento do Bitlab pela conversa', () => {
  test('da conversa, vincula e envia; o cartão vai para Orçamento enviado ligado a ela', async ({
    page,
    request,
  }) => {
    const number = String(Date.now()).slice(-9);
    const managerToken = await apiLogin(request, E2E_USERS.alfaManager);

    // A planilha é plano B e nasce desligada (D-189); "Nascer do orçamento" ligada (D-246).
    const rules = await request.patch(`${API_URL}/settings/funnel-rules`, {
      headers: authHeaders(managerToken),
      data: {
        lisSource: { spreadsheetImport: { enabled: true } },
        origin: { fromBitlab: true, manualInCrm: true },
      },
    });
    expect(rules.status(), await rules.text()).toBe(200);

    const imported = await request.post(`${API_URL}/lis-imports`, {
      headers: authHeaders(managerToken),
      data: {
        fileName: `e2e-129-${number}.xlsx`,
        contentBase64: await workbookWith(number, `${CONVERSATION.patientName} E2E`),
      },
    });
    expect(imported.status(), await imported.text()).toBe(201);

    // --- Na tela, como a atendente ---------------------------------------
    await loginAs(page, E2E_USERS.alfaAttendant);
    await page.goto('/attendance');
    await page
      .getByTestId('conversation-item')
      .filter({ hasText: CONVERSATION.patientName })
      .first()
      .click();
    await page.getByRole('button', { name: 'Mostrar contexto do paciente' }).click();
    await page.getByRole('button', { name: 'Vincular orçamento' }).click();

    const dialog = page.getByRole('dialog', { name: 'Vincular orçamento' });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel('Buscar orçamento').fill(number);
    const candidate = dialog.getByTestId('link-budget-candidate').filter({ hasText: `Nº ${number}` });
    await expect(candidate).toBeVisible();
    // Nome parecido com o da conversa: vem marcado.
    await expect(candidate).toContainText('Mais parecido');
    await candidate.click();

    const message = dialog.getByLabel('Mensagem');
    await expect(message).toHaveValue(new RegExp(number));
    await dialog.getByRole('button', { name: 'Enviar' }).click();
    await expect(dialog).toBeHidden();

    // A proposta aparece no painel de contexto desta conversa.
    await expect(page.getByTestId('context-proposal').filter({ hasText: 'Orçamento enviado' })).toBeVisible();

    // --- No servidor --------------------------------------------------------
    const attendantToken = await apiLogin(request, E2E_USERS.alfaAttendant);
    const ofConversation = await request.get(
      `${API_URL}/proposals?conversationId=${CONVERSATION.id}&search=${number}`,
      { headers: authHeaders(attendantToken) },
    );
    const linked = ((await ofConversation.json()) as ListProposalsResponse).proposals;
    expect(linked).toHaveLength(1);
    expect(linked[0]).toMatchObject({
      origin: 'bitlab',
      status: 'orcamento_enviado',
      conversationId: CONVERSATION.id,
      createdBy: E2E_USERS.alfaAttendant.id,
      lisBudgetNumber: number,
    });

    // Já vinculado: não é mais candidato.
    const candidates = await request.get(
      `${API_URL}/proposals?status=novo_contato&withoutConversation=true&search=${number}`,
      { headers: authHeaders(attendantToken) },
    );
    expect(((await candidates.json()) as ListProposalsResponse).proposals).toHaveLength(0);

    // Segundo envio do mesmo orçamento: recusado, sem mensagem dupla.
    const again = await request.post(`${API_URL}/proposals/${linked[0]!.id}/send`, {
      headers: authHeaders(managerToken),
      data: { conversationId: CONVERSATION.id, message: 'de novo' },
    });
    expect(again.status()).toBe(409);
    expect(((await again.json()) as { error: { code: string } }).error.code).toBe('PROPOSAL_ALREADY_SENT');

    // --- No Pipeline -------------------------------------------------------
    await page.goto('/proposals');
    const column = page.locator('[data-stage="orcamento_enviado"]');
    await expect(column.getByText(CONVERSATION.patientName).first()).toBeVisible();
  });
});
