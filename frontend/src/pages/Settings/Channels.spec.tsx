import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChannelSettingsResponse, UserRole } from '@crm-lab/shared';
import { settingsApi } from '@/api/settings';
import { mutationIdle, querySuccess } from '@/test/query-mocks';
import { ToastProvider } from '@/components/ui';
import { useAuthStore } from '@/stores';
import ChannelsSettings from './Channels';
import { buildUpdateRequest, toForm } from './channels-form';

vi.mock('@/api/settings', () => ({
  settingsApi: {
    channels: vi.fn(),
    updateChannels: vi.fn(),
  },
}));

/**
 * O cartão do WhatsApp embute o bloco de conexão por QR (Onda 7 — Bloco B),
 * montado só para `canEdit` (admin). `useWhatsAppStatus`/`useWhatsAppConnect`/
 * `useWhatsAppQr` precisam de mock aqui mesmo quando o teste não fala sobre
 * QR nenhum — sem isso o `render` do admin quebra, porque os hooks rodam a
 * cada render independente do modal estar aberto.
 */
vi.mock('@/api/channels');

const channelsMock = vi.mocked(settingsApi.channels);
const updateChannelsMock = vi.mocked(settingsApi.updateChannels);

/** Shape EXATO de docs/api/API_CONTRACTS.md §6 — sem `as any`, sem campo inventado. */
const settings: ChannelSettingsResponse = {
  channels: [
    {
      id: 'channel-1',
      channel: 'whatsapp',
      displayName: 'WhatsApp do Vida',
      phoneNumberId: '109876543210987',
      phoneNumber: '+55 48 3621-0000',
      isActive: true,
      apiTokenMasked: '••••••••9f2a',
      webhookSecretSet: true,
      connectedAt: '2026-07-02T11:20:00.000Z',
      updatedAt: '2026-08-19T08:45:00.000Z',
      connectionMode: 'cloud_api',
      acceptedTermsAt: null,
    },
  ],
  distributionMode: 'round_robin',
  autoMessages: {
    greeting: { enabled: true, message: 'Olá! Somos o Laboratório Vida.' },
    offHours: { enabled: false, message: null },
  },
  businessHours: {
    timezone: 'America/Sao_Paulo',
    days: {
      mon: { start: '08:00', end: '18:00' },
      sat: { start: '08:00', end: '12:00' },
      sun: null,
    },
  },
  team: [
    { id: 'user-1', name: 'Maria Souza', role: 'attendant', isActive: true },
    { id: 'user-2', name: 'Pedro Inativo', role: 'attendant', isActive: false },
    { id: 'user-3', name: 'Gestora Ana', role: 'manager', isActive: true },
  ],
};

