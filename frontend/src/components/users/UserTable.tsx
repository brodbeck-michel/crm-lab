import { Button } from '@/components/ui';
import { DateDisplay } from '@/components/shared';
import type { ManagedUser, PaginationMeta } from '@crm-lab/shared';

interface UserTableProps {
  users: ManagedUser[];
  pagination: PaginationMeta;
  onEdit: (userId: string) => void;
  onPageChange: (page: number) => void;
}

const ROLE_LABELS: Record<string, string> = {
  admin: 'Administrador',
  manager: 'Gestor',
  attendant: 'Atendente',
  platform_operator: 'Operador Plataforma',
};

export default function UserTable({ users, pagination, onEdit, onPageChange }: UserTableProps) {
  if (users.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-body-md text-neutral-500">Nenhum usuário encontrado</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-lg">
      <div className="overflow-x-auto border border-neutral-200 rounded-md">
        <table className="w-full">
          <thead>
            <tr className="border-b border-neutral-200 bg-neutral-50">
              <th className="px-lg py-md text-left text-body-sm font-semibold text-neutral-700">Email</th>
              <th className="px-lg py-md text-left text-body-sm font-semibold text-neutral-700">Nome</th>
              <th className="px-lg py-md text-left text-body-sm font-semibold text-neutral-700">Função</th>
              <th className="px-lg py-md text-left text-body-sm font-semibold text-neutral-700">Alçada</th>
              <th className="px-lg py-md text-left text-body-sm font-semibold text-neutral-700">Status</th>
              <th className="px-lg py-md text-left text-body-sm font-semibold text-neutral-700">Último acesso</th>
              <th className="px-lg py-md text-left text-body-sm font-semibold text-neutral-700">Criado em</th>
              <th className="px-lg py-md text-center text-body-sm font-semibold text-neutral-700">Ações</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className="border-b border-neutral-200 hover:bg-neutral-50 transition-colors">
                <td className="px-lg py-md text-body-sm text-neutral-900">{user.email}</td>
                <td className="px-lg py-md text-body-sm text-neutral-900">{user.name}</td>
                <td className="px-lg py-md text-body-sm text-neutral-900">
                  {ROLE_LABELS[user.role] || user.role}
                </td>
                <td className="px-lg py-md text-body-sm text-neutral-900">
                  {user.discountLimit}%
                </td>
                <td className={`px-lg py-md text-body-sm font-medium ${user.isActive ? 'text-positive-600' : 'text-attention-600'}`}>
                  {user.isActive ? 'Ativo' : 'Inativo'}
                </td>
                <td className="px-lg py-md text-body-sm text-neutral-900">
                  {user.lastLoginAt ? (
                    <DateDisplay value={user.lastLoginAt} variant="relative" />
                  ) : (
                    <span className="text-neutral-500">Nunca</span>
                  )}
                </td>
                <td className="px-lg py-md text-body-sm text-neutral-900">
                  <DateDisplay value={user.createdAt} variant="absolute" />
                </td>
                <td className="px-lg py-md text-center">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onEdit(user.id)}
                  >
                    Editar
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Paginação */}
      {pagination.totalPages > 1 && (
        <div className="flex justify-between items-center">
          <p className="text-body-sm text-neutral-600">
            Mostrando {users.length} de {pagination.total} usuários
          </p>
          <div className="flex gap-sm">
            <Button
              variant="secondary"
              size="sm"
              disabled={pagination.page === 1}
              onClick={() => onPageChange(pagination.page - 1)}
            >
              Anterior
            </Button>
            <span className="text-body-sm text-neutral-600 flex items-center">
              Página {pagination.page} de {pagination.totalPages}
            </span>
            <Button
              variant="secondary"
              size="sm"
              disabled={pagination.page === pagination.totalPages}
              onClick={() => onPageChange(pagination.page + 1)}
            >
              Próxima
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
