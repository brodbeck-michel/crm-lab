import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  ConversationDetail,
  FunnelRules,
  ListProposalsResponse,
  Proposal,
} from '@crm-lab/shared';
import { DEFAULT_FUNNEL_RULES } from '@crm-lab/shared';
import { ApiError } from '@/api';
import * as proposalsApi from '@/api/proposals';
import * as funnelRulesApi from '@/api/funnel-rules';
import * as insurancesApi from '@/api/insurances';
import { useAuthStore } from '@/stores/auth.store';
import { mutationIdle, querySuccess } from '@/test/query-mocks';
import { LinkBudgetButton, rankBudgets } from './LinkBudgetModal';
import { sendErrorMessage } from './SendProposalPanel';

vi.mock('@/api/proposals');
vi.mock('@/api/funnel-rules');
vi.mock('@/api/insurances');

const CONVERSATION = {
  id: 'conv-1',
  patientId: null,
  patientName: 'Maria Souza',
  patientPhone: '+5548999990001',
  assignedTo: 'user-1',
  assignedToName: 'Ana',
  channel: 'whatsapp',
  status: 'active',
  unreadCount: 0,
  lastMessagePreview: null,
  lastMessageAt: null,
  tags: [],
  pinned: false,
  createdAt: '2026-10-28T00:00:00Z',
  patientEmail: null,
  customFields: {},
} as unknown as ConversationDetail;

function budget(id: string, patientName: string, extra: Partial<Proposal> = {}): Proposal {
  return {
    id,
    proposalNumber: 1,
    origin: 'bitlab',
    conversationId: null,
    patientName,
    status: 'novo_contato',
    discountPercent: 0,
    totalPrice: 150.5,
    createdBy: null,
    createdByName: '',
    approvalStatus: 'none',
    reasonLost: null,
    createdAt: '2026-10-28T10:00:00Z',
    updatedAt: '2026-10-28T10:00:00Z',
    closedAt: null,
    insuranceId: null,
    lisBudgetNumber: id.replace('p-', ''),
    lisReconciledAt: null,
    lisRequisitionNumber: null,
    lisIssuedOn: '2026-10-27',
    lisAttendantName: 'MARIA RECEPCAO',
    ...extra,
  };
}

function listOf(proposals: Proposal[]): ListProposalsResponse {
  return { proposals, pagination: { page: 1, limit: 100, total: proposals.length, totalPages: 1 } };
}

let sendMutate: ReturnType<typeof vi.fn>;

function mockRules(rules: FunnelRules | undefined) {
  vi.mocked(funnelRulesApi.useFunnelRules).mockReturnValue(
    querySuccess(rules) as ReturnType<typeof funnelRulesApi.useFunnelRules>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sendMutate = vi.fn();
  vi.mocked(proposalsApi.useSendProposal).mockReturnValue(mutationIdle(sendMutate));
  vi.mocked(proposalsApi.useResendProposal).mockReturnValue(mutationIdle());
  vi.mocked(proposalsApi.useUpdateProposalConversation).mockReturnValue(mutationIdle());
  vi.mocked(insurancesApi.useInsuranceList).mockReturnValue(
    querySuccess({ insurances: [], pagination: { page: 1, limit: 100, total: 0, totalPages: 0 } }),
  );
  vi.mocked(proposalsApi.proposalsApi.list).mockResolvedValue(
    listOf([
      budget('p-6001', 'JOAO PEREIRA'),
      budget('p-6002', 'MARIA DA SILVA SOUZA', { lisRequisitionNumber: '001-1' }),
      budget('p-6003', 'CARLA MENDES', { createdBy: 'user-2', createdByName: 'Bia' }),
    ]),
  );
  mockRules(DEFAULT_FUNNEL_RULES);
  useAuthStore.setState({
    user: { id: 'user-1', email: 'ana@lab.test', name: 'Ana', role: 'attendant', discountLimit: 5 },
  });
});

function renderButton(conversation: ConversationDetail = CONVERSATION) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <LinkBudgetButton conversation={conversation} />
    </QueryClientProvider>,
  );
}

async function openModal() {
  renderButton();
  fireEvent.click(screen.getByRole('button', { name: 'Vincular orçamento' }));
  return screen.findByRole('list', { name: 'Orçamentos' });
}

describe('rankBudgets', () => {
  it('mais parecidos com o nome da conversa em cima; o resto na ordem do servidor', () => {
    const ranked = rankBudgets('Maria Souza', [
      budget('p-1', 'JOAO'),
      budget('p-2', 'MARIA OLIVEIRA'),
      budget('p-3', 'MARIA DA SILVA SOUZA'),
      budget('p-4', 'PEDRO'),
    ]);
    expect(ranked.map((c) => c.proposal.id)).toEqual(['p-3', 'p-2', 'p-1', 'p-4']);
  });
});

