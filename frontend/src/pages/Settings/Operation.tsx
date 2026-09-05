import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type {
  ConversationChannel,
  PendingDecisionItem,
  QueueItem,
  QueueReason,
  UserRole,
  WorkloadRow,
} from '@crm-lab/shared';
import { useQuery } from '@tanstack/react-query';
import { operationApi, queryKeys, staleTimes } from '@/api';
import { PageContainer, PageHeader } from '@/components/layout';
import { DataTable, EmptyState, MoneyDisplay } from '@/components/shared';
import type { DataTableColumn } from '@/components/shared';
import { Button, Chip } from '@/components/ui';
import { useAuthStore, useUIStore } from '@/stores';
import { formatCount, formatDurationSeconds, formatRelativeDate } from '@/lib/format';

/**
 * Gestão da Operação — `/settings/operation`
 * (PAGES.md §10 · API_CONTRACTS.md §7 · D-067).
 *
 * SOMENTE LEITURA, gestor+. Nada aqui é digitado: fila, carga e decisões
 * pendentes são derivadas de `conversations` + `proposals` no servidor, num
 * ÚNICO endpoint — os três blocos são o retrato do MESMO instante. Por isso a
 * tela mostra "atualizado há X" a partir de `generatedAt`: quem lê precisa
 * saber de quando é o retrato inteiro, não de cada bloco.
 *
 * Todo tempo chega em SEGUNDOS já calculados em UTC no SQL (D-021). A tela
 * apenas formata (`formatDurationSeconds`) — nunca subtrai datas para obter uma
 * espera, porque em UTC-3 a subtração no cliente erraria por horas.
 *
 * O nome do paciente na fila é link para a Ficha (`/patients/:id`) quando
 * `QueueItem.patientId` existe (§7, D-079); quando é `null` vira texto puro.
 */

const CHANNEL_LABEL: Record<ConversationChannel, string> = {
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  web: 'Web',
  direct: 'Direto',
};

const REASON_LABEL: Record<QueueReason, string> = {
  unassigned: 'Sem atendente',
  waiting: 'Aguardando resposta',
};

const ROLE_LABEL: Record<UserRole, string> = {
  attendant: 'Atendente',
  manager: 'Gestor',
  admin: 'Administrador',
  platform_operator: 'Operador da plataforma',
};

interface TileProps {
  label: string;
  value: ReactNode;
  hint?: string;
}

function Tile({ label, value, hint }: TileProps) {
  return (
    <div className="flex flex-col gap-xs rounded-lg border border-neutral-200 bg-surface p-md">
      <span className="font-body text-caption text-neutral-600">{label}</span>
      <span className="font-heading text-metric text-text tabular-nums">{value}</span>
      {hint && <span className="font-body text-caption text-neutral-600">{hint}</span>}
    </div>
  );
}

interface SectionProps {
  title: string;
  description?: string;
  children: ReactNode;
}

function Section({ title, description, children }: SectionProps) {
  return (
    <section className="flex flex-col gap-md">
      <div className="flex flex-col gap-xs">
        <h2 className="m-0 font-heading text-section text-text">{title}</h2>
        {description && (
          <p className="m-0 font-body text-caption text-neutral-600">{description}</p>
        )}
      </div>
      {children}
    </section>
  );
}

