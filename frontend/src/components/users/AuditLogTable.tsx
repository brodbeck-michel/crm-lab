import { DateDisplay } from '@/components/shared';
import { Button } from '@/components/ui';
import type { AuditEntry, PaginationMeta } from '@crm-lab/shared';

interface AuditLogTableProps {
  entries: AuditEntry[];
  pagination: PaginationMeta;
  onPageChange: (page: number) => void;
}

const ACTION_LABELS: Record<string, string> = {
  login: 'Login',
  logout: 'Logout',
  create_user: 'Criar Usuário',
  update_user_permissions: 'Atualizar Permissões',
  update_theme: 'Atualizar Tema',
  refresh_token_reuse_detected: 'Reutilização de Token Detectada',
};

const ENTITY_TYPE_LABELS: Record<string, string> = {
  user: 'Usuário',
  proposal: 'Proposta',
  conversation: 'Conversa',
  theme: 'Tema',
};

export default function AuditLogTable({ entries, pagination, onPageChange }: AuditLogTableProps) {
  if (entries.length === 0) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-label text-neutral-600">Nenhuma entrada de auditoria encontrada</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-lg">
      <div className="overflow-x-auto border border-neutral-200 rounded-md bg-neutral-100">
        <table className="w-full">
          <thead>
            <tr className="border-b border-neutral-300">
              <th className="px-lg py-md text-left text-micro font-semibold uppercase text-neutral-600">Data/Hora</th>
              <th className="px-lg py-md text-left text-micro font-semibold uppercase text-neutral-600">Usuário</th>
              <th className="px-lg py-md text-left text-micro font-semibold uppercase text-neutral-600">Ação</th>
              <th className="px-lg py-md text-left text-micro font-semibold uppercase text-neutral-600">Entidade</th>
              <th className="px-lg py-md text-left text-micro font-semibold uppercase text-neutral-600">Alterações</th>
              <th className="px-lg py-md text-left text-micro font-semibold uppercase text-neutral-600">IP</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id} className="border-b border-neutral-200 hover:bg-accent-100 transition-colors">
                <td className="px-lg py-md text-body text-neutral-900">
                  <DateDisplay value={entry.timestamp} variant="relative" />
                </td>
                <td className="px-lg py-md text-body text-neutral-900">
                  {entry.userName || '-'}
                </td>
                <td className="px-lg py-md text-body text-neutral-900">
                  {ACTION_LABELS[entry.action] || entry.action}
                </td>
                <td className="px-lg py-md text-body text-neutral-900">
                  <div className="flex flex-col gap-xs">
                    <span>{ENTITY_TYPE_LABELS[entry.entityType] || entry.entityType}</span>
                    <span className="text-caption text-neutral-600 font-mono">{entry.entityId}</span>
                  </div>
                </td>
                <td className="px-lg py-md text-body text-neutral-900">
                  {entry.oldValues || entry.newValues ? (
                    <div className="space-y-xs max-w-xs">
                      {entry.oldValues && (
                        <div className="text-neutral-600">
                          <span className="font-medium">Anterior:</span>
                          <pre className="text-caption bg-neutral-200 p-xs rounded-sm mt-xs overflow-auto max-h-24">
                            {JSON.stringify(entry.oldValues, null, 2)}
                          </pre>
                        </div>
                      )}
                      {entry.newValues && (
                        <div className="text-neutral-600">
                          <span className="font-medium">Novo:</span>
                          <pre className="text-caption bg-neutral-200 p-xs rounded-sm mt-xs overflow-auto max-h-24">
                            {JSON.stringify(entry.newValues, null, 2)}
                          </pre>
                        </div>
                      )}
                    </div>
                  ) : (
                    <span className="text-neutral-500">-</span>
                  )}
                </td>
                <td className="px-lg py-md text-body text-neutral-600 font-mono">
                  {entry.ipAddress || '-'}
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
            Mostrando {entries.length} de {pagination.total} entradas
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
