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
  WhatsAppDisconnectInfo,
} from '@crm-lab/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  channelsApi,
  isApiError,
  queryKeys,
  settingsApi,
  useWhatsAppDisconnect,
  useWhatsAppStatus,
} from '@/api';
import { PageContainer, PageHeader } from '@/components/layout';
import { DataTable, EmptyState, Modal } from '@/components/shared';
import type { DataTableColumn } from '@/components/shared';
import { WhatsAppConnectModal } from '@/components/settings/WhatsAppConnectModal';
import { WhatsAppUsageCard } from '@/components/settings/WhatsAppUsageCard';
import { Button, Chip, Input, TextArea, Toggle, useToast } from '@/components/ui';
import { formatDateTime } from '@/lib/format';
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
    <section className="flex flex-col gap-md rounded-lg border border-neutral-200 bg-neutral-100 p-lg">
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

/**
 * Por que o WhatsApp por QR caiu (CRMLAB-134, D-307). `logged_out` (401) é o
 * caso perigoso: pode ser conta restringida, e reconectar durante a restrição
 * arrisca o banimento — o aviso fica aqui, ao lado do botão de reconectar.
 * `manual` foi o próprio admin: nada a explicar.
 */
function LastDisconnectNotice({ info }: { info: WhatsAppDisconnectInfo }) {
  if (info.reason === 'manual') return null;
  const when = formatDateTime(info.at);
  if (info.reason === 'logged_out') {
    return (
      <p
        role="status"
        data-testid="whatsapp-logged-out"
        className="m-0 rounded-md bg-accent-100 px-md py-sm font-body text-caption text-accent-800"
      >
        <strong>O WhatsApp encerrou a sessão em {when}.</strong> O aparelho foi desvinculado no
        celular, removido pelo WhatsApp ou a conta foi restringida. Confira o celular antes de
        reconectar: se aparecer “conta restringida”, espere o prazo terminar.
      </p>
    );
  }
  return (
    <p role="status" className="m-0 font-body text-caption text-neutral-600">
      Desconectado desde {when}
      {info.statusCode !== null ? ` (código ${info.statusCode})` : ''}.
    </p>
  );
}

interface WhatsAppQrConnectionProps {
  /** `undefined` quando o laboratório ainda não tem linha `whatsapp` em `settings.channels`. */
  channel: TenantChannel | undefined;
  /** Bloqueia o botão de conectar (troca de modo ainda sem confirmação). */
  connectDisabled?: boolean;
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
function WhatsAppQrConnection({ channel, connectDisabled }: WhatsAppQrConnectionProps) {
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
          <Button
            variant="secondary"
            disabled={connectDisabled}
            onClick={() => setConnectOpen(true)}
          >
            Conectar WhatsApp
          </Button>
        )}
      </div>

      {!isConnected && channel?.connectionMode === 'qr' && status?.lastDisconnect && (
        <LastDisconnectNotice info={status.lastDisconnect} />
      )}

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

type WhatsAppMode = 'qr' | 'cloud_api';

const MODE_LABEL: Record<WhatsAppMode, string> = {
  qr: 'QR Code (número próprio)',
  cloud_api: 'API oficial da Meta (Cloud API)',
};

/**
 * Em `cloud_api`, o número do QR pode continuar pareado no Evolution (trocar de
 * modo não desloga, D-308 item 2). Mensagem do paciente para esse número ainda
 * entra no CRM, mas a resposta sai pela Meta, de outro número. A tela avisa e
 * oferece desconectar (decisão de 05/11/2026: aceita e avisa).
 */
function QrStillPairedNotice() {
  const { toast } = useToast();
  const statusQuery = useWhatsAppStatus();
  const disconnect = useWhatsAppDisconnect();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const status = statusQuery.data;
  if (status?.status !== 'connected') return null;

  return (
    <div
      role="status"
      data-testid="qr-still-paired"
      className="flex flex-col gap-sm rounded-md bg-accent-100 px-md py-sm font-body text-caption text-accent-800"
    >
      <span>
        O número do QR{status.phoneNumber ? ` (${status.phoneNumber})` : ''} ainda está pareado.
        Mensagens que chegarem nele entram no CRM, mas a resposta sai pela API oficial, de outro
        número. Desconecte quando a migração terminar.
      </span>
      <div>
        <Button variant="secondary" onClick={() => setConfirmOpen(true)}>
          Desconectar o QR
        </Button>
      </div>
      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Desconectar o número do QR"
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
              onClick={() =>
                disconnect.mutate(undefined, {
                  onSuccess: () => {
                    setConfirmOpen(false);
                    toast('Número do QR desconectado.', { tone: 'neutral' });
                  },
                  onError: (error: unknown) => {
                    toast(
                      isApiError(error)
                        ? error.message
                        : 'Não foi possível desconectar. Tente novamente.',
                      { tone: 'attention' },
                    );
                  },
                })
              }
            >
              Confirmar desconexão
            </Button>
          </>
        }
      >
        <p className="m-0 font-body text-body text-text">
          O celular deixa de receber mensagens pelo CRM. O envio continua pela API oficial da Meta.
        </p>
      </Modal>
    </div>
  );
}

