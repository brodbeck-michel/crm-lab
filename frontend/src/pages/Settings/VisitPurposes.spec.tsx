import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserRole, VisitPurpose } from '@crm-lab/shared';
import { ApiError } from '@/api/client';
import { visitPurposesApi } from '@/api/visit-purposes';
import { ToastProvider } from '@/components/ui';
import { useAuthStore } from '@/stores/auth.store';
import VisitPurposes from './VisitPurposes';

/**
 * Finalidades de visita — `/settings/visit-purposes` (CRMLAB-190, D-330).
 * `useVisitPurposes` chama `visitPurposesApi.list` no próprio objeto, então o
 * `spyOn` nos métodos chega ao hook real.
 */
function purpose(overrides: Partial<VisitPurpose> & Pick<VisitPurpose, 'id' | 'name'>): VisitPurpose {
  return {
    color: 'azul',
    isActive: true,
    sortOrder: 1,
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    ...overrides,
  };
}

const VISITA = purpose({ id: 'p-1', name: 'Visita', color: 'azul', sortOrder: 1 });
const PATROCINIO = purpose({ id: 'p-2', name: 'Solicitação de patrocínio', color: 'verde', sortOrder: 2 });
const ANTIGA = purpose({ id: 'p-3', name: 'Antiga', color: 'cinza', sortOrder: 3, isActive: false });

function signIn(role: UserRole) {
  useAuthStore.setState({
    user: { id: 'u-1', email: 'quem@lab.test', name: 'Quem', role, discountLimit: 10 },
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
          <VisitPurposes />
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('Finalidades de visita (/settings/visit-purposes)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(visitPurposesApi, 'list').mockResolvedValue({ purposes: [VISITA, PATROCINIO, ANTIGA] });
    signIn('manager');
  });

  it('lista na ordem com a amostra da cor e o status', async () => {
    renderPage();
    const sample = await screen.findByText('Solicitação de patrocínio');
    expect(sample.closest('[data-purpose-color]')).toHaveAttribute('data-purpose-color', 'verde');
    expect(screen.getAllByText('Ativa')).toHaveLength(2);
    expect(screen.getByText('Inativa')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Subir Visita' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Descer Antiga' })).toBeDisabled();
  });

  it('atendente não vê controles de escrita', async () => {
    signIn('attendant');
    renderPage();
    await screen.findByText('Visita');
    expect(screen.queryByRole('button', { name: '+ Nova finalidade' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Editar' })).not.toBeInTheDocument();
  });

  it('cria com nome e cor da paleta; nome repetido marca o campo', async () => {
    const user = userEvent.setup({ delay: null });
    const create = vi
      .spyOn(visitPurposesApi, 'create')
      .mockRejectedValueOnce(
        new ApiError('VALIDATION_ERROR', 'Dados inválidos', 422, { fields: { name: 'Já existe uma finalidade com esse nome' } }),
      )
      .mockResolvedValueOnce(purpose({ id: 'p-9', name: 'Congresso', color: 'violeta' }));
    renderPage();
    await user.click(await screen.findByRole('button', { name: '+ Nova finalidade' }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Nova finalidade' }));

    await user.type(dialog.getByLabelText(/Nome/), 'Congresso');
    const violeta = dialog.getByRole('radio', { name: 'Violeta' });
    await user.click(violeta);
    expect(violeta).toHaveAttribute('aria-checked', 'true');
    expect(dialog.queryByLabelText('Ativa')).not.toBeInTheDocument();

    await user.click(dialog.getByRole('button', { name: 'Criar' }));
    expect(create).toHaveBeenCalledWith({ name: 'Congresso', color: 'violeta' });
    expect(await dialog.findByText('Já existe uma finalidade com esse nome')).toBeInTheDocument();

    await user.click(dialog.getByRole('button', { name: 'Criar' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('edita mandando só o que mudou (inativar)', async () => {
    const user = userEvent.setup({ delay: null });
    const update = vi.spyOn(visitPurposesApi, 'update').mockResolvedValue({ ...PATROCINIO, isActive: false });
    renderPage();
    await screen.findByText('Solicitação de patrocínio');
    await user.click(screen.getAllByRole('button', { name: 'Editar' })[1]!);
    const dialog = within(await screen.findByRole('dialog', { name: 'Editar finalidade' }));
    expect(dialog.getByRole('radio', { name: 'Verde' })).toHaveAttribute('aria-checked', 'true');

    await user.click(dialog.getByRole('switch'));
    await user.click(dialog.getByRole('button', { name: 'Salvar' }));
    await waitFor(() => expect(update).toHaveBeenCalledWith('p-2', { isActive: false }));
  });

  it('descer troca o sortOrder com a vizinha', async () => {
    const user = userEvent.setup({ delay: null });
    const update = vi.spyOn(visitPurposesApi, 'update').mockResolvedValue(VISITA);
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Descer Visita' }));
    await waitFor(() => expect(update).toHaveBeenCalledTimes(2));
    expect(update).toHaveBeenNthCalledWith(1, 'p-1', { sortOrder: 2 });
    expect(update).toHaveBeenNthCalledWith(2, 'p-2', { sortOrder: 1 });
  });
});
