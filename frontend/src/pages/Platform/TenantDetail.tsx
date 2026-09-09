import { useCallback, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SubscriptionPlan, TenantAdminAccount, TenantChannelStatus } from '@crm-lab/shared';
import { isApiError, platformApi, queryKeys, queryScopes } from '@/api';
import { PageContainer, PageHeader } from '@/components/layout';
import { DateDisplay, EmptyState, Modal } from '@/components/shared';
import { Button, Chip, Select } from '@/components/ui';
import { useAuthStore } from '@/stores';
import { StatTile } from './Billing';

/**
 * Detalhe do Laboratório — `/platform/tenants/:id` (PAGES.md §11.1,
 * API_CONTRACTS.md §5b "GET/PATCH /platform/tenants/:id",
 * "POST .../users/:userId/reset-password"). Drill-down, chega-se clicando
 * numa linha de `Tenants.tsx` — não é item de sidebar.
 *
 * Exceção mínima e nomeada ao isolamento do console (D-102): `channels` (status
 * de canal, sem telefone/token) e `admins` (só `id`+`email`, nunca nome, nunca
 * atendente/gestor). Fora daqui, o console continua sem caminho para dado de
 * laboratório — não acrescente campo sem reler `platform.service.ts`.
 */

const PLAN_LABEL: Record<SubscriptionPlan, string> = {
  starter: 'Starter',
  pro: 'Pro',
  enterprise: 'Enterprise',
};

const PLAN_OPTIONS = [
  { value: 'starter', label: PLAN_LABEL.starter },
  { value: 'pro', label: PLAN_LABEL.pro },
  { value: 'enterprise', label: PLAN_LABEL.enterprise },
];

const CHANNEL_LABEL: Record<string, string> = {
  whatsapp: 'WhatsApp',
  sms: 'SMS',
  web: 'Web',
  direct: 'Direto',
};

const CONNECTION_MODE_LABEL: Record<TenantChannelStatus['connectionMode'], string> = {
  cloud_api: 'API oficial',
  qr: 'QR code',
};

function isPlan(value: string): value is SubscriptionPlan {
  return value === 'starter' || value === 'pro' || value === 'enterprise';
}

