import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ListQuickRepliesResponse, QuickReply, UserRole } from '@crm-lab/shared';
import { querySuccess, mutationIdle } from '@/test/query-mocks';
import { useAuthStore } from '@/stores/auth.store';
import QuickReplies from './QuickReplies';
import * as quickRepliesApi from '@/api/quick-replies';
import { ApiError } from '@/api/client';
import { ToastProvider } from '@/components/ui';

/**
 * Mesmo padrão de `Insurances.spec.tsx`: mocka os HOOKS, não o objeto de API —
 * os hooks chamam `quickRepliesApi.list/create/...` de DENTRO do módulo, e um
 * mock que só troca o objeto exportado não muda o que eles enxergam.
 */
vi.mock('@/api/quick-replies', async () => {
  const actual = await vi.importActual('@/api/quick-replies');
  return {
    ...actual,
    useQuickReplyList: vi.fn(),
    useCreateQuickReply: vi.fn(),
    useUpdateQuickReply: vi.fn(),
    useDeleteQuickReply: vi.fn(),
  };
});

const useQuickReplyList = vi.mocked(quickRepliesApi.useQuickReplyList);
const useCreateQuickReply = vi.mocked(quickRepliesApi.useCreateQuickReply);
const useUpdateQuickReply = vi.mocked(quickRepliesApi.useUpdateQuickReply);
const useDeleteQuickReply = vi.mocked(quickRepliesApi.useDeleteQuickReply);

const coleta: QuickReply = {
  id: 'qr-1',
  shortcut: 'coleta',
  title: 'Horário de coleta',
  content: 'Coleta de segunda a sexta, das 6h30 às 11h.',
  createdBy: 'user-9',
  createdAt: '2026-09-06T12:00:00.000Z',
  updatedAt: '2026-09-06T12:00:00.000Z',
};

function listResult(quickReplies: QuickReply[] = [coleta]) {
  return querySuccess<ListQuickRepliesResponse>({ quickReplies });
}

function signIn(role: UserRole) {
  useAuthStore.setState({
    user: { id: 'user-9', email: 'ana@lab.com.br', name: 'Ana', role, discountLimit: 10 },
  });
}

function renderPage() {
  return render(
    <ToastProvider>
      <MemoryRouter>
        <QuickReplies />
      </MemoryRouter>
    </ToastProvider>,
  );
}

