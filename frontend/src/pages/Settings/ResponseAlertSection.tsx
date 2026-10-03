import { Link } from 'react-router-dom';
import {
  RESPONSE_ALERT_MINUTES_MAX,
  RESPONSE_ALERT_MINUTES_MIN,
  type FunnelRules,
} from '@crm-lab/shared';
import { Input, Toggle } from '@/components/ui';

/**
 * Seção "Alerta de tempo de resposta" da página de Regras (PAGES.md §21,
 * CRMLAB-84 — D-254). O inverso do reingajamento, logo depois dele. Faz parte
 * do formulário das Regras: mexe no `draft` e é salva pelo mesmo
 * `PATCH /settings/funnel-rules`. Só visual: não envia nada ao paciente.
 */

export interface ResponseAlertSectionProps {
  draft: FunnelRules;
  canEdit: boolean;
  fieldErrors: Record<string, string>;
  set: (mutate: (next: FunnelRules) => void) => void;
}

function minutesOutOfRange(minutes: number): boolean {
  return (
    !Number.isInteger(minutes) ||
    minutes < RESPONSE_ALERT_MINUTES_MIN ||
    minutes > RESPONSE_ALERT_MINUTES_MAX
  );
}

export function ResponseAlertSection({ draft, canEdit, fieldErrors, set }: ResponseAlertSectionProps) {
  const rule = draft.responseAlert;
  const rangeMessage = `Informe um número inteiro de ${RESPONSE_ALERT_MINUTES_MIN} a ${RESPONSE_ALERT_MINUTES_MAX}`;

  return (
    <section
      id="alerta-resposta"
      aria-labelledby="alerta-resposta-titulo"
      className="space-y-md rounded-lg border border-neutral-200 bg-neutral-100 p-lg"
    >
      <div className="space-y-xs">
        <h2 id="alerta-resposta-titulo" className="font-heading text-section text-text">
          Alerta de tempo de resposta
        </h2>
        <p className="font-body text-caption text-neutral-600">
          Destaca em vermelho, na lista do Atendimento, o paciente que escreveu e está esperando a
          atendente responder há X minutos ou mais. Só destaca: nada é enviado ao paciente. O tempo
          conta só no horário de funcionamento (
          <Link to="/settings/channels" className="text-accent-700 underline">
            Canais
          </Link>
          ) e não conta nos feriados. Mensagem automática não conta como resposta; conversa
          encerrada não entra.
        </p>
      </div>

      <div className="flex flex-col gap-sm">
        <Toggle
          label="Destacar paciente sem resposta há X minutos"
          checked={rule.enabled}
          disabled={!canEdit}
          onChange={(enabled) => set((next) => void (next.responseAlert.enabled = enabled))}
        />
        <div className="w-40 pl-xl">
          <Input
            type="number"
            label="Minutos sem resposta"
            value={String(rule.minutes)}
            min={RESPONSE_ALERT_MINUTES_MIN}
            max={RESPONSE_ALERT_MINUTES_MAX}
            disabled={!canEdit || !rule.enabled}
            error={
              fieldErrors['responseAlert.minutes'] ??
              (minutesOutOfRange(rule.minutes) ? rangeMessage : undefined)
            }
            onChange={(e) => {
              const parsed = Number.parseInt(e.target.value, 10);
              const minutes = Number.isFinite(parsed) ? parsed : 0;
              set((next) => void (next.responseAlert.minutes = minutes));
            }}
          />
        </div>
      </div>
    </section>
  );
}

/** Algo na seção impede salvar? (minutos fora da faixa) */
export function responseAlertBlocked(rule: FunnelRules['responseAlert']): boolean {
  return minutesOutOfRange(rule.minutes);
}
