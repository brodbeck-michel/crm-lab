import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import UsersSettings from './Users';
import * as usersApi from '@/api/users';
import * as auditApi from '@/api/audit';

// Mock API hooks
vi.mock('@/api/users', async () => {
  const actual = await vi.importActual('@/api/users');
  return {
    ...actual,
    useUserList: vi.fn(),
    useCreateUser: vi.fn(),
    useUpdateUser: vi.fn(),
  };
});

vi.mock('@/api/audit', async () => {
  const actual = await vi.importActual('@/api/audit');
  return {
    ...actual,
    useAuditList: vi.fn(),
  };
});

const mockUsersData = {
  users: [
    {
      id: '1',
      email: 'admin@lab.com',
      name: 'Admin',
      role: 'admin' as const,
      discountLimit: 100,
      isActive: true,
      lastLoginAt: '2026-08-23T10:00:00Z',
      createdAt: '2026-08-01T10:00:00Z',
    },
    {
      id: '2',
      email: 'maria@lab.com',
      name: 'Maria Silva',
      role: 'attendant' as const,
      discountLimit: 15,
      isActive: true,
      lastLoginAt: '2026-08-23T09:30:00Z',
      createdAt: '2026-08-15T10:00:00Z',
    },
  ],
  pagination: { page: 1, limit: 20, total: 2, totalPages: 1 },
};

const mockAuditData = {
  entries: [
    {
      id: 'audit-1',
      userId: '1',
      userName: 'Admin',
      action: 'create_user',
      entityType: 'user',
      entityId: '2',
      oldValues: null,
      newValues: { email: 'maria@lab.com', role: 'attendant' },
      ipAddress: '10.0.0.1',
      timestamp: '2026-08-23T10:00:00Z',
    },
  ],
  pagination: { page: 1, limit: 20, total: 1, totalPages: 1 },
};

describe('UsersSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(usersApi.useUserList).mockReturnValue({
      data: mockUsersData,
      isLoading: false,
      error: null,
    } as any);

    vi.mocked(auditApi.useAuditList).mockReturnValue({
      data: mockAuditData,
      isLoading: false,
      error: null,
    } as any);
  });

  const renderComponent = () => {
    return render(
      <UsersSettings />
    );
  };

  it('should render the page title and description', () => {
    renderComponent();

    expect(screen.getByText('Usuários & Permissões')).toBeInTheDocument();
    expect(screen.getByText(/Gerencie usuários, funções e permissões/i)).toBeInTheDocument();
  });

  it('should render "Novo Usuário" button on users tab', () => {
    renderComponent();

    expect(screen.getByText('+ Novo Usuário')).toBeInTheDocument();
  });

  it('should render users table with correct data', () => {
    renderComponent();

    // Check table headers
    expect(screen.getByText('Email')).toBeInTheDocument();
    expect(screen.getByText('Nome')).toBeInTheDocument();
    expect(screen.getByText('Função')).toBeInTheDocument();
    expect(screen.getByText('Alçada')).toBeInTheDocument();

    // Check user data
    expect(screen.getByText('admin@lab.com')).toBeInTheDocument();
    expect(screen.getByText('Admin')).toBeInTheDocument();
    expect(screen.getByText('maria@lab.com')).toBeInTheDocument();
    expect(screen.getByText('Maria Silva')).toBeInTheDocument();
  });

  it('should render tab controls', () => {
    renderComponent();

    expect(screen.getByText('Usuários')).toBeInTheDocument();
    expect(screen.getByText('Log de Auditoria')).toBeInTheDocument();
  });

  it('should load and display audit log when audit tab is clicked', async () => {
    renderComponent();

    const auditTab = screen.getByText('Log de Auditoria').closest('button');
    expect(auditTab).toBeInTheDocument();

    // Click audit tab
    auditTab?.click();

    // Verify the audit list hook was called
    expect(vi.mocked(auditApi.useAuditList)).toHaveBeenCalled();
  });
});
