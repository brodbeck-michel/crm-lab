import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  USER_ROLE_LABELS,
  type DoctorPortfolioCounts,
  type ListDoctorsQuery,
  type TransferDoctorsResponse,
} from '@crm-lab/shared';
import { doctorsApi } from '@/api/doctors';
import { queryKeys, queryScopes } from '@/api/query-keys';
import { useApiErrorHandler } from '@/hooks';
import { PageContainer, PageHeader } from '@/components/layout';
import { EmptyState, Modal } from '@/components/shared';
import { Button, Chip, Select, cn, useToast } from '@/components/ui';
import { crmLabel } from './Doctors';
import { useVisitationResponsibles, type VisitationPerson } from './visitation-access';

/** Teto da lista de médicos de uma carteira (o mesmo de `GET /doctors`). */
const DOCTORS_LIMIT = 100;

/** Linha clicável: uma carteira ou o balde "sem responsável". */
type Selection = { kind: 'owner'; id: string; name: string } | { kind: 'unassigned' };

function countsLabel(counts: DoctorPortfolioCounts): string {
  const total = counts.doctorCount === 1 ? '1 médico' : `${counts.doctorCount} médicos`;
  return `${total} · ${counts.activeDoctorCount} ativos`;
}

/** Corte A/B/C — só quando o servidor mandar (CRMLAB-188 integrado). */
function abcLabel(counts: DoctorPortfolioCounts): string | null {
  if (!counts.abc) return null;
  const { A, B, C, unclassified } = counts.abc;
  return `A ${A} · B ${B} · C ${C}${unclassified > 0 ? ` · sem classe ${unclassified}` : ''}`;
}

function transferMessage(result: TransferDoctorsResponse): string {
  const doctors = result.transferredDoctors === 1 ? '1 médico transferido' : `${result.transferredDoctors} médicos transferidos`;
  if (result.movedVisits === 0) return doctors;
  return `${doctors} (${result.movedVisits === 1 ? '1 visita' : `${result.movedVisits} visitas`})`;
}

/**
 * Carteiras — `/visitation/portfolios` (PAGES.md §22c · API_CONTRACTS.md §13 ·
 * CRMLAB-189, D-329). Só gestor/admin (a rota e o servidor recusam os demais).
 * Cada responsável com o total de médicos; clicar mostra os médicos da carteira,
 * com seleção para a transferência em lote.
 */
