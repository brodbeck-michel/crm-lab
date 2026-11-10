import { useState } from 'react';
import { useUserList, useAuditList, usePresenceOf } from '@/api';
import UserTable from '@/components/users/UserTable';
import UserModal from '@/components/users/UserModal';
import AuditLogTable from '@/components/users/AuditLogTable';
import { PageContainer } from '@/components/layout/PageContainer';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button, SegmentedControl } from '@/components/ui';
import type { ManagedUser, PaginationQuery } from '@crm-lab/shared';

type Tab = 'users' | 'audit';

export default function UsersSettings() {
  const [tab, setTab] = useState<Tab>('users');
  const [showModal, setShowModal] = useState(false);
  const [editUser, setEditUser] = useState<ManagedUser | undefined>();
  const [filters, setFilters] = useState<PaginationQuery>({
    page: 1,
    limit: 20,
  });

  // CRMLAB-120 (D-286): bolinha de status ao lado do nome.
  const presenceOf = usePresenceOf();
  const { data: usersData = { users: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } }, isLoading: usersLoading } = useUserList(filters);
  const { data: auditData = { entries: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } }, isLoading: auditLoading } = useAuditList(tab === 'audit' ? filters : {});

  const handleEditClick = (user: ManagedUser) => {
    setEditUser(user);
    setShowModal(true);
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setEditUser(undefined);
  };

  const handlePageChange = (newPage: number) => {
    setFilters(prev => ({ ...prev, page: newPage }));
  };

  return (
    <PageContainer>
      <PageHeader
        title="Usuários & Permissões"
        description="Gerencie usuários, funções e permissões do laboratório."
        actions={
          tab === 'users' && (
            <Button variant="primary" onClick={() => setShowModal(true)}>
              + Novo Usuário
            </Button>
          )
        }
      />

      <div className="flex gap-md">
        <SegmentedControl
          aria-label="Visão"
          fullWidth={false}
          value={tab}
          onChange={(value) => {
            setTab(value as Tab);
            setFilters(prev => ({ ...prev, page: 1 }));
          }}
          options={[
            { value: 'users', label: 'Usuários' },
            { value: 'audit', label: 'Log de Auditoria' },
          ]}
        />
      </div>

      <div className="flex-1 overflow-auto">
        {tab === 'users' ? (
          <>
            {usersLoading ? (
              <div className="flex items-center justify-center h-full">Carregando...</div>
            ) : (
              <UserTable
                users={usersData.users}
                pagination={usersData.pagination}
                onEdit={handleEditClick}
                onPageChange={handlePageChange}
                presenceOf={presenceOf}
              />
            )}
          </>
        ) : (
          <>
            {auditLoading ? (
              <div className="flex items-center justify-center h-full">Carregando...</div>
            ) : (
              <AuditLogTable
                entries={auditData.entries}
                pagination={auditData.pagination}
                onPageChange={handlePageChange}
              />
            )}
          </>
        )}
      </div>

      {showModal && (
        <UserModal
          user={editUser}
          onClose={handleCloseModal}
        />
      )}
    </PageContainer>
  );
}
