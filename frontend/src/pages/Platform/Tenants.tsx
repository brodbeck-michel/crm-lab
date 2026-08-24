import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreateTenantRequest,
  ListTenantsQuery,
  SubscriptionPlan,
  TenantSummary,
} from '@crm-lab/shared';
import { isApiError, platformApi, queryKeys, queryScopes } from '@/api';
import { PageContainer, PageHeader } from '@/components/layout';
import { DataTable, EmptyState, Modal } from '@/components/shared';
import type { DataTableColumn } from '@/components/shared';
import { Button, Chip, Input, SearchInput, Select } from '@/components/ui';
import { useAuthStore } from '@/stores';
import { formatIsoDay } from '@/lib/format';

/**
 * Laboratórios Clientes — `/platform/tenants` (PAGES.md §11,
 * API_CONTRACTS.md §5b "GET/POST /platform/tenants").
 *
 * Console ISOLADO: o operador vê CADASTRO e CONTAGEM (nome, slug, plano,
 * validade, usuários) e nada mais. Não há — e não deve passar a haver — coluna
 * com conversa, paciente ou valor de proposta de laboratório.
 *
 * O papel é verificado no servidor (`requireRoles('platform_operator')` +
 * `assertOperator` no service); a checagem daqui só evita pedir o que já se
 * sabe que será recusado — a UI esconde, o servidor recusa.
 */

const PAGE_SIZE = 20;

const PLAN_LABEL: Record<SubscriptionPlan, string> = {
  starter: 'Starter',
  pro: 'Pro',
  enterprise: 'Enterprise',
};

const PLAN_FILTER_OPTIONS = [
  { value: 'all', label: 'Todos os planos' },
  { value: 'starter', label: PLAN_LABEL.starter },
  { value: 'pro', label: PLAN_LABEL.pro },
  { value: 'enterprise', label: PLAN_LABEL.enterprise },
];

const STATUS_FILTER_OPTIONS = [
  { value: 'all', label: 'Ativos e inativos' },
  { value: 'true', label: 'Somente ativos' },
  { value: 'false', label: 'Somente inativos' },
];

const PLAN_FORM_OPTIONS = [
  { value: 'starter', label: PLAN_LABEL.starter },
  { value: 'pro', label: PLAN_LABEL.pro },
  { value: 'enterprise', label: PLAN_LABEL.enterprise },
];

function isPlan(value: string): value is SubscriptionPlan {
  return value === 'starter' || value === 'pro' || value === 'enterprise';
}

type FormField = keyof CreateTenantRequest;

const EMPTY_FORM: CreateTenantRequest = {
  name: '',
  slug: '',
  plan: 'starter',
  adminEmail: '',
  adminName: '',
  adminPassword: '',
};

/** `details.fields` (API_ERRORS.md) → `{ campo: motivo }`, sem `any`. */
function readFieldErrors(
  details: Record<string, unknown> | undefined,
): Partial<Record<FormField, string>> {
  const raw = details?.fields;
  if (typeof raw !== 'object' || raw === null) return {};
  const mapped: Partial<Record<FormField, string>> = {};
  for (const [field, reason] of Object.entries(raw as Record<string, unknown>)) {
    if (field in EMPTY_FORM) {
      mapped[field as FormField] = typeof reason === 'string' ? reason : String(reason);
    }
  }
  return mapped;
}