describe('QuickReplies', () => {
  const mockCreate = vi.fn();
  const mockUpdate = vi.fn();
  const mockRemove = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    useQuickReplyList.mockReturnValue(listResult());
    useCreateQuickReply.mockReturnValue(mutationIdle(mockCreate));
    useUpdateQuickReply.mockReturnValue(mutationIdle(mockUpdate));
    useDeleteQuickReply.mockReturnValue(mutationIdle(mockRemove));
  });

  afterEach(() => {
    useAuthStore.setState({ user: null });
  });

  it('lista as macros com o atalho em destaque', async () => {
    signIn('attendant');
    renderPage();

    expect(await screen.findByText('/coleta')).toBeInTheDocument();
    expect(screen.getByText('Horário de coleta')).toBeInTheDocument();
  });

  it('a ATENDENTE cria, edita e apaga — a tela não é gestor+', async () => {
    signIn('attendant');
    renderPage();

    expect(await screen.findByRole('button', { name: /nova resposta/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /editar \/coleta/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /apagar \/coleta/i })).toBeInTheDocument();
  });

  it('cria a macro com o que o formulário tem', async () => {
    const user = userEvent.setup();
    signIn('attendant');
    renderPage();

    await user.click(await screen.findByRole('button', { name: /nova resposta/i }));
    await user.type(screen.getByLabelText('Atalho'), 'jejum');
    await user.type(screen.getByLabelText('Título'), 'Jejum');
    await user.type(screen.getByLabelText('Resposta'), 'Jejum de 8 horas para glicemia.');
    await user.click(screen.getByRole('button', { name: /^criar$/i }));

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate.mock.calls[0]?.[0]).toMatchObject({
      shortcut: 'jejum',
      title: 'Jejum',
      content: 'Jejum de 8 horas para glicemia.',
    });
  });

  it('atalho fora do formato é barrado ANTES da chamada, marcando o campo', async () => {
    const user = userEvent.setup();
    signIn('attendant');
    renderPage();

    await user.click(await screen.findByRole('button', { name: /nova resposta/i }));
    await user.type(screen.getByLabelText('Atalho'), 'horário coleta');
    await user.type(screen.getByLabelText('Título'), 'Coleta');
    await user.type(screen.getByLabelText('Resposta'), 'Texto');
    await user.click(screen.getByRole('button', { name: /^criar$/i }));

    expect(mockCreate).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Atalho')).toHaveAttribute('aria-invalid', 'true');
  });

  it('título e resposta vazios são barrados na tela — o botão fica fora do <form>', async () => {
    const user = userEvent.setup();
    signIn('attendant');
    renderPage();

    await user.click(await screen.findByRole('button', { name: /nova resposta/i }));
    await user.type(screen.getByLabelText('Atalho'), 'jejum');
    await user.click(screen.getByRole('button', { name: /^criar$/i }));

    expect(mockCreate).not.toHaveBeenCalled();
    expect(screen.getByLabelText('Título')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Resposta')).toHaveAttribute('aria-invalid', 'true');
  });

  it('VALIDATION_ERROR do servidor mantém o modal aberto e marca o campo (CRMLAB-47)', async () => {
    const user = userEvent.setup();
    signIn('attendant');
    mockCreate.mockImplementation((_body, opts) => {
      opts?.onError?.(
        new ApiError('VALIDATION_ERROR', 'Invalid', 400, {
          fields: { shortcut: 'Já existe uma resposta rápida com este atalho' },
        }),
      );
    });
    renderPage();

    await user.click(await screen.findByRole('button', { name: /nova resposta/i }));
    await user.type(screen.getByLabelText('Atalho'), 'coleta');
    await user.type(screen.getByLabelText('Título'), 'Coleta');
    await user.type(screen.getByLabelText('Resposta'), 'Texto');
    await user.click(screen.getByRole('button', { name: /^criar$/i }));

    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('Atalho')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByText('Já existe uma resposta rápida com este atalho')).toBeInTheDocument();
  });

  it('o modal só fecha quando o servidor confirma', async () => {
    const user = userEvent.setup();
    signIn('attendant');
    renderPage();

    await user.click(await screen.findByRole('button', { name: /nova resposta/i }));
    await user.type(screen.getByLabelText('Atalho'), 'jejum');
    await user.type(screen.getByLabelText('Título'), 'Jejum');
    await user.type(screen.getByLabelText('Resposta'), 'Jejum de 8 horas.');
    await user.click(screen.getByRole('button', { name: /^criar$/i }));

    // mutate mockado não chama onSuccess: o formulário continua na tela.
    expect(screen.getByLabelText('Atalho')).toBeInTheDocument();

    const opts = mockCreate.mock.calls[0]?.[1] as { onSuccess?: () => void } | undefined;
    act(() => opts?.onSuccess?.());
    expect(screen.queryByLabelText('Atalho')).not.toBeInTheDocument();
  });

  it('editar abre o formulário preenchido e manda só o PATCH', async () => {
    const user = userEvent.setup();
    signIn('manager');
    renderPage();

    await user.click(await screen.findByRole('button', { name: /editar \/coleta/i }));
    expect(screen.getByLabelText('Atalho')).toHaveValue('coleta');

    await user.clear(screen.getByLabelText('Título'));
    await user.type(screen.getByLabelText('Título'), 'Coleta matinal');
    await user.click(screen.getByRole('button', { name: /^atualizar$/i }));

    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate.mock.calls[0]?.[0]).toMatchObject({
      id: 'qr-1',
      dto: { title: 'Coleta matinal' },
    });
  });

  it('apagar pede confirmação — o DELETE é real', async () => {
    const user = userEvent.setup();
    signIn('attendant');
    renderPage();

    await user.click(await screen.findByRole('button', { name: /apagar \/coleta/i }));
    expect(mockRemove).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /^apagar$/i }));
    expect(mockRemove).toHaveBeenCalledWith('qr-1');
  });

  it('lista vazia explica o que a funcionalidade faz', async () => {
    useQuickReplyList.mockReturnValue(listResult([]));
    signIn('attendant');
    renderPage();

    expect(await screen.findByText(/nenhuma resposta rápida ainda/i)).toBeInTheDocument();
    // Uma lista vazia sem explicação não ensina que existe `/` no Composer.
    expect(screen.getByText(/no campo vazio e escolher pelo atalho/i)).toBeInTheDocument();
  });
});
