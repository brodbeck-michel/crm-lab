import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_FUNNEL_RULES,
  nationalHolidays,
  type ChannelSettingsResponse,
  type CommissionSettings,
  type FunnelRules,
  type HolidaysResponse,
  type UserRole,
} from '@crm-lab/shared';
import { mutationIdle, querySuccess } from '@/test/query-mocks';
import { ToastProvider } from '@/components/ui';
import { useAuthStore } from '@/stores/auth.store';
import * as funnelRulesApi from '@/api/funnel-rules';
import * as commissionApi from '@/api/commission-settings';
import * as holidaysApi from '@/api/holidays';
import * as settingsApi from '@/api/settings';
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

vi.mock('@/api/holidays', () => ({
  useHolidays: vi.fn(),
  useCreateHoliday: vi.fn(),
  useDeleteHoliday: vi.fn(),
}));

vi.mock('@/api/settings', async (importOriginal) => ({
  ...(await importOriginal<typeof settingsApi>()),
  useChannelSettings: vi.fn(),
}));

const useHolidays = vi.mocked(holidaysApi.useHolidays);
const useCreateHoliday = vi.mocked(holidaysApi.useCreateHoliday);
const useDeleteHoliday = vi.mocked(holidaysApi.useDeleteHoliday);
const useChannelSettings = vi.mocked(settingsApi.useChannelSettings);

function holidays(custom: HolidaysResponse['custom'] = []): HolidaysResponse {
  return { year: 2026, national: nationalHolidays(2026), custom };
}

