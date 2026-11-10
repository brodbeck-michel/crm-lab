import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  DEFAULT_DISCOUNT_LIMIT,
  STALE_NEW_BUDGET_MINUTES_MAX,
  STALE_NEW_BUDGET_MINUTES_MIN,
  staleReminderVsLossError,
  type DelayRule,
  type FunnelAutomationRules,
  type FunnelRules,
  type RuleActorRole,
  type StaleNewBudgetAlertRule,
  type UpdateFunnelRulesRequest,
} from '@crm-lab/shared';
import { useFunnelRules, useUpdateFunnelRules } from '@/api/funnel-rules';
import { useAuthStore } from '@/stores/auth.store';
import { PageContainer, PageHeader } from '@/components/layout';
import { Button, Input, SegmentedControl, Toggle, useToast } from '@/components/ui';
import Commissions from './Commissions';
import { HolidaysSection } from './HolidaysSection';
import { ReengagementSection, reengagementBlocked } from './ReengagementSection';
import { ResponseAlertSection, responseAlertBlocked } from './ResponseAlertSection';
import { FirstContactLimitSection, firstContactLimitBlocked } from './FirstContactLimitSection';
import { SendMessageSection, sendMessageBlocked } from './SendMessageSection';

/**
 * Regras (`/settings/rules`) — PAGES.md §21, CRMLAB-56 (D-190..D-194).
 *
 * Seções 1–4, o reingajamento (CRMLAB-62) e o alerta de tempo de resposta
 * (CRMLAB-84) são um formulário só, salvo em
 * `PATCH /settings/funnel-rules` com SÓ o que mudou. A seção de desconto
 * aparece com "Criar pelo CRM" ligado (valor salvo). Feriados e comissão têm
 * endpoint e permissão próprios, fora do formulário. Atendente vê tudo
 * desabilitado.
 *
 * CRMLAB-144 (D-316): as seções ficam em 4 abas — Funil, Mensagens, Comercial
 * e Feriados. Todas continuam MONTADAS (a aba inativa só fica `hidden`), para
 * o rascunho e o estado local de cada seção sobreviverem à troca de aba. O
 * formulário e o "Salvar regras" seguem únicos para Funil + Mensagens.
 */

type RulesTab = 'funil' | 'mensagens' | 'comercial' | 'feriados';

const TAB_LABELS: Record<RulesTab, string> = {
  funil: 'Funil',
  mensagens: 'Mensagens',
  comercial: 'Comercial',
  feriados: 'Feriados',
};

/** Em que aba mora cada seção (`id` do `<section>`) — usado pela âncora `#secao`. */
const SECTION_TAB: Record<string, RulesTab> = {
  origem: 'funil',
  automacao: 'funil',
  travas: 'funil',
  'carga-lis': 'funil',
  mensagem: 'mensagens',
  reingajamento: 'mensagens',
  'alerta-resposta': 'mensagens',
  'primeiro-contato': 'mensagens',
  descontos: 'comercial',
  comissoes: 'comercial',
  feriados: 'feriados',
};

/** Primeiro segmento do caminho do campo (`automation.x.days`) → aba onde ele aparece. */
const FIELD_TAB: Record<string, RulesTab> = {
  origin: 'funil',
  automation: 'funil',
  manualMoves: 'funil',
  lisSource: 'funil',
  sendMessage: 'mensagens',
  reengagement: 'mensagens',
  responseAlert: 'mensagens',
  firstContactLimit: 'mensagens',
};

