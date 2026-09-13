import type { ExamPackage } from '@crm-lab/shared';
import { DataTable, type DataTableColumn } from '@/components/shared/DataTable';
import { MoneyDisplay } from '@/components/shared/MoneyDisplay';
import { Button } from '@/components/ui';

interface PackageTableProps {
  packages: ExamPackage[];
  canEdit: boolean;
  /** Recebe o pacote INTEIRO — o modal de edição não precisa refazer o fetch. */
  onEdit?: (pkg: ExamPackage) => void;
}

export default function PackageTable({ packages, canEdit, onEdit }: PackageTableProps) {
  const baseColumns: Array<DataTableColumn<ExamPackage>> = [
    {
      key: 'name',
      header: 'Nome',
      render: (pkg) => pkg.name,
    },
    {
      key: 'items',
      header: 'Exames incluídos',
      render: (pkg) => pkg.items.map((item) => item.examName).join(', ') || '—',
    },
    {
      key: 'discountPercent',
      header: 'Desconto',
      align: 'right',
      render: (pkg) => `${pkg.discountPercent}%`,
    },
    {
      key: 'pricePrivate',
      header: 'Preço Particular',
      align: 'right',
      render: (pkg) => <MoneyDisplay value={pkg.pricePrivate} />,
    },
    {
      key: 'status',
      header: 'Status',
      render: (pkg) => (pkg.isActive ? 'Ativo' : 'Inativo'),
    },
  ];

  const columns = canEdit
    ? [
        ...baseColumns,
        {
          key: 'actions',
          header: 'Ações',
          render: (pkg: ExamPackage) => (
            <Button
              variant="secondary"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                onEdit?.(pkg);
              }}
            >
              Editar
            </Button>
          ),
        },
      ]
    : baseColumns;

  return <DataTable columns={columns} rows={packages} rowKey={(pkg) => pkg.id} minWidth={1000} />;
}
