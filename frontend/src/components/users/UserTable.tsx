import { Button, Chip } from '@/components/ui';
import { DateDisplay } from '@/components/shared';
import type { ManagedUser, PaginationMeta } from '@crm-lab/shared';

interface UserTableProps {
  users: ManagedUser[];
  pagination: PaginationMeta;
  /** Recebe o usuário INTEIRO — o modal de edição não precisa refazer o fetch. */
  onEdit: (user: ManagedUser) => void;
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
        <p className="text-label text-neutral-600">Nenhum usuário encontrado</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-lg">
      <div className="overflow-x-auto border border-neutral-200 rounded-md bg-neutral-100">
        <table className="w-full">
          <thead>
            <tr className="border-b border-neutral-300">
              <th className="px-lg py-md text-left text-micro font-semibold uppercase text-neutral-600">Email</th>
              <th className="px-lg py-md text-left text-micro font-semibold uppercase text-neutral-600">Nome</th>
              <th className="px-lg py-md text-left text-micro font-semibold uppercase text-neutral-600">Função</th>
              <th className="px-lg py-md text-left text-micro font-semibold uppercase text-neutral-600">Alçada</th>
              <th className="px-lg py-md text-left text-micro font-semibold uppercase text-neutral-600">Status</th>
              <th className="px-lg py-md text-left text-micro font-semibold uppercase text-neutral-600">Último acesso</th>
              <th className="px-lg py-md text-left text-micro font-semibold uppercase text-neutral-600">Criado em</th>
              <th className="px-lg py-md text-center text-micro font-semibold uppercase text-neutral-600">Ações</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} className="border-b border-neutral-200 hover:bg-accent-100 transition-colors">
                <td className="px-lg py-md text-body text-neutral-900">{user.email}</td>
                <td className="px-lg py-md text-body text-neutral-900">{user.name}</td>
                <td className="px-lg py-md text-body text-neutral-900">
                  {ROLE_LABELS[user.role] || user.role}
                </td>
                <td className="px-lg py-md text-body text-neutral-900">
                  {user.discountLimit}%
                </td>
                {/* Ativo/Inativo é ESTADO, não texto colorido: o primitivo Chip
                    já carrega os pares accent-2-200/800 e accent-200/800 do
                    DESIGN_TOKENS — `text-positive-600` nunca existiu no tema e
                    deixava a coluna sem distinção nenhuma. */}
                <td className="px-lg py-md">
                  <Chip tone={user.isActive ? 'positive' : 'attention'}>
                    {user.isActive ? 'Ativo' : 'Inativo'}
                  </Chip>
                </td>
                <td className="px-lg py-md text-body text-neutral-900">
                  {user.lastLoginAt ? (
                    <DateDisplay value={user.lastLoginAt} variant="relative" />
                  ) : (
                    <span className="text-neutral-500">Nunca</span>
                  )}
                </td>
                <td className="px-lg py-md text-body text-neutral-900">
                  <DateDisplay value={user.createdAt} variant="absolute" />
                </td>
                <td className="px-lg py-md text-center">
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => onEdit(user)}
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
          <p className="text-caption text-neutral-600">
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
            <span className="text-caption text-neutral-600 flex items-center">
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
