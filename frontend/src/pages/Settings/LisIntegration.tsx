import { useState } from 'react';
import type { LisIntegrationSettings, LisRequisitionsSyncStatus } from '@crm-lab/shared';
import { ApiError } from '@/api/client';
import {
  useLisIntegration,
  useRunLisRequisitionsSync,
  useRunLisSync,
  useUpdateLisIntegration,
} from '@/api/lis-integration';
import { useAuthStore } from '@/stores/auth.store';
import { PageContainer, PageHeader } from '@/components/layout';
import { Button, Chip, PasswordInput, Toggle, useToast } from '@/components/ui';
import { formatDateTime, formatIsoDay } from '@/lib/format';

/**
 * Integração LIS (`/settings/lis-integration`) — sincronização dos orçamentos
 * pela API do Bitlab (PAGES.md §20, CRMLAB-52, D-185). Gestor vê e dispara
 * "Sincronizar agora"; só admin mexe em chave e interruptor.
 */
export default function LisIntegration() {
  const role = useAuthStore((s) => s.user?.role);
  const canEdit = role === 'admin';
  const { toast } = useToast();

  const { data, isLoading } = useLisIntegration();
  const update = useUpdateLisIntegration();
  const runSync = useRunLisSync();
  const runRequisitions = useRunLisRequisitionsSync();
  const [apiKey, setApiKey] = useState('');

  if (isLoading || !data) {
    return (
      <PageContainer>
        <PageHeader title="Integração LIS" />
        <div className="font-body text-body text-neutral-600">Carregando...</div>
      </PageContainer>
    );
  }

  function saveKey(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = apiKey.trim();
    if (trimmed === '') return;
    update.mutate(
      { apiKey: trimmed },
      {
        onSuccess: () => {
          setApiKey('');
          toast('Chave salva.', { tone: 'positive' });
        },
        onError: () => toast('Não foi possível salvar a chave.', { tone: 'attention' }),
      },
    );
  }

  function removeKey() {
    if (!window.confirm('Remover a chave? A sincronização será desligada.')) return;
    update.mutate(
      { apiKey: null },
      { onSuccess: () => toast('Chave removida. Sincronização desligada.', { tone: 'neutral' }) },
    );
  }

  function toggleEnabled(enabled: boolean) {
    update.mutate(
      { enabled },
      { onError: () => toast('Não foi possível mudar a sincronização.', { tone: 'attention' }) },
    );
  }

  function syncNow() {
    runSync.mutate(undefined, {
      onSuccess: (result) => {
        if (result.status === 'failed') {
          toast(result.error?.message ?? 'A sincronização falhou.', { tone: 'attention' });
        } else if (result.received === 0) {
          toast('Nenhuma alteração desde a última sincronização.', { tone: 'neutral' });
        } else {
          toast(
            `${result.received} orçamentos recebidos · ${result.proposalsWon} propostas ganhas`,
            { tone: 'positive' },
          );
        }
      },
      onError: (err) => {
        const reason = err instanceof ApiError ? err.details?.reason : undefined;
        toast(
          reason === 'lis_sync_running'
            ? 'Já existe uma sincronização em andamento.'
            : reason === 'lis_sync_not_configured'
              ? 'Ligue a sincronização e salve uma chave primeiro.'
              : 'Não foi possível sincronizar.',
          { tone: 'attention' },
        );
      },
    });
  }

  function syncRequisitionsNow() {
    runRequisitions.mutate(undefined, {
      onSuccess: () => toast('Sincronização de requisições iniciada.', { tone: 'neutral' }),
      onError: (err) => {
        const reason = err instanceof ApiError ? err.details?.reason : undefined;
        toast(
          reason === 'lis_requisitions_sync_running'
            ? 'Já existe uma sincronização de requisições em andamento.'
            : reason === 'lis_sync_not_configured'
              ? 'Ligue a sincronização e salve uma chave primeiro.'
              : 'Não foi possível sincronizar as requisições.',
          { tone: 'attention' },
        );
      },
    });
  }

  const syncing = data.running || runSync.isPending;
  const requisitionsSyncing = data.requisitions.running || runRequisitions.isPending;

  return (
    <PageContainer>
      <PageHeader
        title="Integração LIS"
        description="Sincronização automática dos orçamentos com o Bitlab."
      />

      <div className="max-w-lg space-y-lg">
        <SyncStatus settings={data} />

        {canEdit && (
          <form onSubmit={saveKey} className="space-y-sm">
            <PasswordInput
              label="Chave de acesso do Bitlab"
              hint="A chave fica cifrada e nunca é exibida de novo."
              placeholder={data.apiKeyMasked ?? 'Cole aqui a chave enviada pelo Bitlab'}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="off"
            />
            <div className="flex gap-sm">
              <Button type="submit" variant="secondary" disabled={apiKey.trim() === ''} loading={update.isPending}>
                Salvar chave
              </Button>
              {data.apiKeySet && (
                <Button type="button" variant="destructive" onClick={removeKey}>
                  Remover chave
                </Button>
              )}
            </div>
          </form>
        )}

        <div className="space-y-xs">
          <Toggle
            label="Sincronizar automaticamente"
            checked={data.enabled}
            onChange={toggleEnabled}
            disabled={!canEdit || !data.apiKeySet || update.isPending}
          />
          {canEdit && !data.apiKeySet && (
            <p className="font-body text-caption text-neutral-600">Salve uma chave primeiro.</p>
          )}
        </div>

        <Button
          type="button"
          variant="primary"
          onClick={syncNow}
          loading={syncing}
          disabled={syncing || !data.enabled}
        >
          Sincronizar agora
        </Button>

        <p className="font-body text-caption text-neutral-600">
          Os orçamentos sincronizados aparecem em Conferência e no histórico de importações (origem: API).
        </p>

        <RequisitionsStatus status={data.requisitions} />
        <Button
          type="button"
          variant="secondary"
          onClick={syncRequisitionsNow}
          loading={requisitionsSyncing}
          disabled={requisitionsSyncing || !data.enabled}
        >
          Sincronizar requisições agora
        </Button>
      </div>
    </PageContainer>
  );
}