function channelsWith(connectionMode: 'qr' | 'cloud_api'): ChannelSettingsResponse {
  return {
    channels: [{ channel: 'whatsapp', connectionMode } as ChannelSettingsResponse['channels'][number]],
  } as ChannelSettingsResponse;
}

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
  const createHoliday = vi.fn();
  const deleteHoliday = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useUpdateFunnelRules.mockReturnValue(mutationIdle(mutate));
    useCommissionSettings.mockReturnValue(querySuccess(COMMISSIONS));
    useUpdateCommissionSettings.mockReturnValue(mutationIdle(vi.fn()));
    useHolidays.mockReturnValue(querySuccess(holidays()));
    useCreateHoliday.mockReturnValue(mutationIdle(createHoliday));
    useDeleteHoliday.mockReturnValue(mutationIdle(deleteHoliday));
    useChannelSettings.mockReturnValue(querySuccess(channelsWith('qr')));
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

    const toggle = within(section(/carga do lis/i)).getByRole('switch', {
      name: /importar a planilha/i,
    });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    await user.click(toggle);
    await user.click(screen.getByRole('button', { name: 'Salvar regras' }));

    expect(mutate.mock.calls[0]?.[0]).toEqual({
      lisSource: { spreadsheetImport: { enabled: true } },
    });
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
  describe('reingajamento (CRMLAB-62)', () => {
    it('padrão: 1º e 2º desligados, 1 h e 24 h, 2º travado sem o 1º', () => {
      signIn('manager');
      renderPage();
      const box = section(/reingajamento da conversa/i);
      const first = within(box).getByRole('switch', { name: /1º reingajamento/i });
      const second = within(box).getByRole('switch', { name: /2º reingajamento/i });
      expect(first).not.toBeChecked();
      expect(second).toBeDisabled();
      expect(within(box).getByLabelText('Horas sem resposta')).toHaveValue(1);
      expect(within(box).getByLabelText('Horas depois do 1º')).toHaveValue(24);
      expect(within(box).getByText(/ligue o 1º reingajamento/i)).toBeInTheDocument();
    });

    it('ligar o 1º com 2 h salva só o que mudou', async () => {
      const user = userEvent.setup();
      signIn('manager');
      renderPage();
      const box = section(/reingajamento da conversa/i);
      await user.click(within(box).getByRole('switch', { name: /1º reingajamento/i }));
      const hours = within(box).getByLabelText('Horas sem resposta');
      await user.clear(hours);
      await user.type(hours, '2');
      await user.click(screen.getByRole('button', { name: 'Salvar regras' }));
      expect(mutate.mock.calls[0]?.[0]).toEqual({ reengagement: { first: { enabled: true, hours: 2 } } });
    });

    it('desligar o 1º desliga o 2º junto', async () => {
      const user = userEvent.setup();
      signIn('manager');
      const on: FunnelRules = {
        ...DEFAULT_FUNNEL_RULES,
        reengagement: {
          first: { ...DEFAULT_FUNNEL_RULES.reengagement.first, enabled: true },
          second: { ...DEFAULT_FUNNEL_RULES.reengagement.second, enabled: true },
        },
      };
      renderPage(on);
      const box = section(/reingajamento da conversa/i);
      await user.click(within(box).getByRole('switch', { name: /1º reingajamento/i }));
      expect(within(box).getByRole('switch', { name: /2º reingajamento/i })).not.toBeChecked();
      await user.click(screen.getByRole('button', { name: 'Salvar regras' }));
      expect(mutate.mock.calls[0]?.[0]).toEqual({
        reengagement: { first: { enabled: false }, second: { enabled: false } },
      });
    });

    it('mensagem vazia bloqueia salvar', async () => {
      const user = userEvent.setup();
      signIn('manager');
      renderPage();
      const box = section(/reingajamento da conversa/i);
      await user.click(within(box).getByRole('switch', { name: /1º reingajamento/i }));
      await user.clear(within(box).getAllByLabelText('Mensagem')[0]!);
      expect(screen.getByRole('button', { name: 'Salvar regras' })).toBeDisabled();
    });

    it('{paciente}: botão insere, prévia mostra o primeiro nome e salva (CRMLAB-96, D-266)', async () => {
      const user = userEvent.setup();
      signIn('manager');
      renderPage();
      const box = section(/reingajamento da conversa/i);
      await user.click(within(box).getByRole('switch', { name: /1º reingajamento/i }));
      const message = within(box).getAllByLabelText('Mensagem')[0]!;
      await user.clear(message);
      await user.type(message, 'Olá, ');
      await user.click(within(box).getAllByRole('button', { name: '{paciente}' })[0]!);
      expect(message).toHaveValue('Olá, {paciente}');
      expect(within(box).getByTestId('preview-reingajamento-first')).toHaveTextContent('Olá, Maria');
      await user.click(screen.getByRole('button', { name: 'Salvar regras' }));
      expect(mutate.mock.calls[0]?.[0]).toEqual({
        reengagement: { first: { enabled: true, message: 'Olá, {paciente}' } },
      });
    });

    it('mensagem antiga sem variável: prévia igual ao texto', () => {
      signIn('manager');
      renderPage();
      expect(screen.getByTestId('preview-reingajamento-second')).toHaveTextContent(
        DEFAULT_FUNNEL_RULES.reengagement.second.message,
      );
    });

    it('variável desconhecida mostra erro e bloqueia salvar (D-266)', async () => {
      const user = userEvent.setup();
      signIn('manager');
      renderPage();
      const box = section(/reingajamento da conversa/i);
      await user.click(within(box).getByRole('switch', { name: /1º reingajamento/i }));
      const message = within(box).getAllByLabelText('Mensagem')[0]!;
      await user.clear(message);
      // `{` é tecla especial no user-event: `{{` digita uma chave.
      await user.type(message, 'Oi {{nome}');
      expect(within(box).getByText('Variável desconhecida: {nome}')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Salvar regras' })).toBeDisabled();
    });

    it('canal na API oficial: avisa que está inativo', () => {
      useChannelSettings.mockReturnValue(querySuccess(channelsWith('cloud_api')));
      signIn('manager');
      renderPage();
      expect(within(section(/reingajamento da conversa/i)).getByRole('status')).toHaveTextContent(
        /inativo para este canal/i,
      );
    });

    it('atendente não consulta os canais e vê tudo desabilitado', () => {
      signIn('attendant');
      renderPage();
      expect(useChannelSettings).toHaveBeenCalledWith({ enabled: false });
      const box = section(/reingajamento da conversa/i);
      expect(within(box).getByRole('switch', { name: /1º reingajamento/i })).toBeDisabled();
    });
  });

  describe('alerta de tempo de resposta (CRMLAB-84)', () => {
    it('padrão: desligado, 15 min, campo travado até ligar', () => {
      signIn('manager');
      renderPage();
      const box = section(/alerta de tempo de resposta/i);
      expect(within(box).getByRole('switch', { name: /sem resposta há x minutos/i })).not.toBeChecked();
      expect(within(box).getByLabelText('Minutos sem resposta')).toHaveValue(15);
      expect(within(box).getByLabelText('Minutos sem resposta')).toBeDisabled();
    });

    it('ligar com 30 min salva só o que mudou', async () => {
      const user = userEvent.setup();
      signIn('manager');
      renderPage();
      const box = section(/alerta de tempo de resposta/i);
      await user.click(within(box).getByRole('switch', { name: /sem resposta há x minutos/i }));
      const minutes = within(box).getByLabelText('Minutos sem resposta');
      await user.clear(minutes);
      await user.type(minutes, '30');
      await user.click(screen.getByRole('button', { name: 'Salvar regras' }));
      expect(mutate.mock.calls[0]?.[0]).toEqual({ responseAlert: { enabled: true, minutes: 30 } });
    });

    it('fora de 1 a 1440 avisa no campo e bloqueia salvar', async () => {
      const user = userEvent.setup();
      signIn('manager');
      renderPage({ ...DEFAULT_FUNNEL_RULES, responseAlert: { enabled: true, minutes: 15 } });
      const box = section(/alerta de tempo de resposta/i);
      const minutes = within(box).getByLabelText('Minutos sem resposta');
      await user.clear(minutes);
      await user.type(minutes, '1441');
      expect(within(box).getByText('Informe um número inteiro de 1 a 1440')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Salvar regras' })).toBeDisabled();
    });

    it('atendente vê desabilitado', () => {
      signIn('attendant');
      renderPage({ ...DEFAULT_FUNNEL_RULES, responseAlert: { enabled: true, minutes: 20 } });
      const box = section(/alerta de tempo de resposta/i);
      expect(within(box).getByRole('switch', { name: /sem resposta há x minutos/i })).toBeDisabled();
      expect(within(box).getByLabelText('Minutos sem resposta')).toBeDisabled();
    });
  });

  describe('feriados (CRMLAB-62)', () => {
    it('mostra os nacionais do ano e os do laboratório', () => {
      useHolidays.mockReturnValue(
        querySuccess(holidays([{ id: 'h1', date: '2026-03-19', description: 'São José', source: 'custom' }])),
      );
      signIn('manager');
      renderPage();
      const box = section(/^feriados$/i);
      const nacionais = within(box).getByRole('list', { name: /feriados nacionais/i });
      expect(within(nacionais).getByText('Corpus Christi')).toBeInTheDocument();
      expect(within(nacionais).getByText('Carnaval (terça-feira)')).toBeInTheDocument();
      const doLab = within(box).getByRole('list', { name: /feriados do laboratório/i });
      expect(within(doLab).getByText('São José')).toBeInTheDocument();
    });

    it('gestor inclui e remove', async () => {
      const user = userEvent.setup();
      useHolidays.mockReturnValue(
        querySuccess(holidays([{ id: 'h1', date: '2026-03-19', description: 'São José', source: 'custom' }])),
      );
      signIn('manager');
      renderPage();
      const box = section(/^feriados$/i);
      await user.type(within(box).getByLabelText('Data'), '2026-06-13');
      await user.type(within(box).getByLabelText('Descrição'), 'Santo Antônio');
      await user.click(within(box).getByRole('button', { name: 'Incluir feriado' }));
      expect(createHoliday.mock.calls[0]?.[0]).toEqual({ date: '2026-06-13', description: 'Santo Antônio' });
      await user.click(within(box).getByRole('button', { name: 'Remover São José' }));
      expect(deleteHoliday.mock.calls[0]?.[0]).toBe('h1');
    });

    it('atendente só vê: sem incluir nem remover', () => {
      useHolidays.mockReturnValue(
        querySuccess(holidays([{ id: 'h1', date: '2026-03-19', description: 'São José', source: 'custom' }])),
      );
      signIn('attendant');
      renderPage();
      const box = section(/^feriados$/i);
      expect(within(box).queryByRole('button', { name: 'Incluir feriado' })).not.toBeInTheDocument();
      expect(within(box).queryByRole('button', { name: /remover/i })).not.toBeInTheDocument();
    });
  });
});
