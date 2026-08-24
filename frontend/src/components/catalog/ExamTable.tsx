import type { Exam } from '@crm-lab/shared';
import { DataTable, type DataTableColumn } from '@/components/shared/DataTable';
import { MoneyDisplay } from '@/components/shared/MoneyDisplay';
import { Button } from '@/components/ui';

interface ExamTableProps {
  exams: Exam[];
  canEdit: boolean;
  /** Recebe o exame INTEIRO — o modal de edição não precisa refazer o fetch. */
  onEdit?: (exam: Exam) => void;
}

export default function ExamTable({ exams, canEdit, onEdit }: ExamTableProps) {
  const baseColumns: Array<DataTableColumn<Exam>> = [
    {
      key: 'name',
      header: 'Nome',
      render: (exam) => exam.name,
    },
    {
      key: 'code',
      header: 'Código',
      render: (exam) => exam.code || '—',
    },
    {
      key: 'preparation',
      header: 'Preparo',
      render: (exam) => exam.preparation || '—',
    },
    {
      key: 'turnaroundHours',
      header: 'Prazo (h)',
      render: (exam) => exam.turnaroundHours || '—',
    },
    {
      key: 'pricePrivate',
      header: 'Preço Particular',
      align: 'right',
      render: (exam) => <MoneyDisplay value={exam.pricePrivate} />,
    },
    {
      key: 'priceInsurance',
      header: 'Preço Convênio',
      align: 'right',
      render: (exam) => <MoneyDisplay value={exam.priceInsurance} />,
    },
    {
      key: 'status',
      header: 'Status',
      render: (exam) => (exam.isActive ? 'Ativo' : 'Inativo'),
    },
  ];

  const columns = canEdit
    ? [
        ...baseColumns,
        {
          key: 'actions',
          header: 'Ações',
          render: (exam: Exam) => (
            <Button
              variant="secondary"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onEdit?.(exam);
              }}
            >
              Editar
            </Button>
          ),
        },
      ]
    : baseColumns;

  return (
    <DataTable
      columns={columns}
      rows={exams}
      rowKey={(exam) => exam.id}
      minWidth={900}
    />
  );
}
