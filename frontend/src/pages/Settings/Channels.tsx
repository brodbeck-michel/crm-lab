import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type {
  ChannelSettingsResponse,
  ChannelTeamMember,
  DistributionMode,
  TenantChannel,
  UpdateChannelSettingsRequest,
  UserRole,
  WeekDay,
} from '@crm-lab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { isApiError, queryKeys, settingsApi, useWhatsAppDisconnect, useWhatsAppStatus } from '@/api';
import { PageContainer, PageHeader } from '@/components/layout';
import { DataTable, EmptyState, Modal } from '@/components/shared';
import type { DataTableColumn } from '@/components/shared';
import { WhatsAppConnectModal } from '@/components/settings/WhatsAppConnectModal';
import { Button, Chip, Input, TextArea, Toggle, useToast } from '@/components/ui';
import { useAuthStore } from '@/stores';
import {
  CHANNEL_LABEL,
  DISTRIBUTION_HINT,
  DISTRIBUTION_LABEL,
  WEEK_DAYS,
  WEEK_DAY_LABEL,
  buildUpdateRequest,
  defaultRangeFor,
  toForm,
  unrenderedFieldPaths,
  validateForm,
} from './channels-form';
import type { ChannelDraft, ChannelsForm } from './channels-form';

/**
 * Canais & Equipe — `/settings/channels`
 * (PAGES.md §10 · API_CONTRACTS.md §6 · D-064, D-065, D-066).
 *
 * ADMIN EDITA, GESTOR LÊ. Para o gestor a tela não renderiza campo, botão de
 * salvar nem "remover token": não há controle de escrita a desabilitar, porque
 * não existe nenhum. O servidor recusaria o PATCH dele de qualquer forma (403)
 * — a UI esconde, o servidor recusa.
 *
 * O SEGREDO NUNCA VOLTA DO SERVIDOR. A tela recebe `apiTokenMasked` e
 * `webhookSecretSet`; o campo de escrita nasce vazio e **deixá-lo em branco
 * preserva o valor guardado**. Apagar é um ato explícito ("Remover", que envia
 * `null`). Isso está escrito na própria tela, não só aqui: um admin que
 * suponha "campo vazio = apagar" derruba a integração do laboratório.
 */

const ROLE_LABEL: Record<UserRole, string> = {
  attendant: 'Atendente',
  manager: 'Gestor',
  admin: 'Administrador',
  platform_operator: 'Operador da plataforma',
};

const DISTRIBUTION_OPTIONS: DistributionMode[] = ['manual', 'round_robin'];

/** `details.fields` (API_ERRORS.md) → `{ caminho: motivo }`, sem `any`. */
function readFieldErrors(details: Record<string, unknown> | undefined): Record<string, string> {
  const raw = details?.fields;
  if (typeof raw !== 'object' || raw === null) return {};
  const mapped: Record<string, string> = {};
  for (const [field, reason] of Object.entries(raw as Record<string, unknown>)) {
    mapped[field] = typeof reason === 'string' ? reason : String(reason);
  }
  return mapped;
}

interface SectionProps {
  title: string;
  description?: string;
  children: ReactNode;
}

