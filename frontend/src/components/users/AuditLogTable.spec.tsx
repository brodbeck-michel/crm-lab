import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import AuditLogTable from './AuditLogTable';
import type { AuditEntry } from '@crm-lab/shared';

const mockAuditEntries: AuditEntry[] = [
  {
    id: 'audit-1',
    userId: '1',
    userName: 'Admin User',
    action: 'create_user',
    entityType: 'user',
    entityId: 'user-123',
    oldValues: null,
    newValues: { email: 'newuser@lab.com', role: 'attendant' },
    ipAddress: '192.168.1.1',
    timestamp: '2026-08-23T10:00:00Z',
  },
  {
    id: 'audit-2',
    userId: '1',
    userName: 'Admin User',
    action: 'update_user_permissions',
    entityType: 'user',
    entityId: 'user-456',
    oldValues: { role: 'attendant', discountLimit: 15 },
    newValues: { role: 'manager', discountLimit: 30 },
    ipAddress: '192.168.1.1',
    timestamp: '2026-08-22T14:30:00Z',
  },
  {
    id: 'audit-3',
    userId: null,
    userName: null,
    action: 'login',
    entityType: 'user',
    entityId: 'user-789',
    oldValues: null,
    newValues: null,
    ipAddress: '10.0.0.1',
    timestamp: '2026-08-23T09:15:00Z',
  },
];

describe('AuditLogTable', () => {
  const mockOnPageChange = vi.fn();

  const renderComponent = (entries = mockAuditEntries) => {
    return render(
      <AuditLogTable
        entries={entries}
        pagination={{ page: 1, limit: 20, total: 3, totalPages: 1 }}
        onPageChange={mockOnPageChange}
      />
    );
  };

  it('should render table with audit entries', () => {
    renderComponent();

    // Check headers
    expect(screen.getByRole('columnheader', { name: 'Data/Hora' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Ação' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Alterações' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'IP' })).toBeInTheDocument();
  });

  it('should display action labels correctly', () => {
    renderComponent();

    expect(screen.getByText('Criar Usuário')).toBeInTheDocument();
    expect(screen.getByText('Atualizar Permissões')).toBeInTheDocument();
    expect(screen.getByText('Login')).toBeInTheDocument();
  });

  it('should display user names', () => {
    renderComponent();

    const adminUserCells = screen.getAllByText('Admin User');
    expect(adminUserCells.length).toBeGreaterThan(0);
  });

  it('should display IP addresses', () => {
    renderComponent();

    const ipCells = screen.getAllByText('192.168.1.1');
    expect(ipCells.length).toBeGreaterThan(0);
  });

  it('should show entity IDs', () => {
    renderComponent();

    expect(screen.getByText('user-123')).toBeInTheDocument();
    expect(screen.getByText('user-456')).toBeInTheDocument();
  });

  it('should display old and new values when available', () => {
    renderComponent();

    // Check for some entries showing old/new values
    const updateEntry = screen.getByText('Atualizar Permissões');
    expect(updateEntry).toBeInTheDocument();
  });

  it('should show empty state when no entries', () => {
    render(
      <AuditLogTable
        entries={[]}
        pagination={{ page: 1, limit: 20, total: 0, totalPages: 0 }}
        onPageChange={mockOnPageChange}
      />
    );

    expect(screen.getByText('Nenhuma entrada de auditoria encontrada')).toBeInTheDocument();
  });

  it('should show pagination when multiple pages', () => {
    render(
      <AuditLogTable
        entries={mockAuditEntries}
        pagination={{ page: 1, limit: 20, total: 100, totalPages: 5 }}
        onPageChange={mockOnPageChange}
      />
    );

    expect(screen.getByText('Mostrando 3 de 100 entradas')).toBeInTheDocument();
    expect(screen.getByText('Página 1 de 5')).toBeInTheDocument();
  });

  it('should disable previous button on first page', () => {
    render(
      <AuditLogTable
        entries={mockAuditEntries}
        pagination={{ page: 1, limit: 20, total: 100, totalPages: 5 }}
        onPageChange={mockOnPageChange}
      />
    );

    const previousButton = screen.getByText('Anterior');
    expect(previousButton).toBeDisabled();
  });

  it('should disable next button on last page', () => {
    render(
      <AuditLogTable
        entries={mockAuditEntries}
        pagination={{ page: 5, limit: 20, total: 100, totalPages: 5 }}
        onPageChange={mockOnPageChange}
      />
    );

    const nextButton = screen.getByText('Próxima');
    expect(nextButton).toBeDisabled();
  });

  it('should call onPageChange with correct page number', () => {
    render(
      <AuditLogTable
        entries={mockAuditEntries}
        pagination={{ page: 1, limit: 20, total: 100, totalPages: 5 }}
        onPageChange={mockOnPageChange}
      />
    );

    const nextButton = screen.getByText('Próxima');
    nextButton.click();

    expect(mockOnPageChange).toHaveBeenCalledWith(2);
  });
});