export default function Portfolios() {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [transferring, setTransferring] = useState(false);

  const portfoliosQuery = useQuery({
    queryKey: queryKeys.doctorPortfolios(),
    queryFn: () => doctorsApi.portfolios(),
  });

  const doctorFilters = useMemo<ListDoctorsQuery | null>(() => {
    if (!selection) return null;
    const base = { limit: DOCTORS_LIMIT, sortBy: 'name' as const };
    return selection.kind === 'unassigned' ? { ...base, unassigned: true } : { ...base, responsibleId: selection.id };
  }, [selection]);

  const doctorsQuery = useQuery({
    queryKey: queryKeys.doctors(doctorFilters ?? {}),
    queryFn: () => doctorsApi.list(doctorFilters ?? {}),
    enabled: doctorFilters !== null,
  });
  const doctors = doctorsQuery.data?.doctors ?? [];

  function select(next: Selection) {
    setSelection(next);
    setChecked(new Set());
  }

  function toggle(id: string) {
    setChecked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const allChecked = doctors.length > 0 && doctors.every((doctor) => checked.has(doctor.id));
  const portfolios = portfoliosQuery.data?.portfolios ?? [];
  const unassigned = portfoliosQuery.data?.unassigned;
  const isSelected = (candidate: Selection) =>
    selection !== null &&
    selection.kind === candidate.kind &&
    (candidate.kind === 'unassigned' || (selection.kind === 'owner' && selection.id === candidate.id));

  const rowClass = (on: boolean) =>
    cn(
      'flex w-full items-center justify-between gap-md rounded-md border px-lg py-md text-left transition-colors',
      'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
      on ? 'border-accent bg-neutral-100' : 'border-neutral-200 bg-surface hover:bg-neutral-100',
    );

  return (
    <PageContainer>
      <PageHeader
        title="Carteiras"
        description="Médicos de cada representante. Selecione médicos para transferir de carteira."
      />

      <div className="grid grid-cols-1 gap-lg lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <section aria-label="Carteiras" className="flex flex-col gap-sm">
          {portfoliosQuery.isLoading ? (
            <p className="font-body text-body text-neutral-600">Carregando carteiras...</p>
          ) : portfoliosQuery.isError ? (
            <EmptyState message="Não foi possível carregar as carteiras" hint="Verifique a conexão e tente novamente." />
          ) : (
            <ul className="flex flex-col gap-sm" data-testid="portfolio-list">
              {portfolios.map((portfolio) => {
                const candidate: Selection = {
                  kind: 'owner',
                  id: portfolio.responsible.id,
                  name: portfolio.responsible.name,
                };
                const abc = abcLabel(portfolio);
                return (
                  <li key={portfolio.responsible.id}>
                    <button type="button" className={rowClass(isSelected(candidate))} onClick={() => select(candidate)}>
                      <span className="min-w-0">
                        <span className="block truncate font-semibold text-text">{portfolio.responsible.name}</span>
                        <span className="block text-caption text-neutral-600">
                          {USER_ROLE_LABELS[portfolio.responsible.role]}
                          {abc ? ` · ${abc}` : ''}
                        </span>
                      </span>
                      <span className="whitespace-nowrap text-caption tabular-nums text-text">{countsLabel(portfolio)}</span>
                    </button>
                  </li>
                );
              })}
              {unassigned && (
                <li>
                  <button
                    type="button"
                    className={rowClass(isSelected({ kind: 'unassigned' }))}
                    onClick={() => select({ kind: 'unassigned' })}
                  >
                    <span className="min-w-0">
                      <span className="block font-semibold text-text">Sem responsável / responsável inelegível</span>
                      <span className="block text-caption text-neutral-600">Atribua um responsável a estes médicos</span>
                    </span>
                    <span className="whitespace-nowrap text-caption tabular-nums text-text">{countsLabel(unassigned)}</span>
                  </button>
                </li>
              )}
            </ul>
          )}
        </section>

        <section aria-label="Médicos da carteira" className="flex flex-col gap-md">
          {!selection ? (
            <EmptyState message="Escolha uma carteira" hint="Os médicos do responsável aparecem aqui." />
          ) : doctorsQuery.isLoading ? (
            <p className="font-body text-body text-neutral-600">Carregando médicos...</p>
          ) : doctorsQuery.isError ? (
            <EmptyState message="Não foi possível carregar os médicos" hint="Verifique a conexão e tente novamente." />
          ) : doctors.length === 0 ? (
            <EmptyState message="Nenhum médico nesta carteira" />
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-md">
                <label className="flex items-center gap-sm text-body text-text">
                  <input
                    type="checkbox"
                    className="accent-accent"
                    checked={allChecked}
                    onChange={() =>
                      setChecked(allChecked ? new Set() : new Set(doctors.map((doctor) => doctor.id)))
                    }
                  />
                  Selecionar todos
                </label>
                <Button variant="primary" disabled={checked.size === 0} onClick={() => setTransferring(true)}>
                  Transferir selecionados{checked.size > 0 ? ` (${checked.size})` : ''}
                </Button>
              </div>
              <ul className="flex flex-col gap-sm" data-testid="portfolio-doctors">
                {doctors.map((doctor) => (
                  <li
                    key={doctor.id}
                    className="flex items-center gap-md rounded-md border border-neutral-200 bg-surface px-lg py-md"
                  >
                    <input
                      type="checkbox"
                      className="accent-accent"
                      aria-label={`Selecionar ${doctor.name}`}
                      checked={checked.has(doctor.id)}
                      onChange={() => toggle(doctor.id)}
                    />
                    <div className="min-w-0 flex-1">
                      <Link
                        to={`/visitation/doctors/${doctor.id}`}
                        className="block truncate font-semibold text-text hover:underline"
                      >
                        {doctor.name}
                      </Link>
                      <div className="truncate text-caption text-neutral-600">
                        {[doctor.crm ? `CRM ${crmLabel(doctor)}` : null, doctor.specialty, doctor.clinic]
                          .filter(Boolean)
                          .join(' · ') || '—'}
                        {selection.kind === 'unassigned' && doctor.responsible ? ` · ${doctor.responsible.name}` : ''}
                      </div>
                    </div>
                    {!doctor.isActive && <Chip tone="inactive">Inativo</Chip>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      </div>

      {transferring && selection && (
        <TransferModal
          doctorIds={[...checked]}
          currentOwnerId={selection.kind === 'owner' ? selection.id : null}
          onClose={() => setTransferring(false)}
          onDone={() => {
            setTransferring(false);
            setChecked(new Set());
          }}
        />
      )}
    </PageContainer>
  );
}

interface TransferModalProps {
  doctorIds: string[];
  /** Dono atual (sai da lista de destinos). `null` = balde "sem responsável". */
  currentOwnerId: string | null;
  onClose: () => void;
  onDone: () => void;
}

function TransferModal({ doctorIds, currentOwnerId, onClose, onDone }: TransferModalProps) {
  const queryClient = useQueryClient();
  const handleApiError = useApiErrorHandler();
  const { toast } = useToast();
  const { responsibles } = useVisitationResponsibles();
  const [toUserId, setToUserId] = useState('');
  const [includeFutureVisits, setIncludeFutureVisits] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const targets: VisitationPerson[] = responsibles.filter((person) => person.id !== currentOwnerId);

  const transfer = useMutation({
    mutationFn: () => doctorsApi.transfer({ doctorIds, toUserId, includeFutureVisits }),
    onSuccess: (result) => {
      toast(transferMessage(result), { tone: 'positive' });
      // Carteiras, listas e fichas caem juntas (escopo `doctors`); a agenda também muda.
      void queryClient.invalidateQueries({ queryKey: queryScopes.doctors });
      void queryClient.invalidateQueries({ queryKey: queryScopes.visits });
      onDone();
    },
    onError: handleApiError,
  });

  function submit() {
    if (!toUserId) {
      setError('Escolha o novo responsável');
      return;
    }
    transfer.mutate();
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Transferir médicos"
      footer={
        <div className="ml-auto flex gap-md">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={submit} loading={transfer.isPending}>
            Transferir
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-md">
        <p className="text-body text-text">
          {doctorIds.length === 1 ? '1 médico selecionado.' : `${doctorIds.length} médicos selecionados.`}
        </p>
        <Select
          label="Novo responsável"
          value={toUserId}
          onChange={(event) => {
            setToUserId(event.target.value);
            setError(undefined);
          }}
          placeholder="Selecione o responsável"
          options={targets.map((person) => ({ value: person.id, label: person.name }))}
          error={error}
        />
        <label className="flex items-start gap-sm text-body text-text">
          <input
            type="checkbox"
            className="mt-xs accent-accent"
            checked={includeFutureVisits}
            onChange={(event) => setIncludeFutureVisits(event.target.checked)}
          />
          <span>
            Levar junto as visitas futuras agendadas
            <span className="block text-caption text-neutral-600">
              Só as que estavam com o responsável anterior; visitas de cobertura ficam como estão.
            </span>
          </span>
        </label>
      </div>
    </Modal>
  );
}
