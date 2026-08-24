import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import UserModal from './UserModal';
import * as usersApi from '@/api/users';

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

    vi.mocked(usersApi.useCreateUser).mockReturnValue({
      mutate: mockCreateUser,
      isPending: false,
    } as any);

    vi.mocked(usersApi.useUpdateUser).mockReturnValue({
      mutate: mockUpdateUser,
      isPending: false,
    } as any);

    vi.mocked(usersApi.useUserList).mockReturnValue({
      data: [],
      isLoading: false,
      error: null,
    } as any);
  });

  const renderComponent = (userId?: string) => {
    return render(
      <UserModal userId={userId} onClose={mockOnClose} />
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
    beforeEach(() => {
      vi.mocked(usersApi.useUserList).mockReturnValue({
        data: [
          {
            id: '1',
            email: 'user@lab.com',
            name: 'Existing User',
            role: 'attendant',
            discountLimit: 15,
            isActive: true,
            lastLoginAt: '2026-08-23T10:00:00Z',
            createdAt: '2026-08-01T10:00:00Z',
          },
        ],
        isLoading: false,
        error: null,
      } as any);
    });

    it('should render edit user form with title', async () => {
      renderComponent('1');

      await waitFor(() => {
        const dialog = screen.getByRole('dialog');
        expect(dialog).toHaveAccessibleName('Editar Usuário');
      });
    });

    it('should not show password field in edit mode', async () => {
      renderComponent('1');

      await waitFor(() => {
        expect(screen.queryByPlaceholderText('Mínimo 8 caracteres')).not.toBeInTheDocument();
      });
    });

    it('should show isActive toggle in edit mode', async () => {
      renderComponent('1');

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
      vi.mocked(usersApi.useCreateUser).mockReturnValue({
        mutate: mockCreateUser,
        isPending: true,
      } as any);

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
