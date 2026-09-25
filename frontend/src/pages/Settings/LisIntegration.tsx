import { useState } from 'react';
import type { LisIntegrationSettings } from '@crm-lab/shared';
import { ApiError } from '@/api/client';
import { useLisIntegration, useRunLisSync, useUpdateLisIntegration } from '@/api/lis-integration';
import { useAuthStore } from '@/stores/auth.store';
import { PageContainer, PageHeader } from '@/components/layout';
import { Button, Chip, Input, Toggle, useToast } from '@/components/ui';
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

  const syncing = data.running || runSync.isPending;

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
            <Input
              type="password"
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
      </div>
    </PageContainer>
  );
}

/** `marcaDagua` crua do Bitlab: mostrada pelos componentes, sem fuso (D-187). */
function formatWatermark(value: string): string {
  return `${formatIsoDay(value)} ${value.slice(11, 16)}`;
}

function SyncStatus({ settings }: { settings: LisIntegrationSettings }) {
  const last = settings.lastRunAt ? formatDateTime(settings.lastRunAt) : null;

  let chip: React.ReactNode;
  if (!settings.enabled) {
    chip = <Chip tone="inactive">Desligada</Chip>;
  } else if (settings.lastError) {
    chip = <Chip tone="attention">Com erro</Chip>;
  } else {
    chip = <Chip tone="positive">Sincronizando a cada {settings.intervalMinutes} min</Chip>;
  }

  return (
    <section className="flex flex-col gap-xs rounded-lg border border-neutral-200 bg-surface p-lg" aria-label="Situação da sincronização">
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