/** `marcaDagua` crua do Bitlab: mostrada pelos componentes, sem fuso (D-187). */
function formatWatermark(value: string): string {
  return `${formatIsoDay(value)} ${value.slice(11, 16)}`;
}

/** `intervalSeconds` -> "30 s" / "2 min" (D-249). */
function formatSyncInterval(seconds: number): string {
  return seconds >= 60 && seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
}

function SyncStatus({ settings }: { settings: LisIntegrationSettings }) {
  const last = settings.lastRunAt ? formatDateTime(settings.lastRunAt) : null;

  let chip: React.ReactNode;
  if (!settings.enabled) {
    chip = <Chip tone="inactive">Desligada</Chip>;
  } else if (settings.lastError) {
    chip = <Chip tone="attention">Com erro</Chip>;
  } else {
    chip =
      settings.intervalSeconds > 0 ? (
        <Chip tone="positive">Sincronizando a cada {formatSyncInterval(settings.intervalSeconds)}</Chip>
      ) : (
        <Chip tone="positive">Ligada · só pelo "Sincronizar agora"</Chip>
      );
  }

  return (
    <section className="flex flex-col gap-xs rounded-lg border border-neutral-200 bg-neutral-100 p-lg" aria-label="Situação da sincronização">
      <div className="flex flex-wrap items-center gap-sm">
        {chip}
        {last && <span className="font-body text-caption text-neutral-600">última às {last}</span>}
      </div>
      {settings.lastError && (
        <p role="alert" className="font-body text-body font-semibold text-neutral-800">
          {settings.lastError}
        </p>
      )}
      <p className="font-body text-caption text-neutral-600">
        Última sincronização com sucesso:{' '}
        {settings.lastSuccessAt ? formatDateTime(settings.lastSuccessAt) : 'Nunca'}
      </p>
      <p className="font-body text-caption text-neutral-600">
        Dados atualizados até: {settings.watermark ? formatWatermark(settings.watermark) : 'Nunca'}
      </p>
    </section>
  );
}

/** Percentual da carga inicial: dias lidos entre `since` e hoje. */
function loadPercent(since: string, nextDay: string): number {
  const start = Date.parse(`${since}T00:00:00Z`);
  const next = Date.parse(`${nextDay}T00:00:00Z`);
  const today = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00Z`);
  const total = (today - start) / 86_400_000 + 1;
  if (!(total > 0)) return 0;
  return Math.max(0, Math.min(99, Math.floor(((next - start) / 86_400_000 / total) * 100)));
}

/** Cartão "Requisições" (PAGES §20, CRMLAB-200, D-338). */
function RequisitionsStatus({ status }: { status: LisRequisitionsSyncStatus }) {
  let chip: React.ReactNode;
  if (status.lastError) {
    chip = <Chip tone="attention">Com erro</Chip>;
  } else if (!status.initialLoad.done && status.initialLoad.nextDay) {
    chip = <Chip tone="inactive">Carga inicial: {loadPercent(status.initialLoad.since, status.initialLoad.nextDay)}%</Chip>;
  } else if (!status.initialLoad.done) {
    chip = <Chip tone="inactive">Carga inicial não feita</Chip>;
  } else {
    chip = <Chip tone="positive">Em dia · {status.total.toLocaleString('pt-BR')} requisições</Chip>;
  }

  return (
    <section
      className="flex flex-col gap-xs rounded-lg border border-neutral-200 bg-neutral-100 p-lg"
      aria-label="Sincronização de requisições"
    >
      <h2 className="font-heading text-section">Requisições</h2>
      <p className="font-body text-caption text-neutral-600">
        Todas as requisições do LIS, com ou sem orçamento. Alimentam o faturamento por médico e a curva ABC.
      </p>
      <div className="flex flex-wrap items-center gap-sm">
        {chip}
        {status.running && <span className="font-body text-caption text-neutral-600">sincronizando…</span>}
      </div>
      {status.lastError && (
        <p role="alert" className="font-body text-body font-semibold text-neutral-800">
          {status.lastError}
        </p>
      )}
      <p className="font-body text-caption text-neutral-600">
        {status.scheduleTimes.length > 0 ? `Atualiza às ${status.scheduleTimes.join(' e ')}` : 'Só pelo botão'}
      </p>
      <p className="font-body text-caption text-neutral-600">
        Última sincronização com sucesso: {status.lastSuccessAt ? formatDateTime(status.lastSuccessAt) : 'Nunca'}
      </p>
    </section>
  );
}
