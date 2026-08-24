import { useState } from 'react';
import { useUserList, useAuditList } from '@/api';
import UserTable from '@/components/users/UserTable';
import UserModal from '@/components/users/UserModal';
import AuditLogTable from '@/components/users/AuditLogTable';
import { Button, SegmentedControl } from '@/components/ui';
import type { PaginationQuery } from '@crm-lab/shared';

type Tab = 'users' | 'audit';

export default function UsersSettings() {
  const [tab, setTab] = useState<Tab>('users');
  const [showModal, setShowModal] = useState(false);
  const [editUserId, setEditUserId] = useState<string | undefined>();
  const [filters, setFilters] = useState<PaginationQuery>({
    page: 1,
    limit: 20,
  });

  const { data: usersData = { users: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } }, isLoading: usersLoading } = useUserList(filters);
  const { data: auditData = { entries: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } }, isLoading: auditLoading } = useAuditList(tab === 'audit' ? filters : {});

  const handleEditClick = (userId: string) => {
    setEditUserId(userId);
    setShowModal(true);
  };

  const handleCloseModal = () => {
    setShowModal(false);
    setEditUserId(undefined);
  };

  const handlePageChange = (newPage: number) => {
    setFilters(prev => ({ ...prev, page: newPage }));
  };

  return (
    <div className="flex flex-col gap-lg p-lg h-full">
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-heading-32">Usuários & Permissões</h1>
          <p className="text-body-md text-neutral-600 mt-sm">
            Gerencie usuários, funções e permissões do laboratório
          </p>
        </div>
        {tab === 'users' && (
          <Button variant="primary" onClick={() => setShowModal(true)}>
            + Novo Usuário
          </Button>
        )}
      </div>

      <div className="flex gap-md">
        <SegmentedControl
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
          userId={editUserId}
          onClose={handleCloseModal}
        />
      )}
    </div>
  );
}
