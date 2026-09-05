import { Input } from '@/components/ui/Input';
import { SearchInput } from '@/components/ui';
import type { ListProposalsQuery } from '@crm-lab/shared';

interface ProposalsFiltersProps {
  filters: ListProposalsQuery;
  onChange: (filters: ListProposalsQuery) => void;
}

/**
 * `Input` é sempre `w-full` (COMPONENTS.md), então cada filtro precisa do
 * próprio contêiner com largura: sem isso os três empilham em largura total e
 * comem ~200px de altura — no Pipeline isso é altura de coluna do Kanban.
 */
export default function ProposalsFilters({ filters, onChange }: ProposalsFiltersProps) {
  return (
    <div className="flex items-end gap-md flex-wrap">
      <div className="w-72 max-w-full">
        <SearchInput
          defaultValue={filters.search || ''}
          placeholder="Buscar paciente"
          aria-label="Buscar paciente"
          onSearch={(term) => onChange({ ...filters, search: term })}
        />
      </div>
      <div className="w-44">
        <Input
          type="date"
          aria-label="Data inicial"
          value={filters.startDate || ''}
          onChange={(e) => onChange({ ...filters, startDate: e.target.value })}
        />
      </div>
      <div className="w-44">
        <Input
          type="date"
          aria-label="Data final"
          value={filters.endDate || ''}
          onChange={(e) => onChange({ ...filters, endDate: e.target.value })}
        />
      </div>
      <div className="w-56">
        <Input
          type="text"
          aria-label="ID do atendente"
          placeholder="ID do atendente"
          value={filters.createdBy || ''}
          onChange={(e) => onChange({ ...filters, createdBy: e.target.value })}
        />
      </div>
    </div>
  );
}
