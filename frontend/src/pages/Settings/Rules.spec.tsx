import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FUNNEL_RULES,
  type CommissionSettings,
  type FunnelRules,
  type UserRole,
} from '@crm-lab/shared';
import { mutationIdle, querySuccess } from '@/test/query-mocks';
import { ToastProvider } from '@/components/ui';
import { useAuthStore } from '@/stores/auth.store';
import * as funnelRulesApi from '@/api/funnel-rules';
import * as commissionApi from '@/api/commission-settings';
import Rules from './Rules';

vi.mock('@/api/funnel-rules', async (importOriginal) => ({
  ...(await importOriginal<typeof funnelRulesApi>()),
  useFunnelRules: vi.fn(),
  useUpdateFunnelRules: vi.fn(),
}));

vi.mock('@/api/commission-settings', async (importOriginal) => ({
  ...(await importOriginal<typeof commissionApi>()),
  useCommissionSettings: vi.fn(),
  useUpdateCommissionSettings: vi.fn(),
}));

const useFunnelRules = vi.mocked(funnelRulesApi.useFunnelRules);
const useUpdateFunnelRules = vi.mocked(funnelRulesApi.useUpdateFunnelRules);
const useCommissionSettings = vi.mocked(commissionApi.useCommissionSettings);
const useUpdateCommissionSettings = vi.mocked(commissionApi.useUpdateCommissionSettings);

const COMMISSIONS: CommissionSettings = {
  commissionBudgetPct: 2,
  commissionExamsPct: 1.5,
  commissionCheckupPct: 1.5,
};

function signIn(role: UserRole) {
  useAuthStore.setState({
    user: { id: 'user-9', email: 'quem@lab.com.br', name: 'Quem', role, discountLimit: 10 },
  });
}

function renderPage(rules: FunnelRules = DEFAULT_FUNNEL_RULES) {
  useFunnelRules.mockReturnValue(querySuccess(rules));
  return render(
    <ToastProvider>
      <MemoryRouter>
        <Rules />
      </MemoryRouter>
    </ToastProvider>,
  );
}

function section(name: RegExp): HTMLElement {
  return screen.getByRole('region', { name });
}

