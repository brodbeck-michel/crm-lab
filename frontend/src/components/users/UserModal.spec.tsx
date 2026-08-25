import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  CreateUserRequest,
  ListUsersResponse,
  ManagedUser,
  UpdateUserRequest,
} from '@crm-lab/shared';
import { querySuccess, mutationIdle, mutationPending } from '@/test/query-mocks';
import UserModal from './UserModal';
import * as usersApi from '@/api/users';

const EXISTING_USER: ManagedUser = {
  id: '1',
  email: 'user@lab.com',
  name: 'Existing User',
  role: 'attendant',
  discountLimit: 15,
  isActive: true,
  lastLoginAt: '2026-08-23T10:00:00Z',
  createdAt: '2026-08-01T10:00:00Z',
};

/**
 * `useUserList` NAO e usado pelo modal (o registro chega pela linha clicada) —
 * o mock existe so para o caso de alguem reintroduzir a varredura. Ele agora e
 * TIPADO: as duas metades deste arquivo mockavam o MESMO hook com shapes
 * incompativeis (`data: []` aqui, `data: { users, pagination }` la embaixo) e o
 * `as any` engolia a divergencia. Fonte unica: `EMPTY_USER_LIST`.
 */
const EMPTY_USER_LIST: ListUsersResponse = {
  users: [],
  pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
};

// Mock API hooks
vi.mock('@/api/users', async () => {
  const actual = await vi.importActual('@/api/users');
  return {
    ...actual,
    useCreateUser: vi.fn(),
    useUpdateUser: vi.fn(),
    useUserList: vi.fn(),
  };
});

describe('UserModal', () => {
  const mockOnClose = vi.fn();
  const mockCreateUser = vi.fn();
  const mockUpdateUser = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    vi.mocked(usersApi.useCreateUser).mockReturnValue(mutationIdle(mockCreateUser));

    vi.mocked(usersApi.useUpdateUser).mockReturnValue(mutationIdle(mockUpdateUser));

    vi.mocked(usersApi.useUserList).mockReturnValue(querySuccess(EMPTY_USER_LIST));
  });

  const renderComponent = (user?: ManagedUser) => {
    return render(
      <UserModal user={user} onClose={mockOnClose} />
    );
  };

  describe('Create Mode', () => {
    it('should render create user form with title', () => {
      renderComponent();

      // Check for dialog title
      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAccessibleName('Novo Usuário');
    });

    it('should render form fields for create', () => {
      renderComponent();

      expect(screen.getByPlaceholderText('usuario@lab.com')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Nome Completo')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Mínimo 8 caracteres')).toBeInTheDocument();
    });

    it('should validate required fields', async () => {
      renderComponent();
      const user = userEvent.setup();

      const submitButton = screen.getByRole('button', { name: 'Criar Usuário' });
      await user.click(submitButton);

      await waitFor(() => {
        expect(screen.getByText('Email é obrigatório')).toBeInTheDocument();
        expect(screen.getByText('Nome é obrigatório')).toBeInTheDocument();
        expect(screen.getByText('Senha é obrigatória')).toBeInTheDocument();
      });
    });

    it('should show default discount limit', () => {
      renderComponent();

      expect(screen.getByText('Padrão: 15%')).toBeInTheDocument();
    });
  });

  describe('Edit Mode', () => {
    it('should render edit user form with title', async () => {
      renderComponent(EXISTING_USER);

      await waitFor(() => {
        const dialog = screen.getByRole('dialog');
        expect(dialog).toHaveAccessibleName('Editar Usuário');
      });
    });

    it('should not show password field in edit mode', async () => {
      renderComponent(EXISTING_USER);

      await waitFor(() => {
        expect(screen.queryByPlaceholderText('Mínimo 8 caracteres')).not.toBeInTheDocument();
      });
    });

    it('should show isActive toggle in edit mode', async () => {
      renderComponent(EXISTING_USER);

      await waitFor(() => {
        expect(screen.getByText('Usuário Ativo')).toBeInTheDocument();
      });
    });
  });

  describe('Form Submission', () => {
    it('should submit with valid create data', async () => {
      renderComponent();
      const user = userEvent.setup();

      await user.type(screen.getByPlaceholderText('usuario@lab.com'), 'new@lab.com');
      await user.type(screen.getByPlaceholderText('Nome Completo'), 'New User');
      await user.type(screen.getByPlaceholderText('Mínimo 8 caracteres'), 'senha123');

      const submitButton = screen.getByRole('button', { name: 'Criar Usuário' });
      await user.click(submitButton);

      await waitFor(() => {
        expect(mockCreateUser).toHaveBeenCalled();
      });
    });

    it('should disable submit button while loading', async () => {
      vi.mocked(usersApi.useCreateUser).mockReturnValue(
        mutationPending<ManagedUser, CreateUserRequest>(
          {
            email: 'new@lab.com',
            name: 'New User',
            password: 'senha123',
            role: 'attendant',
            discountLimit: 15,
          },
          mockCreateUser,
        ),
      );

      renderComponent();

      const submitButton = screen.getByRole('button', { name: 'Criar Usuário' });
      expect(submitButton).toBeDisabled();
    });

    it('should close modal via cancel button', async () => {
      renderComponent();
      const user = userEvent.setup();

      const cancelButton = screen.getByRole('button', { name: 'Cancelar' });
      await user.click(cancelButton);

      expect(mockOnClose).toHaveBeenCalled();
    });
  });
});

/**
 * Defeito QA-E2E #1: o modal varria `useUserList({ limit: 1000 })` para achar o
 * registro. O zod do controller corta em `.max(100)` → 400 → formulário vazio.
 * O registro tem que chegar pela linha clicada.
 */
describe('Edição sem varrer a lista', () => {
  const mockOnCloseEdit = vi.fn();
  const rowUser = EXISTING_USER;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usersApi.useCreateUser).mockReturnValue(
      mutationIdle<ManagedUser, CreateUserRequest>(),
    );
    vi.mocked(usersApi.useUpdateUser).mockReturnValue(
      mutationIdle<ManagedUser, { id: string; data: UpdateUserRequest }>(),
    );
    // MESMO shape do bloco de cima — antes divergia, e nada reclamava.
    vi.mocked(usersApi.useUserList).mockReturnValue(querySuccess(EMPTY_USER_LIST));
  });

  it('preenche o formulário com o usuário recebido da linha', async () => {
    render(<UserModal user={rowUser} onClose={mockOnCloseEdit} />);

    await waitFor(() => {
      expect(screen.getByPlaceholderText('usuario@lab.com')).toHaveValue('user@lab.com');
      expect(screen.getByPlaceholderText('Nome Completo')).toHaveValue('Existing User');
    });
  });

  it('não lista usuários para editar (limit > 100 volta 400)', () => {
    render(<UserModal user={rowUser} onClose={mockOnCloseEdit} />);

    expect(vi.mocked(usersApi.useUserList)).not.toHaveBeenCalled();
  });
});