function signIn(role: UserRole) {
  useAuthStore.setState({
    user: { id: 'user-9', email: 'quem@lab.com.br', name: 'Quem', role, discountLimit: 10 },
  });
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter>
          <ChannelsSettings />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('ChannelsSettings', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    channelsMock.mockResolvedValue(settings);
    updateChannelsMock.mockResolvedValue(settings);

    const { useWhatsAppConnect, useWhatsAppQr, useWhatsAppStatus, useWhatsAppDisconnect } =
      await import('@/api/channels');
    vi.mocked(useWhatsAppConnect).mockReturnValue(mutationIdle());
    vi.mocked(useWhatsAppQr).mockReturnValue(
      querySuccess({ qrcode: null, status: 'disconnected', expiresInSeconds: null }),
    );
    vi.mocked(useWhatsAppStatus).mockReturnValue(
      querySuccess({ status: 'disconnected', phoneNumber: null, connectedAt: null }),
    );
    vi.mocked(useWhatsAppDisconnect).mockReturnValue(mutationIdle());
  });

  afterEach(() => {
    useAuthStore.setState({ user: null });
  });

  it('admin vê canal, máscara do token, distribuição e equipe', async () => {
    signIn('admin');
    renderPage();

    expect(await screen.findByDisplayValue('WhatsApp do Vida')).toBeInTheDocument();
    // O token só aparece como máscara — o valor em claro nunca chega aqui.
    expect(screen.getByText('Configurado (••••••••9f2a)')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /rodízio/i })).toBeChecked();

    // Equipe vem embutida na MESMA resposta (D-066): nenhum GET /users.
    expect(screen.getByText('Maria Souza')).toBeInTheDocument();
    expect(screen.getByText('Gestora Ana')).toBeInTheDocument();
    // Inativo aparece marcado, não some.
    expect(screen.getByText('Pedro Inativo')).toBeInTheDocument();
    expect(screen.getByText('Inativo')).toBeInTheDocument();
  });

  it('a tela diz que o campo em branco PRESERVA o segredo', async () => {
    signIn('admin');
    renderPage();

    await screen.findByDisplayValue('WhatsApp do Vida');
    expect(
      screen.getAllByText(/em branco PRESERVA o valor atual/i).length,
    ).toBeGreaterThan(0);
  });

  it('admin: clicar em "Conectar WhatsApp" abre o modal de conexão por QR', async () => {
    const user = userEvent.setup();
    signIn('admin');
    renderPage();

    await screen.findByDisplayValue('WhatsApp do Vida');
    await user.click(screen.getByRole('button', { name: /conectar whatsapp/i }));

    expect(await screen.findByRole('dialog', { name: /conectar whatsapp por qr/i })).toBeInTheDocument();
    expect(screen.getByText(/risco de banimento/i)).toBeInTheDocument();
  });

  it('gestor não vê o botão "Conectar WhatsApp"', async () => {
    signIn('manager');
    renderPage();

    await screen.findByText('WhatsApp do Vida');
    expect(screen.queryByRole('button', { name: /conectar whatsapp/i })).not.toBeInTheDocument();
  });

  it('gestor lê a tela sem NENHUM controle de escrita', async () => {
    signIn('manager');
    renderPage();

    // Lê os mesmos dados...
    expect(await screen.findByText('WhatsApp do Vida')).toBeInTheDocument();
    expect(screen.getByText('Configurado (••••••••9f2a)')).toBeInTheDocument();
    expect(screen.getByText('Rodízio (round-robin)')).toBeInTheDocument();
    expect(screen.getByText('Somente leitura')).toBeInTheDocument();

    // ...e não tem por onde escrever: nem campo, nem interruptor, nem salvar.
    expect(screen.queryByRole('button', { name: /salvar/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByRole('radio')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();

    // O GET é permitido para o gestor (§6) — este é o único request da tela.
    expect(channelsMock).toHaveBeenCalledTimes(1);
    expect(updateChannelsMock).not.toHaveBeenCalled();
  });

  it('atendente é barrado SEM disparar request', async () => {
    signIn('attendant');
    renderPage();

    expect(
      await screen.findByText('Acesso restrito a gestor e administrador'),
    ).toBeInTheDocument();
    // A guarda existe para NÃO pedir o que se sabe que voltaria 403.
    expect(channelsMock).not.toHaveBeenCalled();
  });

  it('salvar sem tocar no campo de segredo NÃO envia o campo (preserva)', async () => {
    const user = userEvent.setup();
    signIn('admin');
    renderPage();

    const displayName = await screen.findByDisplayValue('WhatsApp do Vida');
    await user.clear(displayName);
    await user.type(displayName, 'WhatsApp Vida Centro');
    await user.click(screen.getByRole('button', { name: /salvar/i }));

    await waitFor(() => expect(updateChannelsMock).toHaveBeenCalledTimes(1));

    const body = updateChannelsMock.mock.calls[0]?.[0];
    const channel = body?.channels?.[0];
    expect(channel?.displayName).toBe('WhatsApp Vida Centro');
    // A CHAVE não existe — não é `null`, não é `''`. Ausente = preserva (§6).
    expect(channel && 'apiToken' in channel).toBe(false);
    expect(channel && 'webhookSecret' in channel).toBe(false);
  });

  it('"remover token" envia apiToken: null (apaga explicitamente)', async () => {
    const user = userEvent.setup();
    signIn('admin');
    renderPage();

    await screen.findByDisplayValue('WhatsApp do Vida');
    await user.click(screen.getByRole('checkbox', { name: /remover token da api/i }));
    await user.click(screen.getByRole('button', { name: /salvar/i }));

    await waitFor(() => expect(updateChannelsMock).toHaveBeenCalledTimes(1));

    const channel = updateChannelsMock.mock.calls[0]?.[0]?.channels?.[0];
    expect(channel?.apiToken).toBeNull();
    // Só o token foi removido: o segredo do webhook segue intocado (ausente).
    expect(channel && 'webhookSecret' in channel).toBe(false);
  });

  it('mensagem automática ligada e vazia bloqueia o salvar', async () => {
    const user = userEvent.setup();
    signIn('admin');
    renderPage();

    const greeting = await screen.findByRole('textbox', { name: 'Texto — Saudação' });
    await user.clear(greeting);

    expect(screen.getByRole('button', { name: /salvar/i })).toBeDisabled();
    expect(screen.getByText(/senão o paciente recebe uma bolha em branco/i)).toBeInTheDocument();
    expect(updateChannelsMock).not.toHaveBeenCalled();
  });

  it('mostra o erro de campo devolvido pelo servidor', async () => {
    const user = userEvent.setup();
    signIn('admin');
    const { ApiError } = await import('@/api/client');
    updateChannelsMock.mockRejectedValue(
      new ApiError('VALIDATION_ERROR', 'Dados inválidos', 400, {
        fields: { 'businessHours.timezone': 'Fuso horário inválido' },
      }),
    );
    renderPage();

    const displayName = await screen.findByDisplayValue('WhatsApp do Vida');
    await user.type(displayName, ' Centro');
    await user.click(screen.getByRole('button', { name: /salvar/i }));

    expect(await screen.findByText('Fuso horário inválido')).toBeInTheDocument();
  });

  /**
   * O 400 REAL da API, campo por campo.
   *
   * `details.fields` é a única ponte entre a validação do servidor e o campo na
   * tela, e os dois lados estavam falando línguas diferentes: o backend
   * montava a chave com o ÍNDICE do array (`channels.0.phoneNumber`) e a tela
   * procurava pelo NOME do canal (`channels.whatsapp.phoneNumber`). O efeito
   * não era um erro no lugar errado — era erro NENHUM: a tela apagava a
   * mensagem geral (porque veio `fields`) e nenhum campo casava com a chave.
   * O admin digitava um número longo demais, tomava 400 e achava que salvou.
   *
   * O payload abaixo é o `details.fields` que
   * `backend/tests/operation/channel-settings.spec.ts`
   * ("details.fields usa o NOME do canal") prova ser o que a API devolve.
   */
  const FIELDS_DE_UM_400_REAL = {
    'channels.whatsapp.phoneNumber': 'Maximo de 30 caracteres',
  };

  it('encontra o campo do `details.fields` real de um 400', async () => {
    const user = userEvent.setup();
    signIn('admin');
    const { ApiError } = await import('@/api/client');
    updateChannelsMock.mockRejectedValue(
      new ApiError('VALIDATION_ERROR', 'Dados inválidos', 400, {
        fields: FIELDS_DE_UM_400_REAL,
      }),
    );
    renderPage();

    const phone = await screen.findByDisplayValue('+55 48 3621-0000');
    await user.type(phone, '99999999999999999999');
    await user.click(screen.getByRole('button', { name: /salvar/i }));

    // A mensagem aparece ONDE o admin errou...
    expect(await screen.findByText('Maximo de 30 caracteres')).toBeInTheDocument();
    expect(phone).toHaveAttribute('aria-invalid', 'true');
    // ...e o "salvo com sucesso" não aparece.
    expect(screen.queryByText('Configuração salva.')).not.toBeInTheDocument();
  });

  it('campo que a tela NÃO renderiza vira mensagem geral — nunca silêncio', async () => {
    const user = userEvent.setup();
    signIn('admin');
    const { ApiError } = await import('@/api/client');
    updateChannelsMock.mockRejectedValue(
      new ApiError('VALIDATION_ERROR', 'Dados inválidos', 400, {
        // Convenção divergente/campo desconhecido: o caso em que a tela ficava muda.
        fields: { 'channels.0.phoneNumber': 'Maximo de 30 caracteres' },
      }),
    );
    renderPage();

    const displayName = await screen.findByDisplayValue('WhatsApp do Vida');
    await user.type(displayName, ' Centro');
    await user.click(screen.getByRole('button', { name: /salvar/i }));

    const alerta = await screen.findByRole('alert');
    expect(alerta).toHaveTextContent(/Revise os dados informados/i);
    expect(alerta).toHaveTextContent('Maximo de 30 caracteres');
  });
});

describe('channels-form — regra do segredo', () => {
  it('canal intocado não entra no corpo (nada de canal fantasma)', () => {
    const body = buildUpdateRequest(toForm(settings), settings);
    expect(body.channels).toBeUndefined();
    // O resto do formulário vai sempre — corpo vazio seria VALIDATION_ERROR.
    expect(body.distributionMode).toBe('round_robin');
  });

  it('token digitado é gravado; branco é omitido; remover é null', () => {
    const form = toForm(settings);
    const [draft] = form.channels;
    if (!draft) throw new Error('fixture sem canal whatsapp');

    const written = buildUpdateRequest(
      { ...form, channels: [{ ...draft, apiTokenInput: 'EAAG-token-novo-123' }] },
      settings,
    ).channels?.[0];
    expect(written?.apiToken).toBe('EAAG-token-novo-123');

    const preserved = buildUpdateRequest(
      { ...form, channels: [{ ...draft, displayName: 'Outro nome' }] },
      settings,
    ).channels?.[0];
    expect(preserved && 'apiToken' in preserved).toBe(false);

    const erased = buildUpdateRequest(
      { ...form, channels: [{ ...draft, removeApiToken: true }] },
      settings,
    ).channels?.[0];
    expect(erased?.apiToken).toBeNull();
  });

  it('businessHours é substituição: dia fechado simplesmente não vai', () => {
    const form = toForm(settings);
    const body = buildUpdateRequest(form, settings);

    expect(body.businessHours?.days.mon).toEqual({ start: '08:00', end: '18:00' });
    expect(body.businessHours?.days.sat).toEqual({ start: '08:00', end: '12:00' });
    expect(body.businessHours?.days.sun).toBeUndefined();
    expect(body.businessHours?.days.tue).toBeUndefined();
  });

  it('mensagem sem texto vira null, nunca string vazia', () => {
    const form = toForm(settings);
    const body = buildUpdateRequest(
      { ...form, autoMessages: { ...form.autoMessages, greeting: { enabled: false, message: '  ' } } },
      settings,
    );
    expect(body.autoMessages?.greeting).toEqual({ enabled: false, message: null });
  });
});