describe('Regras (/settings/rules)', () => {
  const mutate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useUpdateFunnelRules.mockReturnValue(mutationIdle(mutate));
    useCommissionSettings.mockReturnValue(querySuccess(COMMISSIONS));
    useUpdateCommissionSettings.mockReturnValue(mutationIdle(vi.fn()));
  });

  afterEach(() => {
    useAuthStore.setState({ user: null });
  });

  it('gestor vê as 7 seções', () => {
    signIn('manager');
    renderPage();

    for (const name of [
      /origem das propostas/i,
      /automação do funil/i,
      /movimentação manual/i,
      /mensagem de envio/i,
      /descontos e aprovação/i,
      /carga do lis/i,
      /comissões/i,
    ]) {
      expect(section(name)).toBeInTheDocument();
    }
  });

  it('mostra os padrões: prazos 3/7/15 dias, 4 h, follow-up → perdido desligado', () => {
    signIn('manager');
    renderPage();

    const automacao = section(/automação do funil/i);
    const dias = within(automacao).getAllByLabelText('Dias');
    expect(dias.map((input) => (input as HTMLInputElement).value)).toEqual(['3', '7', '15']);
    expect(within(automacao).getByLabelText('Horas')).toHaveValue(4);
    expect(within(automacao).getByRole('switch', { name: /follow-up há z dias/i })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    // prazo de automação desligada fica desabilitado
    expect(dias[2]).toBeDisabled();
  });

  it('salvar envia só o que mudou, no formato aninhado', async () => {
    const user = userEvent.setup();
    signIn('manager');
    renderPage();

    await user.click(screen.getByRole('switch', { name: /pular etapas/i }));
    const dias = within(section(/automação do funil/i)).getAllByLabelText('Dias');
    await user.clear(dias[0]!);
    await user.type(dias[0]!, '5');
    await user.click(screen.getByRole('button', { name: 'Salvar regras' }));

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate.mock.calls[0]?.[0]).toEqual({
      automation: { sentToFollowUp: { days: 5 } },
      manualMoves: { skipStages: false },
    });
  });

  it('carga do LIS: planilha nasce desligada; ligar envia lisSource (CRMLAB-53, D-189)', async () => {
    const user = userEvent.setup();
    signIn('manager');
    renderPage();

    const toggle = within(section(/carga do lis/i)).getByRole('switch', { name: /importar a planilha/i });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: 'Salvar regras' }));

    expect(mutate.mock.calls[0]?.[0]).toEqual({ lisSource: { spreadsheetImport: { enabled: true } } });
  });

  it('sem alteração o botão fica desabilitado', () => {
    signIn('admin');
    renderPage();
    expect(screen.getByRole('button', { name: 'Salvar regras' })).toBeDisabled();
  });

  it('reabrir: marcar Atendente entra na lista de perfis', async () => {
    const user = userEvent.setup();
    signIn('manager');
    renderPage();

    const travas = section(/movimentação manual/i);
    const atendente = within(travas).getByRole('checkbox', { name: 'Atendente' });
    expect(atendente).toBeDisabled(); // reabrir desligado
    await user.click(within(travas).getByRole('switch', { name: /reabrir/i }));
    await user.click(atendente);
    await user.click(screen.getByRole('button', { name: 'Salvar regras' }));

    expect(mutate.mock.calls[0]?.[0]).toEqual({
      manualMoves: { reopenClosed: { enabled: true, roles: ['manager', 'attendant'] } },
    });
  });

  it('não deixa salvar com as duas origens desligadas', async () => {
    const user = userEvent.setup();
    signIn('manager');
    renderPage();

    await user.click(screen.getByRole('switch', { name: /bitlab/i }));
    await user.click(screen.getByRole('switch', { name: /manualmente/i }));

    expect(screen.getByText('Deixe ao menos uma origem de proposta ligada.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Salvar regras' })).toBeDisabled();
  });

  it('mensagem: pré-visualização renderiza as variáveis; variável desconhecida bloqueia', async () => {
    const user = userEvent.setup();
    signIn('manager');
    renderPage();

    expect(screen.getByTestId('preview-mensagem')).toHaveTextContent(
      'Olá, Maria Souza! Segue o orçamento nº 70034 (Particular), no valor de R$ 179,80.',
    );

    const modelo = screen.getByLabelText('Modelo da mensagem');
    await user.clear(modelo);
    // `{` é tecla especial do user-event: `{{` digita uma chave literal.
    await user.type(modelo, 'Oi {{nome}');
    expect(screen.getByText('Variável desconhecida: {nome}')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Salvar regras' })).toBeDisabled();
  });

  it('botão de variável insere no fim do modelo', async () => {
    const user = userEvent.setup();
    signIn('manager');
    renderPage({ ...DEFAULT_FUNNEL_RULES, sendMessage: { template: 'Total: ' } });

    await user.click(screen.getByRole('button', { name: '{valor}' }));
    expect(screen.getByLabelText('Modelo da mensagem')).toHaveValue('Total: {valor}');
  });

  it('"Criar pelo CRM" desligado (salvo) esconde Descontos e aprovação', () => {
    signIn('manager');
    renderPage({ ...DEFAULT_FUNNEL_RULES, origin: { fromBitlab: true, manualInCrm: false } });

    expect(
      screen.queryByRole('region', { name: /descontos e aprovação/i }),
    ).not.toBeInTheDocument();
  });

  it('atendente vê tudo desabilitado, sem salvar e sem comissões', () => {
    signIn('attendant');
    renderPage();

    expect(screen.getByRole('switch', { name: /pular etapas/i })).toBeDisabled();
    expect(screen.getByLabelText('Modelo da mensagem')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Salvar regras' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /comissões/i })).not.toBeInTheDocument();
    expect(useCommissionSettings).not.toHaveBeenCalled();
  });

  it('erro de campo do servidor aparece no campo pelo caminho', async () => {
    const user = userEvent.setup();
    mutate.mockImplementation((_body: unknown, opts: { onError: (err: unknown) => void }) =>
      opts.onError({ details: { fields: { 'automation.sentToFollowUp.days': 'Fora da faixa' } } }),
    );
    signIn('manager');
    renderPage();

    await user.click(screen.getByRole('switch', { name: /pular etapas/i }));
    await user.click(screen.getByRole('button', { name: 'Salvar regras' }));

    expect(await screen.findByText('Fora da faixa')).toBeInTheDocument();
  });
});