export function PlatformTenants() {
  const role = useAuthStore((state) => state.user?.role);
  const isOperator = role === 'platform_operator';

  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [planFilter, setPlanFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [modalOpen, setModalOpen] = useState(false);
  const closeModal = useCallback(() => setModalOpen(false), []);

  const filters = useMemo<ListTenantsQuery>(
    () => ({
      page,
      limit: PAGE_SIZE,
      ...(search.trim().length > 0 ? { search: search.trim() } : {}),
      ...(isPlan(planFilter) ? { plan: planFilter } : {}),
      ...(statusFilter === 'all' ? {} : { isActive: statusFilter === 'true' }),
    }),
    [page, search, planFilter, statusFilter],
  );

  const tenantsQuery = useQuery({
    queryKey: queryKeys.platformTenants(filters),
    queryFn: () => platformApi.tenants(filters),
    enabled: isOperator,
  });

  const columns = useMemo<Array<DataTableColumn<TenantSummary>>>(
    () => [
      {
        key: 'name',
        header: 'Laboratório',
        minWidth: 220,
        render: (tenant) => (
          <div className="flex min-w-0 flex-col">
            <span className="truncate font-semibold text-text">{tenant.name}</span>
            <span className="truncate text-caption text-neutral-600">{tenant.slug}</span>
          </div>
        ),
      },
      {
        key: 'plan',
        header: 'Plano',
        render: (tenant) => <Chip tone="positive">{PLAN_LABEL[tenant.subscriptionPlan]}</Chip>,
      },
      {
        key: 'subscriptionUntil',
        header: 'Assinatura até',
        render: (tenant) =>
          tenant.subscriptionUntil ? (
            <span className="whitespace-nowrap tabular-nums">
              {formatIsoDay(tenant.subscriptionUntil)}
            </span>
          ) : (
            <span className="text-neutral-600">Sem validade</span>
          ),
      },
      {
        key: 'userCount',
        header: 'Usuários',
        align: 'right',
        render: (tenant) => <span className="tabular-nums">{tenant.userCount}</span>,
      },
      {
        key: 'isActive',
        header: 'Situação',
        align: 'right',
        render: (tenant) => (
          <Chip tone={tenant.isActive ? 'positive' : 'inactive'}>
            {tenant.isActive ? 'Ativo' : 'Inativo'}
          </Chip>
        ),
      },
    ],
    [],
  );

  if (!isOperator) {
    return (
      <PageContainer>
        <PageHeader title="Laboratórios Clientes" />
        <EmptyState
          message="Acesso restrito ao operador da plataforma"
          hint="Este console não faz parte da operação do laboratório."
        />
      </PageContainer>
    );
  }

  const pagination = tenantsQuery.data?.pagination;
  const totalPages = pagination?.totalPages ?? 0;

  return (
    <PageContainer>
      <PageHeader
        title="Laboratórios Clientes"
        description="Cadastro, plano e saúde dos laboratórios atendidos pela plataforma."
        actions={
          <Button variant="primary" onClick={() => setModalOpen(true)}>
            + Novo laboratório
          </Button>
        }
      />

      <div className="flex flex-wrap items-end gap-md">
        <div className="min-w-[220px] flex-1">
          <SearchInput
            placeholder="Buscar por nome ou slug"
            aria-label="Buscar laboratório"
            onSearch={(term) => {
              setSearch(term);
              setPage(1);
            }}
          />
        </div>
        <div className="w-[200px]">
          <Select
            aria-label="Filtrar por plano"
            options={PLAN_FILTER_OPTIONS}
            value={planFilter}
            onChange={(event) => {
              setPlanFilter(event.target.value);
              setPage(1);
            }}
          />
        </div>
        <div className="w-[200px]">
          <Select
            aria-label="Filtrar por situação"
            options={STATUS_FILTER_OPTIONS}
            value={statusFilter}
            onChange={(event) => {
              setStatusFilter(event.target.value);
              setPage(1);
            }}
          />
        </div>
      </div>

      {tenantsQuery.isLoading ? (
        <p className="font-body text-body text-neutral-600">Carregando laboratórios...</p>
      ) : tenantsQuery.isError ? (
        <EmptyState
          message="Não foi possível carregar os laboratórios"
          hint="Verifique a conexão e tente novamente."
          action={
            <Button variant="secondary" onClick={() => void tenantsQuery.refetch()}>
              Tentar novamente
            </Button>
          }
        />
      ) : (
        <>
          <DataTable
            columns={columns}
            rows={tenantsQuery.data?.tenants ?? []}
            rowKey={(tenant) => tenant.id}
            emptyMessage="Nenhum laboratório encontrado"
          />

          {pagination && pagination.total > 0 && (
            <div className="flex flex-wrap items-center justify-between gap-md">
              <span className="font-body text-caption text-neutral-600">
                {pagination.total} laboratório(s) · página {pagination.page} de {totalPages}
              </span>
              <div className="flex items-center gap-sm">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pagination.page <= 1}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  Anterior
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={pagination.page >= totalPages}
                  onClick={() => setPage((current) => current + 1)}
                >
                  Próxima
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      <OnboardingModal open={modalOpen} onClose={closeModal} />
    </PageContainer>
  );
}

interface OnboardingModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Onboarding (WORKFLOWS.md §7): UM POST só, UMA transação só no servidor.
 * A tela não cria tema, canal nem admin em chamadas separadas — se o backend
 * falhar no meio, nada foi gravado e o slug continua livre.
 */
function OnboardingModal({ open, onClose }: OnboardingModalProps) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<CreateTenantRequest>(EMPTY_FORM);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<FormField, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);

  /**
   * `useCallback` NÃO é otimização aqui: `Modal` guarda o foco num efeito com
   * `onClose` na lista de dependências. Um `onClose` novo a cada tecla faria o
   * efeito rodar de novo e devolver o foco ao cartão, e o formulário perderia
   * tudo a partir do segundo caractere.
   */
  const close = useCallback(() => {
    setForm(EMPTY_FORM);
    setFieldErrors({});
    setFormError(null);
    onClose();
  }, [onClose]);

  const createTenant = useMutation({
    mutationFn: (body: CreateTenantRequest) => platformApi.createTenant(body),
    onSuccess: () => {
      // Invalida o escopo inteiro: a listagem tem filtro e página no cache.
      void queryClient.invalidateQueries({ queryKey: queryScopes.platform });
      close();
    },
    onError: (error: unknown) => {
      if (!isApiError(error)) {
        setFormError('Não foi possível concluir o onboarding. Tente novamente.');
        return;
      }
      // switch pelo CÓDIGO, nunca pela mensagem (API_ERRORS.md).
      switch (error.code) {
        case 'VALIDATION_ERROR': {
          const fields = readFieldErrors(error.details);
          setFieldErrors(fields);
          setFormError(Object.keys(fields).length > 0 ? null : 'Revise os dados informados.');
          break;
        }
        case 'CONFLICT':
          setFieldErrors({ slug: 'Já existe um laboratório com este slug' });
          setFormError(null);
          break;
        default:
          setFormError(error.message);
      }
    },
  });

  const submit = () => {
    setFieldErrors({});
    setFormError(null);
    createTenant.mutate(form);
  };

  return (
    <Modal
      open={open}
      onClose={close}
      title="Novo laboratório"
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={createTenant.isPending}>
            Cancelar
          </Button>
          <Button variant="confirmation" onClick={submit} loading={createTenant.isPending}>
            Criar laboratório
          </Button>
        </>
      }
    >
      <form
        className="flex flex-col gap-md"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
      >
        <p className="m-0 font-body text-caption text-neutral-600">
          O onboarding cria, em uma única transação, o laboratório, o tema padrão, os canais
          #geral e #aprovacoes e o administrador inicial.
        </p>

        <Input
          label="Nome do laboratório"
          value={form.name}
          error={fieldErrors.name}
          onChange={(event) => setForm((c) => ({ ...c, name: event.target.value }))}
        />
        <Input
          label="Slug"
          hint="Minúsculas, números e hífen — usado para identificar o laboratório."
          value={form.slug}
          error={fieldErrors.slug}
          onChange={(event) => setForm((c) => ({ ...c, slug: event.target.value }))}
        />
        <Select
          label="Plano"
          options={PLAN_FORM_OPTIONS}
          value={form.plan}
          error={fieldErrors.plan}
          onChange={(event) => {
            const value = event.target.value;
            if (isPlan(value)) setForm((c) => ({ ...c, plan: value }));
          }}
        />
        <Input
          label="Nome do administrador"
          value={form.adminName}
          error={fieldErrors.adminName}
          onChange={(event) => setForm((c) => ({ ...c, adminName: event.target.value }))}
        />
        <Input
          label="E-mail do administrador"
          type="email"
          value={form.adminEmail}
          error={fieldErrors.adminEmail}
          onChange={(event) => setForm((c) => ({ ...c, adminEmail: event.target.value }))}
        />
        <Input
          label="Senha inicial"
          type="password"
          hint="Mínimo de 8 caracteres."
          value={form.adminPassword}
          error={fieldErrors.adminPassword}
          onChange={(event) => setForm((c) => ({ ...c, adminPassword: event.target.value }))}
        />

        {formError && (
          <p role="alert" className="m-0 font-body text-caption text-accent-700">
            {formError}
          </p>
        )}
      </form>
    </Modal>
  );
}

export default PlatformTenants;
