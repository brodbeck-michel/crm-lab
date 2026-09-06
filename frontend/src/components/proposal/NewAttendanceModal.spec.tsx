import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ConversationDetail } from '@crm-lab/shared';
import { queryClient } from '@/api/query-client';
import { ToastProvider } from '@/components/ui';
import { conversationsApi } from '@/api/conversations';
import NewAttendanceModal from './NewAttendanceModal';

vi.mock('@/api/conversations');

const navigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigate,
}));

const CONVERSATION = {
  id: 'conv-9',
  patientId: 'pat-9',
  patientName: 'Maria Balcao',
  patientPhone: '+5548999991234',
  patientEmail: null,
  assignedTo: 'user-1',
  assignedToName: 'Maria',
  channel: 'direct',
  status: 'active',
  unreadCount: 0,
  lastMessagePreview: null,
  lastMessageAt: null,
  tags: [],
  pinned: false,
  customFields: {},
  createdAt: '2026-09-05T10:00:00Z',
} satisfies ConversationDetail;

function renderModal() {
  return render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <NewAttendanceModal onClose={() => {}} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('NewAttendanceModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(conversationsApi.create).mockResolvedValue(CONVERSATION);
  });

  it('cria a conversa e leva para o orcamento daquela conversa', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText('Nome do paciente'), 'Maria Balcao');
    await user.type(screen.getByLabelText('Telefone'), '(48) 99999-1234');
    await user.click(screen.getByRole('button', { name: /criar e montar/i }));

    await waitFor(() => {
      expect(conversationsApi.create).toHaveBeenCalledWith({
        patientName: 'Maria Balcao',
        patientPhone: '(48) 99999-1234',
        patientEmail: null,
        channel: 'direct',
      });
    });
    await waitFor(() => {
      expect(navigate).toHaveBeenCalledWith('/budget/new?conversationId=conv-9');
    });
  });

  it('envia o canal escolhido na origem', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.type(screen.getByLabelText('Nome do paciente'), 'Joao Site');
    await user.type(screen.getByLabelText('Telefone'), '48999991234');
    await user.selectOptions(screen.getByLabelText('Origem'), 'web');
    await user.click(screen.getByRole('button', { name: /criar e montar/i }));

    await waitFor(() => {
      expect(conversationsApi.create).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'web' }),
      );
    });
  });
});