describe('LinkBudgetButton', () => {
  it('some com "Nascer do orçamento do Bitlab" desligada, com regras carregando e em conversa encerrada', () => {
    mockRules({ ...DEFAULT_FUNNEL_RULES, origin: { fromBitlab: false, manualInCrm: true } });
    const { unmount } = renderButton();
    expect(screen.queryByRole('button', { name: 'Vincular orçamento' })).not.toBeInTheDocument();
    unmount();

    mockRules(undefined);
    const second = renderButton();
    expect(screen.queryByRole('button', { name: 'Vincular orçamento' })).not.toBeInTheDocument();
    second.unmount();

    mockRules(DEFAULT_FUNNEL_RULES);
    renderButton({ ...CONVERSATION, status: 'closed' } as ConversationDetail);
    expect(screen.queryByRole('button', { name: 'Vincular orçamento' })).not.toBeInTheDocument();
  });

  it('lista só os "Novo orçamento" sem conversa, o mais parecido primeiro, sem os de outra atendente', async () => {
    const list = await openModal();
    expect(proposalsApi.proposalsApi.list).toHaveBeenCalledWith({
      status: 'novo_contato',
      withoutConversation: true,
      limit: 100,
    });
    const items = within(list).getAllByTestId('link-budget-candidate');
    expect(items.map((b) => b.textContent)).toEqual([
      expect.stringContaining('MARIA DA SILVA SOUZA'),
      expect.stringContaining('JOAO PEREIRA'),
    ]);
    // Nº, valor, data e usuário do Bitlab; selo de semelhança e de pré-cadastro.
    expect(items[0]!.textContent).toMatch(/Nº 6002 · R\$\s150,50 · 27\/10\/2026 · MARIA RECEPCAO/);
    expect(within(items[0]!).getByText('Mais parecido')).toBeInTheDocument();
    expect(within(items[0]!).getByText('Pré-cadastro feito')).toBeInTheDocument();
    expect(within(items[1]!).queryByText('Mais parecido')).not.toBeInTheDocument();
  });

  it('busca por nome ou nº vai para o servidor', async () => {
    await openModal();
    fireEvent.change(screen.getByLabelText('Buscar orçamento'), { target: { value: '6001' } });
    await waitFor(() =>
      expect(proposalsApi.proposalsApi.list).toHaveBeenCalledWith(
        expect.objectContaining({ search: '6001', withoutConversation: true }),
      ),
    );
  });

  it('escolher mostra a mensagem do modelo (com escolha A prazo/À vista) e envia por esta conversa', async () => {
    mockRules({
      ...DEFAULT_FUNNEL_RULES,
      sendMessage: {
        templates: [
          { name: 'A prazo', text: 'Olá, {paciente}! Orçamento nº {numero_orcamento}: {valor} a prazo.' },
          { name: 'À vista', text: 'Olá, {paciente}! Orçamento nº {numero_orcamento}: {valor} à vista.' },
        ],
      },
    } as FunnelRules);
    const list = await openModal();
    fireEvent.click(within(list).getAllByTestId('link-budget-candidate')[0]!);

    // Sem lista de conversas: a conversa é a aberta.
    expect(screen.queryByRole('list', { name: 'Conversas' })).not.toBeInTheDocument();
    expect(screen.getByText('Negociação')).toBeInTheDocument(); // tem requisição -> régua de fatos
    const message = screen.getByLabelText('Mensagem') as HTMLTextAreaElement;
    expect(message.value).toMatch(/a prazo\.$/);
    fireEvent.change(screen.getByLabelText('Modelo da mensagem'), { target: { value: '1' } });
    expect(message.value).toMatch(/^Olá, MARIA DA SILVA SOUZA! Orçamento nº 6002: R\$\s150,50 à vista\.$/);

    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(sendMutate).toHaveBeenCalledWith(
      { proposalId: 'p-6002', body: { conversationId: 'conv-1', message: message.value } },
      expect.anything(),
    );
  });

  it('envio duplicado: mostra que outra atendente já enviou', async () => {
    sendMutate.mockImplementation((_vars, handlers: { onError: (e: unknown) => void }) =>
      handlers.onError(
        new ApiError('PROPOSAL_ALREADY_SENT', 'Este orcamento ja foi enviado', 409, { reason: 'sent' }),
      ),
    );
    const list = await openModal();
    fireEvent.click(within(list).getAllByTestId('link-budget-candidate')[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    expect(screen.getByRole('alert')).toHaveTextContent('O orçamento já foi enviado por outra atendente.');
  });

  it('nenhum candidato: avisa', async () => {
    vi.mocked(proposalsApi.proposalsApi.list).mockResolvedValue(listOf([]));
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: 'Vincular orçamento' }));
    expect(await screen.findByText('Nenhum orçamento em “Novo orçamento” sem conversa.')).toBeInTheDocument();
  });
});

describe('sendErrorMessage', () => {
  it('in_progress tem frase própria; outros erros usam a mensagem do servidor', () => {
    expect(
      sendErrorMessage(new ApiError('PROPOSAL_ALREADY_SENT', 'x', 409, { reason: 'in_progress' })),
    ).toBe('Outra atendente está enviando este orçamento agora.');
    expect(sendErrorMessage(new ApiError('NOT_FOUND', 'Nao encontrado', 404))).toBe('Nao encontrado');
  });
});
