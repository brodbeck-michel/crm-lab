import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  DEFAULT_DISCOUNT_LIMIT,
  SEND_MESSAGE_TEMPLATE_MAX,
  SEND_MESSAGE_VARIABLES,
  findUnknownTemplateVariables,
  renderSendMessageTemplate,
  type DelayRule,
  type FunnelAutomationRules,
  type FunnelRules,
  type RuleActorRole,
  type UpdateFunnelRulesRequest,
} from '@crm-lab/shared';
import { useFunnelRules, useUpdateFunnelRules } from '@/api/funnel-rules';
import { useAuthStore } from '@/stores/auth.store';
import { PageContainer, PageHeader } from '@/components/layout';
import { Button, Input, SegmentedControl, TextArea, Toggle, useToast } from '@/components/ui';
import { formatMoney } from '@/lib/format';
import Commissions from './Commissions';

/**
 * Regras (`/settings/rules`) — PAGES.md §21, CRMLAB-56 (D-190..D-194).
 *
 * Seções 1–4 são um formulário só, salvo em `PATCH /settings/funnel-rules`
 * com SÓ o que mudou. A seção 5 (desconto) aparece com "Criar pelo CRM"
 * ligado (valor salvo). A 6 é o formulário de comissão, com endpoint e
 * permissão próprios (admin edita). Atendente vê tudo desabilitado.
 */

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

const PREVIEW_VALUES = {
  paciente: 'Maria Souza',
  numero_orcamento: '70034',
  valor: formatMoney(179.8),
  convenio: 'Particular',
} as const;

const ROLE_LABELS: Record<RuleActorRole, string> = {
  attendant: 'Atendente',
  manager: 'Gestor',
};

type DelayKey = 'sentToFollowUp' | 'negotiationToFollowUp' | 'followUpToLost';

const DELAY_RULES: ReadonlyArray<{ key: DelayKey; label: string }> = [
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
      className="space-y-md rounded-lg border border-neutral-200 bg-surface p-lg"
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

  useEffect(() => {
    if (data) setDraft(JSON.parse(JSON.stringify(data)) as FunnelRules);
  }, [data]);

  // `/settings/commissions` redireciona para `#comissoes` (D-194).
  useEffect(() => {
    if (location.hash === '' || draft === null) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView?.({ block: 'start' });
  }, [location.hash, draft]);

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

  const unknownVariables = findUnknownTemplateVariables(draft.sendMessage.template);
  const templateError =
    fieldErrors['sendMessage.template'] ??
    (unknownVariables.length > 0
      ? `Variável desconhecida: ${unknownVariables.map((name) => `{${name}}`).join(', ')}`
      : undefined);
  const noOrigin = !draft.origin.fromBitlab && !draft.origin.manualInCrm;
  const blocked =
    noOrigin || unknownVariables.length > 0 || draft.sendMessage.template.trim() === '';

  function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (!patch || blocked) return;
    setFieldErrors({});
    updateRules.mutate(patch, {
      onSuccess: () => toast('Regras atualizadas.', { tone: 'positive' }),
      onError: (err) => {
        const fields = (err as { details?: { fields?: Record<string, string> } })?.details?.fields;
        setFieldErrors(fields ?? {});
        toast(fields ? 'Confira os campos destacados.' : 'Não foi possível salvar as regras.', {
          tone: 'attention',
        });
      },
    });
  }

  const delayInput = (
    key: DelayKey | 'staleNewBudgetAlert',
    rule: DelayRule | { enabled: boolean; hours: number },
  ) => {
    const unit = 'days' in rule ? 'days' : 'hours';
    const path = `automation.${key}.${unit}`;
    const value = 'days' in rule ? rule.days : rule.hours;
    return (
      <div className="w-32">
        <Input
          type="number"
          aria-label={unit === 'days' ? 'Dias' : 'Horas'}
          value={String(value)}
          min={1}
          max={unit === 'days' ? 365 : 720}
          disabled={!canEdit || !rule.enabled}
          error={fieldErrors[path]}
          onChange={(e) => {
            const parsed = Number.parseInt(e.target.value, 10);
            const n = Number.isFinite(parsed) ? parsed : 0;
            set((next) => {
              const target = next.automation[key] as unknown as Json;
              target[unit] = n;
            });
          }}
        />
      </div>
    );
  };

  return (
    <PageContainer>
      <PageHeader
        title="Regras"
        description="Como as propostas nascem, andam pelo funil e são enviadas neste laboratório."
      />

      <form onSubmit={handleSave} className="max-w-3xl space-y-lg">
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
          description="O que o sistema faz sozinho. As automações passam a rodar quando o motor do funil entrar no ar."
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
                label='Alerta de "Novo orçamento" parado há N horas sem envio'
                checked={draft.automation.staleNewBudgetAlert.enabled}
                disabled={!canEdit}
                onChange={(enabled) =>
                  setAutomation('staleNewBudgetAlert', {
                    ...draft.automation.staleNewBudgetAlert,
                    enabled,
                  })
                }
              />
              {delayInput('staleNewBudgetAlert', draft.automation.staleNewBudgetAlert)}
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
          id="mensagem"
          title="Mensagem de envio"
          description="Texto do WhatsApp ao enviar o orçamento. Use as variáveis abaixo."
        >
          <TextArea
            label="Modelo da mensagem"
            rows={4}
            maxLength={SEND_MESSAGE_TEMPLATE_MAX}
            value={draft.sendMessage.template}
            disabled={!canEdit}
            error={templateError}
            onChange={(e) => {
              const template = e.target.value;
              set((next) => void (next.sendMessage.template = template));
            }}
          />
          {canEdit && (
            <div className="flex flex-wrap gap-sm">
              {SEND_MESSAGE_VARIABLES.map((name) => (
                <Button
                  key={name}
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    set(
                      (next) =>
                        void (next.sendMessage.template = `${next.sendMessage.template}{${name}}`),
                    )
                  }
                >
                  {`{${name}}`}
                </Button>
              ))}
            </div>
          )}
          <div className="space-y-xs">
            <span className="font-body text-caption font-semibold text-neutral-700">
              Pré-visualização
            </span>
            <p
              data-testid="preview-mensagem"
              className="whitespace-pre-wrap rounded-md bg-neutral-100 p-md font-body text-body text-text"
            >
              {renderSendMessageTemplate(draft.sendMessage.template, PREVIEW_VALUES)}
            </p>
          </div>
        </Section>

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
          </div>
        )}
      </form>

      {seesCommissions && (
        <div className="mt-lg max-w-3xl">
          <Commissions />
        </div>
      )}
    </PageContainer>
  );
}