/**
 * Modo do WhatsApp do laboratório (CRMLAB-138, D-308). Admin only (montado no
 * ramo `canEdit`). Trocar de modo NÃO apaga nem reenvia mensagens, exige
 * confirmação explícita e mostra o que muda. O token da Cloud API é write-only:
 * campo mascarado, nunca preenchido pelo servidor.
 */
function WhatsAppModeCard({ channel }: { channel: TenantChannel | undefined }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const current: WhatsAppMode = channel?.connectionMode ?? 'cloud_api';
  const [selected, setSelected] = useState<WhatsAppMode>(current);
  const [confirmed, setConfirmed] = useState(false);
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  const onError = (err: unknown) => {
    const fields = isApiError(err) ? readFieldErrors(err.details) : {};
    setError(
      Object.values(fields)[0] ??
        (isApiError(err) ? err.message : 'Não foi possível salvar. Tente novamente.'),
    );
  };

  const save = useMutation({
    mutationFn: (body: UpdateChannelSettingsRequest) => settingsApi.updateChannels(body),
    onSuccess: (next) => {
      queryClient.setQueryData(queryKeys.channelSettings(), next);
      setConfirmed(false);
      setToken('');
      toast('Credenciais do WhatsApp salvas.', { tone: 'neutral' });
    },
    onError,
  });

  // Troca para a API oficial: grava o que foi digitado (PATCH) e só então troca
  // o modo (PUT /mode). O servidor recusa a troca sem as três credenciais.
  const switchToCloud = useMutation({
    mutationFn: async (credentials: UpdateChannelSettingsRequest | null) => {
      if (credentials) await settingsApi.updateChannels(credentials);
      return channelsApi.setWhatsAppMode({ mode: 'cloud_api' });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.channelSettings() });
      setConfirmed(false);
      setToken('');
      toast('WhatsApp passou a usar a API oficial da Meta.', { tone: 'neutral' });
    },
    onError: (err: unknown) => {
      // O PATCH pode ter passado antes do PUT falhar: relê para a tela não
      // ficar com `cloudApiConfigured` velho.
      void queryClient.invalidateQueries({ queryKey: queryKeys.channelSettings() });
      onError(err);
    },
  });

  // Volta para o QR com o termo já aceito: só o PUT. Não chama o gateway nem abre
  // sessão nova (D-308 item 2) — reconectar sem necessidade abre outro socket no
  // Evolution. Se a sessão tiver caído, o "Conectar WhatsApp" aparece depois.
  const switchToQr = useMutation({
    mutationFn: () => channelsApi.setWhatsAppMode({ mode: 'qr' }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.channelSettings() });
      setConfirmed(false);
      toast('WhatsApp voltou para o número pareado por QR.', { tone: 'neutral' });
    },
    onError,
  });
  const termsAccepted = channel?.acceptedTermsAt != null;

  const changing = selected !== current;
  const cloudConfigured = channel?.cloudApiConfigured === true;
  const needsConfirm = changing && (selected === 'cloud_api' || current === 'cloud_api');
  const typedAny = phoneNumberId.trim() !== '' || wabaId.trim() !== '' || token.length > 0;
  // Já configurado: dá para trocar só confirmando. Senão, as três são obrigatórias.
  const credentialsReady =
    (cloudConfigured && !typedAny) ||
    (phoneNumberId.trim() !== '' && wabaId.trim() !== '' && token.length > 0);

  const submitCloud = () => {
    setError(null);
    switchToCloud.mutate(
      typedAny
        ? {
            channels: [
              {
                channel: 'whatsapp',
                phoneNumberId: phoneNumberId.trim(),
                wabaId: wabaId.trim(),
                apiToken: token,
              },
            ],
          }
        : null,
    );
  };

  const saveWaba = () => {
    setError(null);
    save.mutate({
      channels: [{ channel: 'whatsapp', wabaId: wabaId.trim() }],
    });
  };

  return (
    <div className="flex flex-col gap-sm rounded-md border border-neutral-200 bg-neutral-100 p-md">
      <span className="font-body text-label font-semibold text-text">Modo do WhatsApp</span>
      <div role="radiogroup" aria-label="Modo do WhatsApp" className="flex flex-col gap-xs">
        {(['qr', 'cloud_api'] as const).map((mode) => (
          <label key={mode} className="flex cursor-pointer items-center gap-sm">
            <input
              type="radio"
              name="whatsappMode"
              value={mode}
              checked={selected === mode}
              onChange={() => {
                setSelected(mode);
                setConfirmed(false);
                setError(null);
              }}
              className="accent-accent"
            />
            <span className="font-body text-label text-text">
              {MODE_LABEL[mode]}
              {mode === current ? ' — atual' : ''}
            </span>
          </label>
        ))}
      </div>

      {changing && (
        <div
          role="status"
          data-testid="whatsapp-mode-warning"
          className="flex flex-col gap-xs rounded-md bg-accent-100 px-md py-sm font-body text-caption text-accent-800"
        >
          <strong>O que muda ao trocar o modo:</strong>
          <ul className="m-0 flex list-disc flex-col gap-xs pl-lg">
            <li>
              Histórico: as conversas e mensagens existentes continuam como estão — nada é
              apagado nem reenviado.
            </li>
            <li>
              Envio: as próximas mensagens passam a sair por{' '}
              {selected === 'cloud_api' ? 'a API oficial da Meta' : 'o número pareado por QR'}.
              {selected === 'cloud_api'
                ? ' Texto livre só sai até 24 h depois da última mensagem do paciente.'
                : ' As credenciais da API oficial ficam guardadas para voltar depois.'}
            </li>
            <li>
              Reengajamento: {selected === 'cloud_api' ? 'fica inativo' : 'volta a funcionar'}{' '}
              (só roda com WhatsApp por QR).
            </li>
          </ul>
        </div>
      )}

      {needsConfirm && (
        <label className="flex cursor-pointer items-start gap-sm font-body text-caption text-text">
          <input
            type="checkbox"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
            className="mt-xs accent-accent"
          />
          <span>Entendi e quero trocar o modo do WhatsApp deste laboratório.</span>
        </label>
      )}

      {selected === 'cloud_api' && (
        <div className="grid grid-cols-1 gap-md sm:grid-cols-2">
          {changing && (
            <>
              <Input
                label="ID do número (phone_number_id)"
                value={phoneNumberId}
                onChange={(event) => setPhoneNumberId(event.target.value)}
              />
              <Input
                label="Token de acesso da Cloud API"
                type="password"
                autoComplete="off"
                hint="Não é exibido depois de salvo."
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
            </>
          )}
          <Input
            label="ID da conta WhatsApp Business (waba_id)"
            hint={channel?.wabaId ? `Atual: ${channel.wabaId}` : 'Não configurado'}
            value={wabaId}
            onChange={(event) => setWabaId(event.target.value)}
          />
        </div>
      )}

      {error && (
        <p role="alert" className="m-0 font-body text-caption text-accent-700">
          {error}
        </p>
      )}

      {current === 'cloud_api' && !changing && <QrStillPairedNotice />}
      {selected === 'cloud_api' && changing && cloudConfigured && (
        <p role="status" className="m-0 font-body text-caption text-neutral-600">
          As credenciais da API oficial já estão guardadas. Preencha os campos só se quiser
          trocá-las.
        </p>
      )}
      {selected === 'cloud_api' && changing && (
        <div>
          <Button
            variant="primary"
            loading={switchToCloud.isPending}
            disabled={!confirmed || !credentialsReady}
            onClick={submitCloud}
          >
            Trocar para API oficial
          </Button>
        </div>
      )}
      {selected === 'cloud_api' && !changing && (
        <div>
          <Button
            variant="secondary"
            loading={save.isPending}
            disabled={wabaId.trim() === ''}
            onClick={saveWaba}
          >
            Salvar WABA
          </Button>
          <span className="ml-sm font-body text-caption text-neutral-600">
            Token e ID do número são editados nos campos acima.
          </span>
        </div>
      )}
      {selected === 'qr' && changing && termsAccepted && (
        <div>
          <Button
            variant="primary"
            loading={switchToQr.isPending}
            disabled={!confirmed}
            onClick={() => {
              setError(null);
              switchToQr.mutate();
            }}
          >
            Voltar para QR
          </Button>
        </div>
      )}
      {selected === 'qr' && !(changing && termsAccepted) && (
        <WhatsAppQrConnection
          channel={channel}
          connectDisabled={needsConfirm && !confirmed}
        />
      )}
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
                        : draft.channel === 'whatsapp'
                          ? // D-308 item 3: no WhatsApp é o token da Meta; o QR tem a própria chave.
                            'Não configurado (token da API oficial da Meta; o QR não usa)'
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
                    <WhatsAppModeCard
                      channel={settings.channels.find((channel) => channel.channel === 'whatsapp')}
                    />
                  )}
                </div>
              ))}
            </div>
          </Section>

          {/* ── Custo da Cloud API (CRMLAB-141, D-312) — gestor e admin ─── */}
          {settings.channels.some(
            (channel) => channel.channel === 'whatsapp' && channel.connectionMode === 'cloud_api',
          ) && (
            <Section
              title="Uso e custo do WhatsApp (API oficial)"
              description="Mensagens enviadas pelo CRM no mês, por categoria de cobrança da Meta."
            >
              <WhatsAppUsageCard />
            </Section>
          )}

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
            description="Enviadas ao contato pelo canal. Mensagem ligada precisa de texto."
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
