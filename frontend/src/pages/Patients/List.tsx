import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import type { ListPatientsQuery, PatientListItem } from '@crm-lab/shared';
import { patientsApi } from '@/api/patients';
import { queryKeys, staleTimes } from '@/api/query-keys';
import { PageContainer, PageHeader } from '@/components/layout';
import { DataTable, DateDisplay, EmptyState, Pagination } from '@/components/shared';
import type { DataTableColumn } from '@/components/shared';
import { Chip, SearchInput } from '@/components/ui';

const PAGE_SIZE = 20;

/** Só cosmético: exibe `00011122233` como `000.111.222-33`. Cru quando não tem 11 dígitos. */
function formatDocument(document: string | null): string {
  if (!document || document.length !== 11) return document ?? '—';
  return `${document.slice(0, 3)}.${document.slice(3, 6)}.${document.slice(6, 9)}-${document.slice(9)}`;
}

/**
 * Busca de Pacientes — `/patients` (PAGES.md §2a, API_CONTRACTS.md §2c).
 *
 * Um único campo de busca casa nome, CPF e telefone (o servidor já faz o OR
 * dentro de `?search=`, D-060) — não existe filtro AND por campo no
 * contrato, então três caixas separadas não achariam nada que esta não ache.
 */
export function PatientsList() {
  const navigate = useNavigate();
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [includeInactive, setIncludeInactive] = useState(false);

  const filters = useMemo<ListPatientsQuery>(
    () => ({
      page,
      limit: PAGE_SIZE,
      ...(search.trim().length > 0 ? { search: search.trim() } : {}),
      ...(includeInactive ? { includeInactive: true } : {}),
    }),
    [page, search, includeInactive],
  );

  const patientsQuery = useQuery({
    queryKey: queryKeys.patients(filters),
    queryFn: () => patientsApi.list(filters),
    staleTime: staleTimes.patients,
  });

  const columns = useMemo<Array<DataTableColumn<PatientListItem>>>(
    () => [
      {
        key: 'name',
        header: 'Nome',
        minWidth: 220,
        render: (patient) => (
          <span className="truncate font-semibold text-text">
            {patient.name ?? 'Sem nome cadastrado'}
          </span>
        ),
      },
      {
        key: 'phone',
        header: 'Telefone',
        render: (patient) => <span className="whitespace-nowrap tabular-nums">{patient.phone}</span>,
      },
      {
        key: 'document',
        header: 'CPF',
        render: (patient) => (
          <span className="whitespace-nowrap tabular-nums">{formatDocument(patient.document)}</span>
        ),
      },
      {
        key: 'lastInteractionAt',
        header: 'Última interação',
        align: 'right',
        render: (patient) =>
          patient.lastInteractionAt ? (
            <DateDisplay value={patient.lastInteractionAt} />
          ) : (
            <span className="text-neutral-600">—</span>
          ),
      },
      {
        key: 'status',
        header: 'Status',
        render: (patient) =>
          patient.inactivatedAt !== null ? (
            <Chip tone="attention">Inativo</Chip>
          ) : (
            <Chip tone="positive">Ativo</Chip>
          ),
      },
    ],
    [],
  );

  const pagination = patientsQuery.data?.pagination;

  return (
    <PageContainer>
      <PageHeader
        title="Pacientes"
        description="Busque um paciente por nome, CPF ou telefone."
      />

      <div className="flex flex-wrap items-center gap-md">
        <div className="max-w-md flex-1">
          <SearchInput
            placeholder="Buscar por nome, CPF ou telefone"
            aria-label="Buscar paciente"
            onSearch={(term) => {
              setSearch(term);
              setPage(1);
            }}
          />
        </div>

        <label className="flex cursor-pointer items-center gap-xs font-body text-caption text-text">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(event) => {
              setIncludeInactive(event.target.checked);
              setPage(1);
            }}
          />
          Mostrar inativos
        </label>
      </div>

      {patientsQuery.isLoading ? (
        <p className="font-body text-body text-neutral-600">Carregando pacientes...</p>
      ) : patientsQuery.isError ? (
        <EmptyState
          message="Não foi possível carregar os pacientes"
          hint="Verifique a conexão e tente novamente."
        />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={patientsQuery.data?.patients ?? []}
            rowKey={(patient) => patient.id}
            emptyMessage="Nenhum paciente encontrado"
            onRowClick={(patient) => navigate(`/patients/${patient.id}`)}
          />

          {pagination && <Pagination pagination={pagination} onPageChange={setPage} itemLabel="pacientes" />}
        </>
      )}
    </PageContainer>
  );
}

export default PatientsList;