export default function OperationSettings() {
  const role = useAuthStore((state) => state.user?.role);
  const canRead = role === 'manager' || role === 'admin';
  const navigate = useNavigate();
  const openModal = useUIStore((state) => state.openModal);

  /**
   * Ritmo de atualização (PAGES.md §10 — "sem cache no servidor: staleTime
   * curto e refetch ao focar a janela"):
   *  - `staleTime` 15s: dois cliques seguidos na aba não repetem uma agregação
   *    que varre `conversations` + `proposals` do laboratório inteiro;
   *  - `refetchInterval` 60s: um minuto é o horizonte em que uma espera muda
   *    de faixa ("12 min" → "13 min"). Mais rápido que isso multiplicaria a
   *    consulta sem mudar nenhuma decisão de quem lê a tela;
   *  - `refetchIntervalInBackground` fica no padrão (false): aba escondida não
   *    consulta;
   *  - `refetchOnWindowFocus`: voltar para a aba é exatamente quando o gestor
   *    olha — aí sim vale um retrato novo.
   */
  const overviewQuery = useQuery({
    queryKey: queryKeys.operationOverview({}),
    queryFn: () => operationApi.overview({}),
    // Guarda de papel SEM request: atendente e operador tomariam 403 (§7).
    enabled: canRead,
    staleTime: staleTimes.operation,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const overview = overviewQuery.data;

  const queueColumns = useMemo<Array<DataTableColumn<QueueItem>>>(
    () => [
      {
        key: 'patient',
        header: 'Paciente',
        minWidth: 200,
        render: (item) => (
          <div className="flex min-w-0 flex-col">
            {item.patientId === null ? (
              /*
               * Conversa anterior ao backfill da 003 (D-072): sem cadastro para
               * abrir. Vira texto puro — link para `/patients/null` daria 404 e
               * botão desabilitado não explicaria nada.
               */
              <span className="truncate font-semibold text-text">
                {item.patientName ?? 'Sem nome'}
              </span>
            ) : (
              <Link
                data-testid="queue-patient-link"
                to={`/patients/${item.patientId}`}
                /*
                 * A linha inteira leva ao Atendimento (`onRowClick`); este link
                 * leva à ficha. Sem o `stopPropagation` os dois disparariam e a
                 * navegação da linha venceria — o link nunca abriria.
                 */
                onClick={(event) => event.stopPropagation()}
                className="truncate font-semibold text-accent-700 no-underline hover:underline"
              >
                {item.patientName ?? 'Sem nome'}
              </Link>
            )}
            <span className="truncate text-caption text-neutral-600">
              {CHANNEL_LABEL[item.channel]}
            </span>
          </div>
        ),
      },
      {
        key: 'reason',
        header: 'Motivo',
        render: (item) => (
          <Chip tone={item.reason === 'unassigned' ? 'attention' : 'positive'}>
            {REASON_LABEL[item.reason]}
          </Chip>
        ),
      },
      {
        key: 'assignedTo',
        header: 'Atendente',
        render: (item) => (
          <span className={item.assignedToName ? 'text-text' : 'text-neutral-600'}>
            {item.assignedToName ?? 'Não atribuída'}
          </span>
        ),
      },
      {
        key: 'unreadCount',
        header: 'Não lidas',
        align: 'right',
        render: (item) => <span className="tabular-nums">{formatCount(item.unreadCount)}</span>,
      },
      {
        key: 'waitingSeconds',
        header: 'Esperando há',
        align: 'right',
        render: (item) => (
          <span className="whitespace-nowrap tabular-nums">
            {formatDurationSeconds(item.waitingSeconds)}
          </span>
        ),
      },
    ],
    [],
  );

  const workloadColumns = useMemo<Array<DataTableColumn<WorkloadRow>>>(
    () => [
      {
        key: 'name',
        header: 'Atendente',
        minWidth: 200,
        render: (row) => (
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-semibold text-text">{row.name}</span>
            <span className="truncate text-caption text-neutral-600">{ROLE_LABEL[row.role]}</span>
          </div>
        ),
      },
      {
        key: 'activeConversations',
        header: 'Conversas ativas',
        align: 'right',
        render: (row) => <span className="tabular-nums">{formatCount(row.activeConversations)}</span>,
      },
      {
        key: 'unreadMessages',
        header: 'Não lidas',
        align: 'right',
        render: (row) => <span className="tabular-nums">{formatCount(row.unreadMessages)}</span>,
      },
      {
        key: 'openProposals',
        header: 'Propostas em aberto',
        align: 'right',
        render: (row) => <span className="tabular-nums">{formatCount(row.openProposals)}</span>,
      },
      {
        key: 'pendingApprovals',
        header: 'Aprovações pendentes',
        align: 'right',
        render: (row) => <span className="tabular-nums">{formatCount(row.pendingApprovals)}</span>,
      },
    ],
    [],
  );

  if (!canRead) {
    return (
      <PageContainer>
        <PageHeader title="Gestão da Operação" />
        <EmptyState
          message="Acesso restrito a gestor e administrador"
          hint="A tela mostra a carga de todo o time do laboratório."
        />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        title="Gestão da Operação"
        description="Fila agora, carga por atendente e decisões pendentes — tudo derivado de conversas e propostas."
        actions={
          <div className="flex items-center gap-sm">
            {overview && (
              <span role="status" className="font-body text-caption text-neutral-600">
                Atualizado {formatRelativeDate(overview.generatedAt)}
              </span>
            )}
            <Button
              variant="secondary"
              size="sm"
              onClick={() => void overviewQuery.refetch()}
              loading={overviewQuery.isFetching}
            >
              Atualizar
            </Button>
          </div>
        }
      />

      {overviewQuery.isLoading ? (
        <p className="font-body text-body text-neutral-600">Carregando a operação...</p>
      ) : overviewQuery.isError ? (
        <EmptyState
          message="Não foi possível carregar a operação"
          hint="Verifique a conexão e tente novamente."
          action={
            <Button variant="secondary" onClick={() => void overviewQuery.refetch()}>
              Tentar novamente
            </Button>
          }
        />
      ) : overview ? (
        <>
          <Section
            title="Fila agora"
            description="Conversas ativas sem atendente ou com mensagem do paciente ainda não lida."
          >
            <div className="grid grid-cols-1 gap-md sm:grid-cols-3">
              <Tile
                label="Sem atendente"
                value={formatCount(overview.queue.unassigned)}
                hint="Conversas ativas sem ninguém responsável."
              />
              <Tile
                label="Aguardando resposta"
                value={formatCount(overview.queue.waiting)}
                hint="Atribuídas, com mensagem não lida."
              />
              <Tile
                label="Maior espera da fila"
                value={
                  overview.queue.oldestWaitSeconds === null
                    ? '—'
                    : formatDurationSeconds(overview.queue.oldestWaitSeconds)
                }
                /*
                 * O rótulo diz "da fila" porque `oldestWaitSeconds` é da fila
                 * INTEIRA (§7), não dos itens listados abaixo — chamá-lo de
                 * "maior espera da lista" seria mentira quando a fila passa do
                 * `queueLimit`.
                 */
                hint="Considera a fila inteira, não apenas os itens listados."
              />
            </div>

            <DataTable
              columns={queueColumns}
              rows={overview.queue.items}
              rowKey={(item) => item.conversationId}
              /*
               * O inbox ainda não abre uma conversa por parâmetro de URL;
               * o clique leva ao Atendimento com o id na query string
               * (pedido registrado ao Agent-UI-Attendance no relatório).
               */
              onRowClick={(item) => navigate(`/attendance?conversationId=${item.conversationId}`)}
              emptyMessage="Nenhuma conversa esperando — a fila está limpa"
              minWidth={820}
            />
          </Section>

          <Section
            title="Carga por atendente"
            description="Todo usuário ativo aparece, mesmo sem nenhuma conversa atribuída."
          >
            <DataTable
              columns={workloadColumns}
              rows={overview.workload}
              rowKey={(row) => row.userId}
              emptyMessage="Nenhum usuário ativo no laboratório"
              minWidth={820}
            />
          </Section>

          <Section
            title="Decisões pendentes"
            description="Propostas aguardando aprovação de alçada, da mais antiga para a mais recente."
          >
            {overview.pendingDecisions.items.length === 0 ? (
              <EmptyState
                message="Nenhuma decisão pendente"
                hint="Descontos acima da alçada aparecem aqui assim que forem pedidos."
              />
            ) : (
              <>
                <div className="grid grid-cols-1 gap-md sm:grid-cols-2">
                  {overview.pendingDecisions.items.map((item) => (
                    <PendingDecisionCard
                      key={item.proposalId}
                      item={item}
                      onOpen={() => openModal({ kind: 'proposal', id: item.proposalId })}
                    />
                  ))}
                </div>
                <p className="m-0 font-body text-caption text-neutral-600">
                  {formatCount(overview.pendingDecisions.total)} decisão(ões) pendente(s) no total.
                </p>
              </>
            )}
          </Section>
        </>
      ) : null}
    </PageContainer>
  );
}

export interface PendingDecisionCardProps {
  item: PendingDecisionItem;
  onOpen: () => void;
}

/**
 * Cartão clicável que abre o Modal da Proposta existente (PAGES.md §6), onde
 * [Aprovar]/[Rejeitar] já vivem. Esta tela NÃO reimplementa a decisão de
 * alçada: duplicar o botão duplicaria a regra. Reaproveitado por
 * `pages/Decisions.tsx` (PAGES.md §12) — mesmo cartão, mesma regra.
 */
export function PendingDecisionCard({ item, onOpen }: PendingDecisionCardProps) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Abrir proposta de ${item.patientName ?? 'paciente sem nome'}`}
      className="flex w-full flex-col gap-sm rounded-lg border border-neutral-200 bg-surface p-md text-left transition-colors hover:border-accent"
    >
      <div className="flex flex-wrap items-center justify-between gap-sm">
        <span className="font-semibold text-text">{item.patientName ?? 'Sem nome'}</span>
        <Chip tone="attention">{`${item.discountPercent}% de desconto`}</Chip>
      </div>
      <MoneyDisplay value={item.totalPrice} emphasis />
      <span className="font-body text-caption text-neutral-600">
        Pedida por {item.createdByName} · esperando há {formatDurationSeconds(item.waitingSeconds)}
      </span>
    </button>
  );
}
