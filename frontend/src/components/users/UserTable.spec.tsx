import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import UserTable from './UserTable';
import type { ManagedUser } from '@crm-lab/shared';

const mockUsers: ManagedUser[] = [
  {
    id: '1',
    email: 'admin@lab.com',
    name: 'Admin',
    role: 'admin',
    discountLimit: 100,
    isActive: true,
    lastLoginAt: '2026-08-23T10:00:00Z',
    createdAt: '2026-08-01T10:00:00Z',
  },
  {
    id: '2',
    email: 'maria@lab.com',
    name: 'Maria Silva',
    role: 'attendant',
    discountLimit: 15,
    isActive: true,
    lastLoginAt: null,
    createdAt: '2026-08-15T10:00:00Z',
  },
  {
    id: '3',
    email: 'inativo@lab.com',
    name: 'Usuário Inativo',
    role: 'manager',
    discountLimit: 30,
    isActive: false,
    lastLoginAt: '2026-08-20T15:00:00Z',
    createdAt: '2026-08-10T10:00:00Z',
  },
];

describe('UserTable', () => {
  const mockOnEdit = vi.fn();
  const mockOnPageChange = vi.fn();

  const renderComponent = (users = mockUsers): void => {
    render(
      <UserTable
        users={users}
        pagination={{ page: 1, limit: 20, total: 3, totalPages: 1 }}
        onEdit={mockOnEdit}
        onPageChange={mockOnPageChange}
      />
    );
  };

  it('should render table with user data', () => {
    renderComponent();

    // Check headers
    expect(screen.getByText('Email')).toBeInTheDocument();
    expect(screen.getByText('Nome')).toBeInTheDocument();
    expect(screen.getByText('Função')).toBeInTheDocument();
    expect(screen.getByText('Alçada')).toBeInTheDocument();
    expect(screen.getByText('Status')).toBeInTheDocument();

    // Check user data
    expect(screen.getByText('admin@lab.com')).toBeInTheDocument();
    expect(screen.getByText('Admin')).toBeInTheDocument();
    expect(screen.getByText('maria@lab.com')).toBeInTheDocument();
    expect(screen.getByText('Maria Silva')).toBeInTheDocument();
  });

  it('should display role labels correctly', () => {
    renderComponent();

    expect(screen.getByText('Administrador')).toBeInTheDocument();
    expect(screen.getByText('Atendente')).toBeInTheDocument();
    expect(screen.getByText('Gestor')).toBeInTheDocument();
  });

  it('should display active/inactive status', () => {
    renderComponent();

    // Check that the table renders status columns with text
    const ativoTexts = screen.getAllByText('Ativo');
    const inativoText = screen.getByText('Inativo');

    expect(ativoTexts.length).toBeGreaterThan(0);
    expect(inativoText).toBeInTheDocument();
  });

  it('should display "Nunca" for users without last login', () => {
    renderComponent();

    expect(screen.getByText('Nunca')).toBeInTheDocument();
  });

  it('should render edit buttons', () => {
    renderComponent();

    const editButtons = screen.getAllByText('Editar');
    expect(editButtons).toHaveLength(3);
  });

  it('should call onEdit when edit button is clicked', () => {
    renderComponent();

    const editButtons = screen.getAllByText('Editar');
    expect(editButtons.length).toBeGreaterThan(0);
    editButtons[0]!.click();

    expect(mockOnEdit).toHaveBeenCalledWith('1');
  });

  it('should show empty state when no users', () => {
    render(
      <UserTable
        users={[]}
        pagination={{ page: 1, limit: 20, total: 0, totalPages: 0 }}
        onEdit={mockOnEdit}
        onPageChange={mockOnPageChange}
      />
    );

    expect(screen.getByText('Nenhum usuário encontrado')).toBeInTheDocument();
  });

  it('should show pagination when multiple pages', () => {
    render(
      <UserTable
        users={mockUsers}
        pagination={{ page: 1, limit: 20, total: 50, totalPages: 3 }}
        onEdit={mockOnEdit}
        onPageChange={mockOnPageChange}
      />
    );

    expect(screen.getByText('Mostrando 3 de 50 usuários')).toBeInTheDocument();
    expect(screen.getByText('Página 1 de 3')).toBeInTheDocument();
  });

  it('should disable previous button on first page', () => {
    render(
      <UserTable
        users={mockUsers}
        pagination={{ page: 1, limit: 20, total: 50, totalPages: 3 }}
        onEdit={mockOnEdit}
        onPageChange={mockOnPageChange}
      />
    );

    const previousButton = screen.getByText('Anterior');
    expect(previousButton).toBeDisabled();
  });

  it('should disable next button on last page', () => {
    render(
      <UserTable
        users={mockUsers}
        pagination={{ page: 3, limit: 20, total: 50, totalPages: 3 }}
        onEdit={mockOnEdit}
        onPageChange={mockOnPageChange}
      />
    );

    const nextButton = screen.getByText('Próxima');
    expect(nextButton).toBeDisabled();
  });
});
