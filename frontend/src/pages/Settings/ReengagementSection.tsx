import { Link } from 'react-router-dom';
import {
  REENGAGEMENT_MESSAGE_MAX,
  REENGAGEMENT_MESSAGE_VARIABLES,
  findUnknownReengagementVariables,
  firstNameOf,
  hasReengagementTextBesidesVariables,
  renderReengagementMessage,
  type FunnelRules,
  type ReengagementStep,
} from '@crm-lab/shared';
import { useChannelSettings } from '@/api/settings';
import { Button, Input, TextArea, Toggle } from '@/components/ui';

/**
 * Seção "Reingajamento da conversa" da página de Regras (PAGES.md §21,
 * CRMLAB-62 — D-211..D-214). Faz parte do formulário das Regras: mexe no
 * `draft` e é salva pelo mesmo `PATCH /settings/funnel-rules`.
 */

const STEPS: ReadonlyArray<{ step: ReengagementStep; label: string; hoursLabel: string }> = [
  {
    step: 'first',
    label: '1º reingajamento: paciente sem responder há X horas',
    hoursLabel: 'Horas sem resposta',
  },
  {
    step: 'second',
    label: '2º reingajamento: Y horas depois do 1º, se continuar sem resposta',
    hoursLabel: 'Horas depois do 1º',
  },
];

/** Nome de exemplo da pré-visualização (D-266) — o mesmo da mensagem de envio. */
const PREVIEW_FIRST_NAME = firstNameOf('Maria Souza');

/** Erro da mensagem na tela, o mesmo que o `PATCH` devolveria (D-266). */
function messageError(message: string): string | undefined {
  if (message.trim() === '') return 'Escreva a mensagem.';
  const unknown = findUnknownReengagementVariables(message);
  if (unknown.length > 0) {
    return `Variável desconhecida: ${unknown.map((name) => `{${name}}`).join(', ')}`;
  }
  if (!hasReengagementTextBesidesVariables(message)) return 'Escreva um texto além de {paciente}';
  return undefined;
}

export interface ReengagementSectionProps {
  draft: FunnelRules;
  canEdit: boolean;
  fieldErrors: Record<string, string>;
  set: (mutate: (next: FunnelRules) => void) => void;
}

/** O canal do WhatsApp está na API oficial? Só gestor/admin leem os canais. */
function useWhatsAppOnCloudApi(enabled: boolean): boolean {
  const { data } = useChannelSettings({ enabled });
  const whatsapp = data?.channels.find((c) => c.channel === 'whatsapp');
  return whatsapp?.connectionMode === 'cloud_api';
}

export function ReengagementSection({ draft, canEdit, fieldErrors, set }: ReengagementSectionProps) {
  const onCloudApi = useWhatsAppOnCloudApi(canEdit);
  const rules = draft.reengagement;

  return (
    <section
      id="reingajamento"
      aria-labelledby="reingajamento-titulo"
      className="space-y-md rounded-lg border border-neutral-200 bg-neutral-100 p-lg"
    >
      <div className="space-y-xs">
        <h2 id="reingajamento-titulo" className="font-heading text-section text-text">
          Reingajamento da conversa
        </h2>
        <p className="font-body text-caption text-neutral-600">
          Quando a atendente responde e o paciente para de responder, o sistema manda sozinho uma
          mensagem para retomar a conversa. Vale só para conversa aberta e só para WhatsApp
          conectado por QR Code. Respeita o horário de funcionamento (
          <Link to="/settings/channels" className="text-accent-700 underline">
            Canais
          </Link>
          ); em feriado, não envia.
        </p>
      </div>

      {onCloudApi && (
        <p
          role="status"
          className="rounded-md border border-neutral-200 bg-bg p-md font-body text-caption text-neutral-700"
        >
          Inativo para este canal: o WhatsApp está conectado pela API oficial da Meta. As regras
          ficam salvas e voltam a valer se o canal for conectado por QR Code.
        </p>
      )}

      <div className="flex flex-col gap-lg">
        {STEPS.map(({ step, label, hoursLabel }) => {
          const rule = rules[step];
          const locked = step === 'second' && !rules.first.enabled;
          const inputsDisabled = !canEdit || !rule.enabled;
          return (
            <div key={step} className="flex flex-col gap-sm">
              <Toggle
                label={label}
                checked={rule.enabled}
                disabled={!canEdit || locked}
                onChange={(enabled) =>
                  set((next) => {
                    next.reengagement[step].enabled = enabled;
                    // O 2º conta a partir do envio do 1º (D-211 item 4).
                    if (step === 'first' && !enabled) next.reengagement.second.enabled = false;
                  })
                }
              />
              {locked && (
                <span className="pl-xl font-body text-caption text-neutral-600">
                  Ligue o 1º reingajamento para usar o 2º.
                </span>
              )}
              <FieldMessage message={fieldErrors[`reengagement.${step}.enabled`]} />
              <div className="flex flex-col gap-sm pl-xl">
                <div className="w-40">
                  <Input
                    type="number"
                    label={hoursLabel}
                    value={String(rule.hours)}
                    min={1}
                    max={720}
                    disabled={inputsDisabled}
                    error={fieldErrors[`reengagement.${step}.hours`]}
                    onChange={(e) => {
                      const parsed = Number.parseInt(e.target.value, 10);
                      const hours = Number.isFinite(parsed) ? parsed : 0;
                      set((next) => void (next.reengagement[step].hours = hours));
                    }}
                  />
                </div>
                <TextArea
                  label="Mensagem"
                  rows={3}
                  maxLength={REENGAGEMENT_MESSAGE_MAX}
                  value={rule.message}
                  disabled={inputsDisabled}
                  error={fieldErrors[`reengagement.${step}.message`] ?? messageError(rule.message)}
                  onChange={(e) => {
                    const message = e.target.value;
                    set((next) => void (next.reengagement[step].message = message));
                  }}
                />
                {canEdit && (
                  <div className="flex flex-wrap gap-sm">
                    {REENGAGEMENT_MESSAGE_VARIABLES.map((name) => (
                      <Button
                        key={name}
                        type="button"
                        variant="secondary"
                        size="sm"
                        disabled={inputsDisabled}
                        onClick={() =>
                          set(
                            (next) =>
                              void (next.reengagement[step].message = `${next.reengagement[step].message}{${name}}`),
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
                    data-testid={`preview-reingajamento-${step}`}
                    className="whitespace-pre-wrap rounded-md border border-neutral-200 bg-bg p-md font-body text-body text-text"
                  >
                    {renderReengagementMessage(rule.message, PREVIEW_FIRST_NAME)}
                  </p>
                  <span className="font-body text-caption text-neutral-600">
                    {'{paciente}'} vira o primeiro nome do paciente; sem nome, some da frase.
                  </span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function FieldMessage({ message }: { message: string | undefined }) {
  if (!message) return null;
  return (
    <span role="alert" className="font-body text-caption text-accent-700">
      {message}
    </span>
  );
}

/** Algo na seção impede salvar? (texto vazio ou inválido — D-266 —, horas fora da faixa) */
export function reengagementBlocked(rules: FunnelRules['reengagement']): boolean {
  return (['first', 'second'] as const).some((step) => {
    const rule = rules[step];
    return messageError(rule.message) !== undefined || rule.hours < 1 || rule.hours > 720;
  });
}