function Section({ title, description, children }: SectionProps) {
  return (
    <section className="flex flex-col gap-md rounded-lg border border-neutral-200 bg-surface p-lg">
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

interface WhatsAppQrConnectionProps {
  /** `undefined` quando o laboratório ainda não tem linha `whatsapp` em `settings.channels`. */
  channel: TenantChannel | undefined;
}

/**
 * Conexão por QR (Onda 7 — Bloco B, `docs/api/API_CONTRACTS.md` §6.1) —
 * alternativa à API oficial da Meta dentro do MESMO cartão do canal WhatsApp.
 * As 4 rotas de QR são **admin apenas**: este bloco só é montado dentro do
 * ramo `canEdit` do cartão (ver abaixo), então nem o `GET /status` sai para
 * quem não é admin — a UI esconde, o servidor recusaria de qualquer forma.
 *
 * Desconectar NÃO desativa o canal (`is_active` intocado) — são dois
 * controles distintos, por isso a confirmação abaixo é explícita sobre isso
 * em vez de deixar o admin supor que "desconectar" é "desligar".
 */
function WhatsAppQrConnection({ channel }: WhatsAppQrConnectionProps) {
  const { toast } = useToast();
  const statusQuery = useWhatsAppStatus();
  const disconnect = useWhatsAppDisconnect();

  const [connectOpen, setConnectOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string | null>(null);

  const status = statusQuery.data;
  const isConnected = channel?.connectionMode === 'qr' && status?.status === 'connected';

  return (
    <div className="flex flex-col gap-sm rounded-md border border-neutral-200 bg-neutral-100 p-md">
      <div className="flex flex-wrap items-center justify-between gap-sm">
        <div className="flex flex-col gap-xs">
          <span className="font-body text-label font-semibold text-text">
            Conexão por QR (número próprio)
          </span>
          <span className="font-body text-caption text-neutral-600">
            Alternativa à API oficial: pareia o WhatsApp do celular do laboratório escaneando um
            QR code.
          </span>
        </div>

        {isConnected ? (
          <div className="flex flex-wrap items-center gap-sm">
            <Chip tone="positive">
              Conectado{status?.phoneNumber ? ` — ${status.phoneNumber}` : ''}
            </Chip>
            <Button variant="destructive" onClick={() => setConfirmOpen(true)}>
              Desconectar
            </Button>
          </div>
        ) : (
          <Button variant="secondary" onClick={() => setConnectOpen(true)}>
            Conectar WhatsApp
          </Button>
        )}
      </div>

      <WhatsAppConnectModal
        open={connectOpen}
        onClose={() => setConnectOpen(false)}
        acceptedTermsAt={channel?.acceptedTermsAt ?? null}
      />

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Desconectar WhatsApp"
        footer={
          <>
            <Button
              variant="secondary"
              onClick={() => setConfirmOpen(false)}
              disabled={disconnect.isPending}
            >
              Cancelar
            </Button>
            <Button
              variant="destructive"
              loading={disconnect.isPending}
              onClick={() => {
                setDisconnectError(null);
                disconnect.mutate(undefined, {
                  onSuccess: () => {
                    setConfirmOpen(false);
                    toast('WhatsApp desconectado.', { tone: 'neutral' });
                  },
                  onError: (error: unknown) => {
                    // A falha precisa de toast, nao so do texto no modal: o
                    // aviso em `text-caption` passou batido em producao e o
                    // admin concluiu que "nada acontece" depois de 6 tentativas
                    // que o backend recusou com 503 (gateway fora do ar).
                    const message = isApiError(error)
                      ? error.message
                      : 'Não foi possível desconectar. Tente novamente.';
                    setDisconnectError(message);
                    toast(message, { tone: 'attention' });
                  },
                });
              }}
            >
              Confirmar desconexão
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-md">
          <p className="m-0 font-body text-body text-text">
            O celular deixa de responder pelo CRM. O canal <strong>continua ativo</strong> na
            tela — desconectar não desativa o canal, são dois controles distintos. Dá para
            conectar de novo depois.
          </p>
          {disconnectError && (
            <p role="alert" className="m-0 font-body text-caption text-accent-700">
              {disconnectError}
            </p>
          )}
        </div>
      </Modal>
    </div>
  );
}

interface ReadFieldProps {
  label: string;
  value: ReactNode;
}

function ReadField({ label, value }: ReadFieldProps) {
  return (
    <div className="flex min-w-0 flex-col gap-xs">
      <span className="font-body text-caption font-semibold text-neutral-700">{label}</span>
      <span className="font-body text-label text-text">{value}</span>
    </div>
  );
}

export default function ChannelsSettings() {
  const role = useAuthStore((state) => state.user?.role);
  const canRead = role === 'manager' || role === 'admin';
  const canEdit = role === 'admin';

  const queryClient = useQueryClient();

  const settingsQuery = useQuery({
    queryKey: queryKeys.channelSettings(),
    queryFn: () => settingsApi.channels(),
    // Guarda de papel SEM request: quem tomaria 403 nem pergunta.
    enabled: canRead,
    /**
     * A tela é um formulário longo. Um refetch ao focar a janela devolveria o
     * estado do servidor por cima do que o admin está digitando — inclusive
     * limpando o campo de token no meio da digitação.
     */
    refetchOnWindowFocus: false,
  });

  const updateSettings = useMutation({
    mutationFn: (body: UpdateChannelSettingsRequest) => settingsApi.updateChannels(body),
    // O PATCH devolve o estado completo já mascarado: semeia o cache, não refaz o GET.
    onSuccess: (next) => queryClient.setQueryData(queryKeys.channelSettings(), next),
  });

  const [form, setForm] = useState<ChannelsForm | null>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const settings: ChannelSettingsResponse | undefined = settingsQuery.data;

  /**
   * O formulário é semeado pela resposta e RESSEMEADO depois de salvar (o
   * `PATCH` devolve o estado completo já mascarado). É isso que zera os campos
   * de segredo depois de gravar: eles voltam vazios porque em branco significa
   * "preserva", e o valor recém-gravado passa a aparecer só como máscara.
   */
  useEffect(() => {
    if (settings) setForm(toForm(settings));
  }, [settings]);

  const clientErrors = useMemo(() => (form ? validateForm(form) : {}), [form]);
  const errors = { ...clientErrors, ...serverErrors };
  const hasBlockingError = Object.keys(clientErrors).length > 0;

  const teamColumns = useMemo<Array<DataTableColumn<ChannelTeamMember>>>(
    () => [
      {
        key: 'name',
        header: 'Nome',
        minWidth: 220,
        render: (member) => <span className="font-semibold text-text">{member.name}</span>,
      },
      {
        key: 'role',
        header: 'Papel',
        render: (member) => <span>{ROLE_LABEL[member.role]}</span>,
      },
      {
        key: 'isActive',
        header: 'Situação',
        align: 'right',
        render: (member) => (
          <Chip tone={member.isActive ? 'positive' : 'inactive'}>
            {member.isActive ? 'Ativo' : 'Inativo'}
          </Chip>
        ),
      },
    ],
    [],
  );

  if (!canRead) {
    return (
      <PageContainer>
        <PageHeader title="Canais & Equipe" />
        <EmptyState
          message="Acesso restrito a gestor e administrador"
          hint="A conexão do canal e a equipe do laboratório são configuração de gestão."
        />
      </PageContainer>
    );
  }

  const updateForm = (mutate: (current: ChannelsForm) => ChannelsForm) => {
    setSaved(false);
    setForm((current) => (current ? mutate(current) : current));
  };

  const updateChannel = (channel: string, patch: Partial<ChannelDraft>) => {
    updateForm((current) => ({
      ...current,
      channels: current.channels.map((draft) =>
        draft.channel === channel ? { ...draft, ...patch } : draft,
      ),
    }));
  };

  const updateDay = (day: WeekDay, patch: { start?: string; end?: string } | null) => {
    updateForm((current) => {
      const existing = current.businessHours.days[day];
      const next =
        patch === null ? null : { ...(existing ?? defaultRangeFor()), ...patch };
      return {
        ...current,
        businessHours: {
          ...current.businessHours,
          days: { ...current.businessHours.days, [day]: next },
        },
      };
    });
  };

  const save = () => {
    if (!form || !settings) return;
    setServerErrors({});
    setFormError(null);
    setSaved(false);

    updateSettings.mutate(buildUpdateRequest(form, settings), {
      onSuccess: () => setSaved(true),
      onError: (error: unknown) => {
        if (!isApiError(error)) {
          setFormError('Não foi possível salvar. Tente novamente.');
          return;
        }
        // switch pelo CÓDIGO, nunca pela mensagem (API_ERRORS.md).
        switch (error.code) {
          case 'VALIDATION_ERROR': {
            const fields = readFieldErrors(error.details);
            setServerErrors(fields);
            /**
             * A mensagem geral só some quando TODO campo recusado tem onde
             * aparecer na tela. Um `details.fields` que a tela não sabe
             * renderizar (campo novo do servidor, convenção divergente) deixava
             * o admin com um 400 sem nenhum aviso — ele achava que salvou.
             */
            const orphans = unrenderedFieldPaths(form, fields);
            setFormError(
              Object.keys(fields).length === 0
                ? 'Revise os dados informados.'
                : orphans.length > 0
                  ? `Revise os dados informados: ${orphans.map((path) => fields[path]).join(' ')}`
                  : null,
            );
            break;
          }
          case 'FORBIDDEN':
            setFormError('Somente o administrador do laboratório pode alterar esta configuração.');
            break;
          default:
            setFormError(error.message);
        }
      },
    });
  };

  return (
    <PageContainer>
      <PageHeader
        title="Canais & Equipe"
        description="Conexão do canal, distribuição das conversas, mensagens automáticas e horário de atendimento."
        actions={
          canEdit ? (
            <Button
              variant="primary"
              onClick={save}
              disabled={!form || hasBlockingError}
              loading={updateSettings.isPending}
            >
              Salvar alterações
            </Button>
          ) : (
            <Chip tone="inactive">Somente leitura</Chip>
          )
        }
      />

      {!canEdit && (
        <p role="status" className="m-0 font-body text-caption text-neutral-600">
          Gestor vê esta tela em modo leitura. Alterações de canal e horário são feitas pelo
          administrador do laboratório.
        </p>
      )}

      {settingsQuery.isLoading ? (
        <p className="font-body text-body text-neutral-600">Carregando configuração...</p>
      ) : settingsQuery.isError ? (
        <EmptyState
          message="Não foi possível carregar a configuração de canais"
          hint="Verifique a conexão e tente novamente."
          action={
            <Button variant="secondary" onClick={() => void settingsQuery.refetch()}>
              Tentar novamente
            </Button>
          }
        />
      ) : form && settings ? (
        <>
          {formError && (
            <p role="alert" className="m-0 font-body text-caption text-accent-700">
              {formError}
            </p>
          )}
          {saved && (
            <p role="status" className="m-0 font-body text-caption text-accent2-700">
              Configuração salva.
            </p>
          )}

          {/* ── Conexão de canal ───────────────────────────────────────── */}
          <Section
            title="Conexão de canal"
            description="Um canal por laboratório. Desligar um canal é marcá-lo como inativo — não há remoção."
          >
            <div className="flex flex-col gap-lg">
              {form.channels.map((draft) => (
                <div
                  key={draft.channel}
                  className="flex flex-col gap-md rounded-md border border-neutral-200 p-md"
                >
                  <div className="flex flex-wrap items-center justify-between gap-sm">
                    <h3 className="m-0 font-heading text-label text-text">
                      {CHANNEL_LABEL[draft.channel]}
                    </h3>
                    {canEdit ? (
                      <Toggle
                        checked={draft.isActive}
                        onChange={(isActive) => updateChannel(draft.channel, { isActive })}
                        label="Canal ativo"
                      />
                    ) : (
                      <Chip tone={draft.isActive ? 'positive' : 'inactive'}>
                        {draft.isActive ? 'Ativo' : 'Inativo'}
                      </Chip>
                    )}
                  </div>

                  {canEdit ? (
                    <div className="grid grid-cols-1 gap-md sm:grid-cols-2">
                      {/* `error` casa com `details.fields` por NOME do canal
                          (API_ERRORS.md): `channels.whatsapp.phoneNumber`. */}
                      <Input
                        label="Nome exibido"
                        value={draft.displayName}
                        error={errors[`channels.${draft.channel}.displayName`]}
                        onChange={(event) =>
                          updateChannel(draft.channel, { displayName: event.target.value })
                        }
                      />
                      <Input
                        label="Número"
                        value={draft.phoneNumber}
                        error={errors[`channels.${draft.channel}.phoneNumber`]}
                        onChange={(event) =>
                          updateChannel(draft.channel, { phoneNumber: event.target.value })
                        }
                      />
                      <Input
                        label="ID do número no provedor"
                        hint="phone_number_id da Meta."
                        error={errors[`channels.${draft.channel}.phoneNumberId`]}
                        value={draft.phoneNumberId}
                        onChange={(event) =>
                          updateChannel(draft.channel, { phoneNumberId: event.target.value })
                        }
                      />
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-md sm:grid-cols-2">
                      <ReadField
                        label="Nome exibido"
                        value={draft.displayName || 'Não informado'}
                      />
                      <ReadField label="Número" value={draft.phoneNumber || 'Não informado'} />
                      <ReadField
                        label="ID do número no provedor"
                        value={draft.phoneNumberId || 'Não informado'}
                      />
                    </div>
                  )}

                  <SecretField
                    idPrefix={`${draft.channel}-token`}
                    label="Token da API"
                    statusLabel={
                      draft.apiTokenMasked
                        ? `Configurado (${draft.apiTokenMasked})`
                        : 'Não configurado'
                    }
                    configured={draft.apiTokenMasked !== null}
                    canEdit={canEdit}
                    value={draft.apiTokenInput}
                    remove={draft.removeApiToken}
                    error={errors[`channels.${draft.channel}.apiToken`]}
                    onChange={(apiTokenInput) => updateChannel(draft.channel, { apiTokenInput })}
                    onToggleRemove={(removeApiToken) =>
                      updateChannel(draft.channel, { removeApiToken, apiTokenInput: '' })
                    }
                  />

                  <SecretField
                    idPrefix={`${draft.channel}-webhook`}
                    label="Segredo do webhook"
                    statusLabel={draft.webhookSecretSet ? 'Configurado' : 'Não configurado'}
                    configured={draft.webhookSecretSet}
                    canEdit={canEdit}
                    value={draft.webhookSecretInput}
                    remove={draft.removeWebhookSecret}
                    error={errors[`channels.${draft.channel}.webhookSecret`]}
                    onChange={(webhookSecretInput) =>
                      updateChannel(draft.channel, { webhookSecretInput })
                    }
                    onToggleRemove={(removeWebhookSecret) =>
                      updateChannel(draft.channel, { removeWebhookSecret, webhookSecretInput: '' })
                    }
                  />

                  {canEdit && draft.channel === 'whatsapp' && (
                    <WhatsAppQrConnection
                      channel={settings.channels.find((channel) => channel.channel === 'whatsapp')}
                    />
                  )}
                </div>
              ))}
            </div>
          </Section>

          {/* ── Distribuição ───────────────────────────────────────────── */}
          <Section
            title="Modo de distribuição"
            description="Como a conversa nova chega ao atendente."
          >
            {canEdit ? (
              <div role="radiogroup" aria-label="Modo de distribuição" className="flex flex-col gap-sm">
                {DISTRIBUTION_OPTIONS.map((mode) => (
                  <label key={mode} className="flex cursor-pointer items-start gap-sm">
                    <input
                      type="radio"
                      name="distributionMode"
                      value={mode}
                      checked={form.distributionMode === mode}
                      onChange={() => updateForm((current) => ({ ...current, distributionMode: mode }))}
                      className="mt-xs accent-accent"
                    />
                    <span className="flex flex-col gap-xs">
                      <span className="font-body text-label text-text">
                        {DISTRIBUTION_LABEL[mode]}
                      </span>
                      <span className="font-body text-caption text-neutral-600">
                        {DISTRIBUTION_HINT[mode]}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <ReadField
                label="Modo atual"
                value={
                  <span className="flex flex-col gap-xs">
                    <span>{DISTRIBUTION_LABEL[form.distributionMode]}</span>
                    <span className="font-body text-caption text-neutral-600">
                      {DISTRIBUTION_HINT[form.distributionMode]}
                    </span>
                  </span>
                }
              />
            )}
          </Section>

          {/* ── Mensagens automáticas ──────────────────────────────────── */}
          <Section
            title="Mensagens automáticas"
            description="Enviadas ao paciente pelo canal. Mensagem ligada precisa de texto."
          >
            <div className="flex flex-col gap-lg">
              {(['greeting', 'offHours'] as const).map((key) => {
                const draft = form.autoMessages[key];
                const title = key === 'greeting' ? 'Saudação' : 'Fora do horário';
                const hint =
                  key === 'greeting'
                    ? 'Primeira mensagem de uma conversa nova.'
                    : 'Resposta fora do horário de atendimento configurado abaixo.';
                const errorKey = `autoMessages.${key}.message`;

                return (
                  <div key={key} className="flex flex-col gap-sm">
                    <div className="flex flex-wrap items-center justify-between gap-sm">
                      <div className="flex flex-col gap-xs">
                        <span className="font-body text-label font-semibold text-text">{title}</span>
                        <span className="font-body text-caption text-neutral-600">{hint}</span>
                      </div>
                      {canEdit ? (
                        <Toggle
                          checked={draft.enabled}
                          onChange={(enabled) =>
                            updateForm((current) => ({
                              ...current,
                              autoMessages: {
                                ...current.autoMessages,
                                [key]: { ...current.autoMessages[key], enabled },
                              },
                            }))
                          }
                          label={`Ativar ${title.toLowerCase()}`}
                        />
                      ) : (
                        <Chip tone={draft.enabled ? 'positive' : 'inactive'}>
                          {draft.enabled ? 'Ativa' : 'Desativada'}
                        </Chip>
                      )}
                    </div>

                    {canEdit ? (
                      <TextArea
                        aria-label={`Texto — ${title}`}
                        value={draft.message}
                        error={errors[errorKey]}
                        onChange={(event) =>
                          updateForm((current) => ({
                            ...current,
                            autoMessages: {
                              ...current.autoMessages,
                              [key]: { ...current.autoMessages[key], message: event.target.value },
                            },
                          }))
                        }
                      />
                    ) : (
                      <ReadField label={`Texto — ${title}`} value={draft.message || 'Sem texto'} />
                    )}
                  </div>
                );
              })}
            </div>
          </Section>

          {/* ── Horário de atendimento ─────────────────────────────────── */}
          <Section
            title="Horário de atendimento"
            description="Dia desligado significa fechado. O horário salvo substitui o anterior por inteiro."
          >
            {canEdit ? (
              <Input
                label="Fuso horário"
                hint="Identificador IANA, como America/Sao_Paulo."
                value={form.businessHours.timezone}
                error={errors['businessHours.timezone']}
                onChange={(event) =>
                  updateForm((current) => ({
                    ...current,
                    businessHours: { ...current.businessHours, timezone: event.target.value },
                  }))
                }
              />
            ) : (
              <ReadField label="Fuso horário" value={form.businessHours.timezone} />
            )}

            <div className="flex flex-col gap-sm">
              {WEEK_DAYS.map((day) => {
                const range = form.businessHours.days[day];
                const dayError = errors[`businessHours.days.${day}`];

                return (
                  <div key={day} className="flex flex-col gap-xs">
                    <div className="flex flex-wrap items-center gap-md">
                      <span className="w-[92px] font-body text-label text-text">
                        {WEEK_DAY_LABEL[day]}
                      </span>

                      {canEdit ? (
                        <>
                          <Toggle
                            checked={range !== null}
                            onChange={(open) => updateDay(day, open ? {} : null)}
                            aria-label={`${WEEK_DAY_LABEL[day]} — atender neste dia`}
                          />
                          {range ? (
                            <div className="flex items-center gap-sm">
                              <input
                                type="time"
                                aria-label={`${WEEK_DAY_LABEL[day]} — abre`}
                                value={range.start}
                                onChange={(event) => updateDay(day, { start: event.target.value })}
                                className="rounded-pill border border-neutral-300 bg-bg px-lg py-[10px] font-body text-label text-text outline-none focus:border-accent"
                              />
                              <span className="font-body text-caption text-neutral-600">até</span>
                              <input
                                type="time"
                                aria-label={`${WEEK_DAY_LABEL[day]} — fecha`}
                                value={range.end}
                                onChange={(event) => updateDay(day, { end: event.target.value })}
                                className="rounded-pill border border-neutral-300 bg-bg px-lg py-[10px] font-body text-label text-text outline-none focus:border-accent"
                              />
                            </div>
                          ) : (
                            <span className="font-body text-caption text-neutral-600">Fechado</span>
                          )}
                        </>
                      ) : (
                        <span className="font-body text-label text-text">
                          {range ? `${range.start} às ${range.end}` : 'Fechado'}
                        </span>
                      )}
                    </div>
                    {dayError && (
                      <span role="alert" className="font-body text-caption text-accent-700">
                        {dayError}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </Section>

          {/* ── Equipe ─────────────────────────────────────────────────── */}
          <Section
            title="Equipe"
            description="Vem junto com esta configuração. Papel e limite de desconto são editados em Usuários & Permissões."
          >
            <DataTable
              columns={teamColumns}
              rows={settings.team}
              rowKey={(member) => member.id}
              emptyMessage="Nenhum usuário no laboratório"
              minWidth={480}
            />
          </Section>
        </>
      ) : null}
    </PageContainer>
  );
}

interface SecretFieldProps {
  idPrefix: string;
  label: string;
  statusLabel: string;
  configured: boolean;
  canEdit: boolean;
  value: string;
  remove: boolean;
  error?: string;
  onChange: (value: string) => void;
  onToggleRemove: (remove: boolean) => void;
}

/**
 * Campo de segredo write-only.
 *
 * Os três estados estão escritos NA TELA porque a semântica não é adivinhável:
 * em branco preserva, "Remover" apaga, texto grava. Não existe botão "revelar":
 * o servidor não devolve o valor, então não há o que revelar.
 */
function SecretField({
  idPrefix,
  label,
  statusLabel,
  configured,
  canEdit,
  value,
  remove,
  error,
  onChange,
  onToggleRemove,
}: SecretFieldProps) {
  if (!canEdit) {
    return <ReadField label={label} value={statusLabel} />;
  }

  return (
    <div className="flex flex-col gap-sm">
      <div className="flex flex-wrap items-center gap-sm">
        <span className="font-body text-caption font-semibold text-neutral-700">{label}</span>
        <Chip tone={configured ? 'positive' : 'inactive'}>{statusLabel}</Chip>
      </div>

      <Input
        id={idPrefix}
        type="password"
        autoComplete="new-password"
        aria-label={label}
        placeholder={remove ? 'Será removido ao salvar' : 'Deixe em branco para manter o atual'}
        value={value}
        error={error}
        disabled={remove}
        hint={
          remove
            ? 'Ao salvar, o valor guardado será apagado.'
            : 'Campo em branco PRESERVA o valor atual. Digite algo apenas para substituí-lo.'
        }
        onChange={(event) => onChange(event.target.value)}
      />

      {configured && (
        <label className="flex items-center gap-sm font-body text-caption text-neutral-700">
          <input
            type="checkbox"
            checked={remove}
            onChange={(event) => onToggleRemove(event.target.checked)}
            className="accent-accent"
          />
          Remover {label.toLowerCase()} ao salvar
        </label>
      )}
    </div>
  );
}