function tabFromHash(hash: string): RulesTab | undefined {
  return SECTION_TAB[hash.replace(/^#/, '')];
}

type Json = Record<string, unknown>;

function isPlainObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Só os campos de `draft` que diferem de `base`, no mesmo formato aninhado. */
function diffRules(base: unknown, draft: unknown): unknown {
  if (isPlainObject(base) && isPlainObject(draft)) {
    const out: Json = {};
    for (const key of Object.keys(draft)) {
      const child = diffRules(base[key], draft[key]);
      if (child !== undefined) out[key] = child;
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }
  return JSON.stringify(base) === JSON.stringify(draft) ? undefined : draft;
}

const ROLE_LABELS: Record<RuleActorRole, string> = {
  attendant: 'Atendente',
  manager: 'Gestor',
};

type DelayKey =
  | 'sentToFollowUp'
  | 'negotiationToFollowUp'
  | 'followUpToLost'
  | 'staleProposalReminder';

const DELAY_RULES: ReadonlyArray<{ key: Exclude<DelayKey, 'staleProposalReminder'>; label: string }> = [
  { key: 'sentToFollowUp', label: 'Orçamento enviado há X dias → Follow-up' },
  { key: 'negotiationToFollowUp', label: 'Negociação sem pagamento há Y dias → Follow-up' },
  { key: 'followUpToLost', label: 'Follow-up há Z dias → Perdido (motivo "Silêncio")' },
];

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      aria-labelledby={`${id}-titulo`}
      className="space-y-md rounded-lg border border-neutral-200 bg-neutral-100 p-lg"
    >
      <div className="space-y-xs">
        <h2 id={`${id}-titulo`} className="font-heading text-section text-text">
          {title}
        </h2>
        <p className="font-body text-caption text-neutral-600">{description}</p>
      </div>
      {children}
    </section>
  );
}

/**
 * Prazo do alerta de "Novo orçamento" parado, em minutos (CRMLAB-97, D-267),
 * com a dica do equivalente em horas. Conferido a cada tique de 5 min.
 */
function StaleMinutesInput({
  rule,
  disabled,
  error,
  onChange,
}: {
  rule: StaleNewBudgetAlertRule;
  disabled: boolean;
  error: string | undefined;
  onChange: (minutes: number) => void;
}) {
  const { minutes } = rule;
  const outOfRange =
    minutes < STALE_NEW_BUDGET_MINUTES_MIN || minutes > STALE_NEW_BUDGET_MINUTES_MAX;
  const hint = outOfRange
    ? `De ${STALE_NEW_BUDGET_MINUTES_MIN} a ${STALE_NEW_BUDGET_MINUTES_MAX} minutos.`
    : minutes >= 60
      ? `${minutes} min = ${formatHoursHint(minutes)}`
      : 'Conferido a cada 5 minutos.';
  return (
    <div className="flex flex-col gap-xs">
      <div className="w-32">
        <Input
          type="number"
          aria-label="Minutos"
          value={String(minutes)}
          min={STALE_NEW_BUDGET_MINUTES_MIN}
          max={STALE_NEW_BUDGET_MINUTES_MAX}
          disabled={disabled}
          error={error}
          onChange={(e) => {
            const parsed = Number.parseInt(e.target.value, 10);
            onChange(Number.isFinite(parsed) ? parsed : 0);
          }}
        />
      </div>
      <span data-testid="dica-minutos" className="font-body text-caption text-neutral-600">
        {hint}
      </span>
    </div>
  );
}

/** "4 h", "1 h 30 min" — dica do campo em minutos. */
function formatHoursHint(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${h} h` : `${h} h ${rest} min`;
}

function FieldError({ message }: { message: string | undefined }) {
  if (!message) return null;
  return (
    <span role="alert" className="font-body text-caption text-accent-700">
      {message}
    </span>
  );
}

export default function Rules() {
  const role = useAuthStore((s) => s.user?.role);
  const canEdit = role === 'manager' || role === 'admin';
  const seesCommissions = role === 'manager' || role === 'admin';
  const { toast } = useToast();
  const location = useLocation();

  const { data, isLoading, isError } = useFunnelRules();
  const updateRules = useUpdateFunnelRules();

  const [draft, setDraft] = useState<FunnelRules | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [tab, setTab] = useState<RulesTab>(() => tabFromHash(location.hash) ?? 'funil');

  useEffect(() => {
    if (data) setDraft(JSON.parse(JSON.stringify(data)) as FunnelRules);
  }, [data]);

  // `/settings/commissions` redireciona para `#comissoes` (D-194): abre a aba da seção...
  useEffect(() => {
    const target = tabFromHash(location.hash);
    if (target) setTab(target);
  }, [location.hash]);

  // ...e rola até ela, já visível.
  useEffect(() => {
    if (location.hash === '' || draft === null) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView?.({ block: 'start' });
  }, [location.hash, draft, tab]);

  const patch = useMemo(
    () =>
      data && draft ? (diffRules(data, draft) as UpdateFunnelRulesRequest | undefined) : undefined,
    [data, draft],
  );

  if (isLoading || (!draft && !isError)) {
    return (
      <PageContainer>
        <PageHeader title="Regras" />
        <div className="font-body text-body text-neutral-600">Carregando...</div>
      </PageContainer>
    );
  }

  if (!draft || !data) {
    return (
      <PageContainer>
        <PageHeader title="Regras" />
        <div className="font-body text-body text-neutral-600">
          Não foi possível carregar as regras.
        </div>
      </PageContainer>
    );
  }

  const set = (mutate: (next: FunnelRules) => void) =>
    setDraft((current) => {
      if (!current) return current;
      const next = JSON.parse(JSON.stringify(current)) as FunnelRules;
      mutate(next);
      return next;
    });

  const setAutomation = <K extends keyof FunnelAutomationRules>(
    key: K,
    value: FunnelAutomationRules[K],
  ) => set((next) => void (next.automation[key] = value));

  const noOrigin = !draft.origin.fromBitlab && !draft.origin.manualInCrm;
  // CRMLAB-102/D-272 item 8: a mesma função do servidor, com o teto de dias na mensagem.
  const reminderVsLoss = staleReminderVsLossError(draft.automation);
  const funnelBlocked = noOrigin || reminderVsLoss !== null;
  const messagesBlocked =
    sendMessageBlocked(draft.sendMessage) ||
    reengagementBlocked(draft.reengagement) ||
    responseAlertBlocked(draft.responseAlert) ||
    firstContactLimitBlocked(draft.firstContactLimit);
  const blocked = funnelBlocked || messagesBlocked;
  // O "Salvar" é um só para Funil + Mensagens: se o que trava está na OUTRA aba, avisa qual.
  const blockedElsewhere: RulesTab | null =
    tab === 'funil' && !funnelBlocked && messagesBlocked
      ? 'mensagens'
      : tab === 'mensagens' && !messagesBlocked && funnelBlocked
        ? 'funil'
        : null;

  // Comercial só existe se tiver o que mostrar (desconto do CRM ou comissão).
  const tabs: RulesTab[] = [
    'funil',
    'mensagens',
    ...(data.origin.manualInCrm || seesCommissions ? (['comercial'] as const) : []),
    'feriados',
  ];
  const activeTab: RulesTab = tabs.includes(tab) ? tab : 'funil';
  const inForm = activeTab === 'funil' || activeTab === 'mensagens';

  function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (!patch || blocked) return;
    setFieldErrors({});
    updateRules.mutate(patch, {
      onSuccess: () => toast('Regras atualizadas.', { tone: 'positive' }),
      onError: (err) => {
        const fields = (err as { details?: { fields?: Record<string, string> } })?.details?.fields;
        setFieldErrors(fields ?? {});
        // Erro de campo numa aba que não está aberta: leva o usuário até ele.
        const firstField = fields ? Object.keys(fields)[0] : undefined;
        const errorTab = firstField ? FIELD_TAB[firstField.split('.')[0] ?? ''] : undefined;
        if (errorTab) setTab(errorTab);
        toast(fields ? 'Confira os campos destacados.' : 'Não foi possível salvar as regras.', {
          tone: 'attention',
        });
      },
    });
  }

  const delayInput = (key: DelayKey, rule: DelayRule, localError?: string) => (
    <div className="w-32">
      <Input
        type="number"
        aria-label={key === 'staleProposalReminder' ? 'Dias do lembrete' : 'Dias'}
        value={String(rule.days)}
        min={1}
        max={365}
        disabled={!canEdit || !rule.enabled}
        error={localError ?? fieldErrors[`automation.${key}.days`]}
        onChange={(e) => {
          const parsed = Number.parseInt(e.target.value, 10);
          const days = Number.isFinite(parsed) ? parsed : 0;
          set((next) => void (next.automation[key].days = days));
        }}
      />
    </div>
  );

  return (
    <PageContainer>
      <PageHeader
        title="Regras"
        description="Como as propostas nascem, andam pelo funil e são enviadas neste laboratório."
      />

      <div>
        <SegmentedControl
          aria-label="Grupos de regras"
          size="md"
          fullWidth={false}
          options={tabs.map((value) => ({ value, label: TAB_LABELS[value] }))}
          value={activeTab}
          onChange={setTab}
        />
      </div>

      <form onSubmit={handleSave} hidden={!inForm} className="max-w-3xl space-y-lg">
        <div
          role="tabpanel"
          aria-label={TAB_LABELS.funil}
          hidden={activeTab !== 'funil'}
          className="space-y-lg"
        >
        <Section
          id="origem"
          title="Origem das propostas"
          description="De onde a proposta nasce. Deixe ao menos uma ligada."
        >
          <div className="flex flex-col gap-sm">
            <Toggle
              label="Nascer do orçamento do Bitlab"
              checked={draft.origin.fromBitlab}
              disabled={!canEdit}
              onChange={(checked) => set((next) => void (next.origin.fromBitlab = checked))}
            />
            <Toggle
              label="Criar proposta manualmente no CRM (itens pelo catálogo)"
              checked={draft.origin.manualInCrm}
              disabled={!canEdit}
              onChange={(checked) => set((next) => void (next.origin.manualInCrm = checked))}
            />
          </div>
          <FieldError
            message={
              fieldErrors.origin ??
              (noOrigin ? 'Deixe ao menos uma origem de proposta ligada.' : undefined)
            }
          />
        </Section>

        <Section
          id="automacao"
          title="Automação do funil"
          description="O que o sistema faz sozinho. Os prazos contam desde que o cartão entrou no estágio e são conferidos a cada poucos minutos. Dias úteis: segunda a sexta, sem descontar feriados."
        >
          <div className="flex flex-col gap-md">
            <Toggle
              label="Requisição → Negociação"
              checked={draft.automation.requisitionToNegotiation.enabled}
              disabled={!canEdit}
              onChange={(enabled) => setAutomation('requisitionToNegotiation', { enabled })}
            />
            <Toggle
              label="Pagamento → Ganho"
              checked={draft.automation.paymentToWon.enabled}
              disabled={!canEdit}
              onChange={(enabled) => setAutomation('paymentToWon', { enabled })}
            />
            {DELAY_RULES.map(({ key, label }) => (
              <div key={key} className="flex flex-wrap items-center gap-md">
                <Toggle
                  label={label}
                  checked={draft.automation[key].enabled}
                  disabled={!canEdit}
                  onChange={(enabled) => setAutomation(key, { ...draft.automation[key], enabled })}
                />
                {delayInput(key, draft.automation[key])}
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-md">
              <Toggle
                label='Alerta de "Novo orçamento" parado há N minutos sem envio'
                checked={draft.automation.staleNewBudgetAlert.enabled}
                disabled={!canEdit}
                onChange={(enabled) =>
                  setAutomation('staleNewBudgetAlert', {
                    ...draft.automation.staleNewBudgetAlert,
                    enabled,
                  })
                }
              />
              <StaleMinutesInput
                rule={draft.automation.staleNewBudgetAlert}
                disabled={!canEdit || !draft.automation.staleNewBudgetAlert.enabled}
                error={fieldErrors['automation.staleNewBudgetAlert.minutes']}
                onChange={(minutes) =>
                  set((next) => void (next.automation.staleNewBudgetAlert.minutes = minutes))
                }
              />
            </div>
            {/* CRMLAB-102/D-272: conta desde a criação da proposta, uma vez por proposta. */}
            <div className="flex flex-wrap items-center gap-md">
              <Toggle
                label="Lembrete de contato para proposta aberta há N dias desde a criação"
                checked={draft.automation.staleProposalReminder.enabled}
                disabled={!canEdit}
                onChange={(enabled) =>
                  setAutomation('staleProposalReminder', {
                    ...draft.automation.staleProposalReminder,
                    enabled,
                  })
                }
              />
              {delayInput(
                'staleProposalReminder',
                draft.automation.staleProposalReminder,
                reminderVsLoss ?? undefined,
              )}
            </div>
            <div className="flex flex-col gap-xs">
              <span className="font-body text-caption font-semibold text-neutral-700">
                Contagem dos prazos
              </span>
              {canEdit ? (
                <SegmentedControl
                  aria-label="Contagem dos prazos"
                  value={draft.automation.dayCounting}
                  onChange={(value) => setAutomation('dayCounting', value)}
                  options={[
                    { value: 'calendar', label: 'Dias corridos' },
                    { value: 'business', label: 'Dias úteis' },
                  ]}
                />
              ) : (
                <span className="font-body text-label text-text">
                  {draft.automation.dayCounting === 'calendar' ? 'Dias corridos' : 'Dias úteis'}
                </span>
              )}
            </div>
          </div>
        </Section>

        <Section
          id="travas"
          title="Movimentação manual"
          description="O que uma pessoa pode fazer ao mudar o estágio de uma proposta. Vale já, no pipeline e no modal."
        >
          <div className="flex flex-col gap-md">
            <div className="flex flex-col gap-xs">
              <Toggle
                label="Reabrir propostas Ganhas ou Perdidas"
                checked={draft.manualMoves.reopenClosed.enabled}
                disabled={!canEdit}
                onChange={(checked) =>
                  set((next) => void (next.manualMoves.reopenClosed.enabled = checked))
                }
              />
              <div className="flex flex-wrap items-center gap-md pl-xl">
                <span className="font-body text-caption text-neutral-600">
                  Quem pode (o admin sempre pode):
                </span>
                {(Object.keys(ROLE_LABELS) as RuleActorRole[]).map((r) => (
                  <label
                    key={r}
                    className="flex cursor-pointer items-center gap-xs font-body text-caption text-text"
                  >
                    <input
                      type="checkbox"
                      checked={draft.manualMoves.reopenClosed.roles.includes(r)}
                      disabled={!canEdit || !draft.manualMoves.reopenClosed.enabled}
                      onChange={(e) =>
                        set((next) => {
                          const roles = next.manualMoves.reopenClosed.roles.filter((x) => x !== r);
                          next.manualMoves.reopenClosed.roles = e.target.checked
                            ? [...roles, r]
                            : roles;
                        })
                      }
                    />
                    {ROLE_LABELS[r]}
                  </label>
                ))}
              </div>
            </div>
            <Toggle
              label="Pular etapas (ex.: de Orçamento enviado direto para Ganho)"
              checked={draft.manualMoves.skipStages}
              disabled={!canEdit}
              onChange={(checked) => set((next) => void (next.manualMoves.skipStages = checked))}
            />
            <Toggle
              label="Exigir motivo ao marcar Perdido"
              checked={draft.manualMoves.requireLossReason}
              disabled={!canEdit}
              onChange={(checked) =>
                set((next) => void (next.manualMoves.requireLossReason = checked))
              }
            />
            <Toggle
              label="Gestor pode mover card de outra atendente"
              checked={draft.manualMoves.moveOthersCards}
              disabled={!canEdit}
              onChange={(checked) =>
                set((next) => void (next.manualMoves.moveOthersCards = checked))
              }
            />
          </div>
        </Section>

        <Section
          id="carga-lis"
          title="Carga do LIS"
          description="A carga principal dos orçamentos é a API do Bitlab. Ligue a importação por planilha só se a API estiver fora do ar."
        >
          <Toggle
            label="Permitir importar a planilha do LIS em Resultados"
            checked={draft.lisSource.spreadsheetImport.enabled}
            disabled={!canEdit}
            onChange={(checked) =>
              set((next) => void (next.lisSource.spreadsheetImport.enabled = checked))
            }
          />
        </Section>
        </div>

        <div
          role="tabpanel"
          aria-label={TAB_LABELS.mensagens}
          hidden={activeTab !== 'mensagens'}
          className="space-y-lg"
        >
        <SendMessageSection
          draft={draft}
          canEdit={canEdit}
          fieldErrors={fieldErrors}
          set={set}
        />

        <ReengagementSection
          draft={draft}
          canEdit={canEdit}
          fieldErrors={fieldErrors}
          set={set}
        />

        <ResponseAlertSection
          draft={draft}
          canEdit={canEdit}
          fieldErrors={fieldErrors}
          set={set}
        />

        <FirstContactLimitSection
          draft={draft}
          canEdit={canEdit}
          fieldErrors={fieldErrors}
          set={set}
        />

        </div>

        {canEdit && (
          <div className="flex items-center gap-md">
            <Button
              type="submit"
              variant="primary"
              loading={updateRules.isPending}
              disabled={!patch || blocked}
            >
              Salvar regras
            </Button>
            {!patch && (
              <span className="font-body text-caption text-neutral-600">Nenhuma alteração.</span>
            )}
            {patch && blockedElsewhere && (
              <span role="status" className="font-body text-caption text-accent-700">
                Há um campo a corrigir na aba {TAB_LABELS[blockedElsewhere]}.
              </span>
            )}
          </div>
        )}
      </form>

      <div
        role="tabpanel"
        aria-label={TAB_LABELS.comercial}
        hidden={activeTab !== 'comercial'}
        className="max-w-3xl space-y-lg"
      >
        {data.origin.manualInCrm && (
          <Section
            id="descontos"
            title="Descontos e aprovação"
            description="Vale para as propostas criadas no CRM."
          >
            <p className="font-body text-body text-text">
              Desconto dentro da alçada de quem cria é aprovado na hora. Acima dela, a proposta
              aguarda a aprovação de um gestor antes de ser enviada.
            </p>
            <ul className="space-y-xs font-body text-body text-text">
              <li>Atendente: até {DEFAULT_DISCOUNT_LIMIT.attendant}% (padrão)</li>
              <li>Gestor: até {DEFAULT_DISCOUNT_LIMIT.manager}% (padrão)</li>
              <li>Admin: até {DEFAULT_DISCOUNT_LIMIT.admin}%</li>
            </ul>
            <p className="font-body text-caption text-neutral-600">
              O limite de cada pessoa é ajustado em{' '}
              {role === 'admin' ? (
                <Link to="/settings/users" className="text-accent-700 underline">
                  Usuários &amp; Permissões
                </Link>
              ) : (
                'Usuários & Permissões (admin)'
              )}
              .
            </p>
          </Section>
        )}
        {seesCommissions && <Commissions />}
      </div>

      <div
        role="tabpanel"
        aria-label={TAB_LABELS.feriados}
        hidden={activeTab !== 'feriados'}
        className="max-w-3xl"
      >
        <HolidaysSection canEdit={canEdit} />
      </div>
    </PageContainer>
  );
}
