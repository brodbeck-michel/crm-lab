import { Input } from '@/components/ui/Input';
import type { ListProposalsQuery } from '@crm-lab/shared';

interface ProposalsFiltersProps {
  filters: ListProposalsQuery;
  onChange: (filters: ListProposalsQuery) => void;
}

export default function ProposalsFilters({ filters, onChange }: ProposalsFiltersProps) {
  return (
    <div className="flex gap-md flex-wrap">
      <Input
        type="date"
        placeholder="Data inicial"
        value={filters.startDate || ''}
        onChange={(e) => onChange({ ...filters, startDate: e.target.value })}
      />
      <Input
        type="date"
        placeholder="Data final"
        value={filters.endDate || ''}
        onChange={(e) => onChange({ ...filters, endDate: e.target.value })}
      />
      <Input
        type="text"
        placeholder="ID do atendente"
        value={filters.createdBy || ''}
        onChange={(e) => onChange({ ...filters, createdBy: e.target.value })}
      />
    </div>
  );
}