export function PlatformTenantDetail() {
  const { id } = useParams<{ id: string }>();
  const tenantId = id ?? '';
  const role = useAuthStore((state) => state.user?.role);
  const isOperator = role === 'platform_operator';
  const queryClient = useQueryClient();

  const detailQuery = useQuery({
    queryKey: queryKeys.platformTenant(tenantId),
    queryFn: () => platformApi.tenant(tenantId),
    enabled: isOperator && tenantId.length > 0,
  });

  const [suspendOpen, setSuspendOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [planDraft, setPlanDraft] = useState<SubscriptionPlan>('starter');
  const [resetTarget, setResetTarget] = useState<TenantAdminAccount | null>(null);
  const [resetPickerOpen, setResetPickerOpen] = useState(false);
  const [issuedPassword, setIssuedPassword] = useState<{ email: string; password: string } | null>(
    null,
  );

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryScopes.platform });
  }, [queryClient]);

  const updateTenant = useMutation({
    mutationFn: (body: { isActive?: boolean; subscriptionPlan?: SubscriptionPlan }) =>
      platformApi.updateTenant(tenantId, body),
    onSuccess: () => {
      invalidate();
      setSuspendOpen(false);
      setPlanOpen(false);
    },
  });

  const resetPassword = useMutation({
    mutationFn: (userId: string) => platformApi.resetAdminPassword(tenantId, userId),
    onSuccess: (result) => {
      setResetTarget(null);
      setResetPickerOpen(false);
      setIssuedPassword({ email: result.email, password: result.temporaryPassword });
    },
  });

  if (!isOperator) {
    return (
      <PageContainer>
        <PageHeader title="Detalhe do laboratório" />
        <EmptyState
          message="Acesso restrito ao operador da plataforma"
          hint="Este console não faz parte da operação do laboratório."
        />
      </PageContainer>
    );
  }

  if (detailQuery.isLoading) {
    return (
      <PageContainer>
        <PageHeader title="Detalhe do laboratório" />
        <p className="font-body text-body text-neutral-600">Carregando laboratório...</p>
      </PageContainer>
    );
  }

  if (detailQuery.isError || !detailQuery.data) {
    return (
      <PageContainer>
        <PageHeader title="Detalhe do laboratório" />
        <EmptyState
          message="Não foi possível carregar este laboratório"
          hint="Ele pode ter sido removido, ou houve um problema de conexão."
          action={
            <Button variant="secondary" onClick={() => void detailQuery.refetch()}>
              Tentar novamente
            </Button>
          }
        />
      </PageContainer>
    );
  }

  const tenant = detailQuery.data;
  const admins = tenant.admins;

  const openResetFlow = () => {
    if (admins.length === 0) return;
    if (admins.length === 1) {
      const [only] = admins;
      if (only) setResetTarget(only);
      return;
    }
    setResetPickerOpen(true);
  };

  return (
    <PageContainer>
      <PageHeader
        title={tenant.name}
        description={`/${tenant.slug}`}
        actions={
          <div className="flex items-center gap-sm">
            <Button
              variant="secondary"
              onClick={() => {
                setPlanDraft(tenant.subscriptionPlan);
                setPlanOpen(true);
              }}
            >
              Trocar plano
            </Button>
            <Button
              variant={tenant.isActive ? 'destructive' : 'confirmation'}
              onClick={() => setSuspendOpen(true)}
            >
              {tenant.isActive ? 'Suspender' : 'Reativar'}
            </Button>
          </div>
        }
      />

      <div className="flex flex-wrap items-center gap-sm">
        <Chip tone="positive">{PLAN_LABEL[tenant.subscriptionPlan]}</Chip>
        <Chip tone={tenant.isActive ? 'positive' : 'inactive'}>
          {tenant.isActive ? 'Ativo' : 'Inativo'}
        </Chip>
        <span className="font-body text-caption text-neutral-600">
          Criado em <DateDisplay value={tenant.createdAt} variant="absolute" />
        </span>
      </div>

      <section className="flex flex-col gap-md">
        <h2 className="m-0 font-heading text-h4 text-text">Integrações</h2>
        {tenant.channels.length === 0 ? (
          <EmptyState message="Nenhum canal configurado" hint="O laboratório ainda não conectou nenhum canal." />
        ) : (
          <div className="grid gap-md sm:grid-cols-2">
            {tenant.channels.map((channel) => (
              <div
                key={channel.channel}
                className="flex flex-col gap-xs rounded-lg bg-neutral-100 px-lg py-md shadow-sm"
              >
                <div className="flex items-center justify-between gap-sm">
                  <span className="font-semibold text-text">
                    {CHANNEL_LABEL[channel.channel] ?? channel.channel}
                  </span>
                  <Chip tone={channel.isActive ? 'positive' : 'inactive'}>
                    {channel.isActive ? 'Conectado' : 'Desconectado'}
                  </Chip>
                </div>
                <span className="font-body text-caption text-neutral-600">
                  {CONNECTION_MODE_LABEL[channel.connectionMode]}
                </span>
                <span className="font-body text-caption text-neutral-600">
                  {channel.connectedAt ? (
                    <>
                      Conectado desde <DateDisplay value={channel.connectedAt} variant="absolute" />
                    </>
                  ) : (
                    'Nunca conectou'
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-md">
        <h2 className="m-0 font-heading text-h4 text-text">Saúde de uso</h2>
        <div className="grid gap-md sm:grid-cols-4">
          <StatTile label="Usuários ativos" hint={`de ${tenant.usage.totalUsers} no total`}>
            <span className="font-heading text-metric tabular-nums">{tenant.usage.activeUsers}</span>
          </StatTile>
          <StatTile label="Último login">
            {tenant.usage.lastLoginAt ? (
              <DateDisplay value={tenant.usage.lastLoginAt} variant="relative" />
            ) : (
              <span className="text-neutral-600">Nunca logou</span>
            )}
          </StatTile>
          <StatTile label="Propostas no mês">
            <span className="font-heading text-metric tabular-nums">
              {tenant.usage.proposalsThisMonth}
            </span>
          </StatTile>
          <StatTile label="Mensagens no mês">
            <span className="font-heading text-metric tabular-nums">
              {tenant.usage.messagesThisMonth}
            </span>
          </StatTile>
        </div>
      </section>

      <section className="flex flex-col gap-md">
        <h2 className="m-0 font-heading text-h4 text-text">Administração</h2>
        <div className="flex items-center gap-sm">
          <Button variant="secondary" onClick={openResetFlow} disabled={admins.length === 0}>
            Resetar senha do admin
          </Button>
          {admins.length === 0 && (
            <span className="font-body text-caption text-neutral-600">
              Nenhum admin cadastrado
            </span>
          )}
        </div>
      </section>

      {/* Suspender/reativar — confirmação obrigatória (PAGES.md §11.1). */}
      <Modal
        open={suspendOpen}
        onClose={() => setSuspendOpen(false)}
        title={tenant.isActive ? 'Suspender laboratório' : 'Reativar laboratório'}
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setSuspendOpen(false)}
              disabled={updateTenant.isPending}
            >
              Cancelar
            </Button>
            <Button
              variant={tenant.isActive ? 'destructive' : 'confirmation'}
              loading={updateTenant.isPending}
              onClick={() => updateTenant.mutate({ isActive: !tenant.isActive })}
            >
              {tenant.isActive ? 'Suspender' : 'Reativar'}
            </Button>
          </>
        }
      >
        <p className="m-0 font-body text-body text-text">
          {tenant.isActive
            ? `Nenhum usuário de ${tenant.name} vai conseguir logar até que o laboratório seja reativado.`
            : `${tenant.name} volta a ter acesso normal ao sistema.`}
        </p>
        {updateTenant.isError && (
          <p role="alert" className="m-0 mt-sm font-body text-caption text-accent-700">
            Não foi possível concluir. Tente novamente.
          </p>
        )}
      </Modal>

      {/* Trocar plano. */}
      <Modal
        open={planOpen}
        onClose={() => setPlanOpen(false)}
        title="Trocar plano"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setPlanOpen(false)}
              disabled={updateTenant.isPending}
            >
              Cancelar
            </Button>
            <Button
              variant="confirmation"
              loading={updateTenant.isPending}
              disabled={planDraft === tenant.subscriptionPlan}
              onClick={() => updateTenant.mutate({ subscriptionPlan: planDraft })}
            >
              Confirmar
            </Button>
          </>
        }
      >
        <Select
          label="Novo plano"
          options={PLAN_OPTIONS}
          value={planDraft}
          onChange={(event) => {
            const value = event.target.value;
            if (isPlan(value)) setPlanDraft(value);
          }}
        />
        {updateTenant.isError && (
          <p role="alert" className="m-0 mt-sm font-body text-caption text-accent-700">
            Não foi possível concluir. Tente novamente.
          </p>
        )}
      </Modal>

      {/* Mais de um admin: escolher antes de confirmar. */}
      <Modal
        open={resetPickerOpen}
        onClose={() => setResetPickerOpen(false)}
        title="Escolher administrador"
        footer={
          <Button variant="secondary" onClick={() => setResetPickerOpen(false)}>
            Cancelar
          </Button>
        }
      >
        <div className="flex flex-col gap-sm">
          {admins.map((admin) => (
            <Button
              key={admin.id}
              variant="secondary"
              onClick={() => {
                setResetPickerOpen(false);
                setResetTarget(admin);
              }}
            >
              {admin.email}
            </Button>
          ))}
        </div>
      </Modal>

      {/* Confirmação do reset de senha. */}
      <Modal
        open={resetTarget !== null}
        onClose={() => setResetTarget(null)}
        title="Resetar senha do admin"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setResetTarget(null)}
              disabled={resetPassword.isPending}
            >
              Cancelar
            </Button>
            <Button
              variant="destructive"
              loading={resetPassword.isPending}
              onClick={() => {
                if (resetTarget) resetPassword.mutate(resetTarget.id);
              }}
            >
              Resetar senha
            </Button>
          </>
        }
      >
        <p className="m-0 font-body text-body text-text">
          Uma senha temporária substitui a senha atual de <strong>{resetTarget?.email}</strong>{' '}
          imediatamente. A senha atual deixa de funcionar.
        </p>
        {resetPassword.isError && (
          <p role="alert" className="m-0 mt-sm font-body text-caption text-accent-700">
            {isApiError(resetPassword.error)
              ? 'Não foi possível resetar a senha.'
              : 'Erro inesperado. Tente novamente.'}
          </p>
        )}
      </Modal>

      {/* Senha temporária exibida UMA vez — nunca reaparece, nunca fica em log. */}
      <Modal
        open={issuedPassword !== null}
        onClose={() => setIssuedPassword(null)}
        title="Senha temporária gerada"
        footer={
          <Button variant="confirmation" onClick={() => setIssuedPassword(null)}>
            Fechar
          </Button>
        }
      >
        <div className="flex flex-col gap-sm">
          <p className="m-0 font-body text-body text-text">
            Repasse esta senha a <strong>{issuedPassword?.email}</strong> por um canal seguro. Ela
            não será mostrada de novo depois de fechar esta janela.
          </p>
          <div className="flex items-center gap-sm rounded-lg bg-neutral-100 px-lg py-md">
            <code className="flex-1 font-mono text-body tracking-wide text-text">
              {issuedPassword?.password}
            </code>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                if (issuedPassword) void navigator.clipboard.writeText(issuedPassword.password);
              }}
            >
              Copiar
            </Button>
          </div>
        </div>
      </Modal>
    </PageContainer>
  );
}

export default PlatformTenantDetail;
