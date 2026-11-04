import {
  FIRST_CONTACT_PER_HOUR_MAX,
  FIRST_CONTACT_PER_HOUR_MIN,
  type FunnelRules,
} from '@crm-lab/shared';
import { Input, Toggle } from '@/components/ui';

/**
 * Seção "Primeiros contatos no WhatsApp" da página de Regras (PAGES.md §21,
 * CRMLAB-134 — D-306). Faz parte do formulário das Regras: mexe no `draft` e é
 * salva pelo mesmo `PATCH /settings/funnel-rules`. Quem recusa o envio é o
 * servidor; aqui só se liga e se escolhe o teto.
 */

export interface FirstContactLimitSectionProps {
  draft: FunnelRules;
  canEdit: boolean;
  fieldErrors: Record<string, string>;
  set: (mutate: (next: FunnelRules) => void) => void;
}

function perHourOutOfRange(perHour: number): boolean {
  return (
    !Number.isInteger(perHour) ||
    perHour < FIRST_CONTACT_PER_HOUR_MIN ||
    perHour > FIRST_CONTACT_PER_HOUR_MAX
  );
}

export function FirstContactLimitSection({
  draft,
  canEdit,
  fieldErrors,
  set,
}: FirstContactLimitSectionProps) {
  const rule = draft.firstContactLimit;
  const rangeMessage = `Informe um número inteiro de ${FIRST_CONTACT_PER_HOUR_MIN} a ${FIRST_CONTACT_PER_HOUR_MAX}`;

  return (
    <section
      id="primeiro-contato"
      aria-labelledby="primeiro-contato-titulo"
      className="space-y-md rounded-lg border border-neutral-200 bg-neutral-100 p-lg"
    >
      <div className="space-y-xs">
        <h2 id="primeiro-contato-titulo" className="font-heading text-section text-text">
          Primeiros contatos no WhatsApp
        </h2>
        <p className="font-body text-caption text-neutral-600">
          Primeiro contato é mandar mensagem para quem nunca escreveu ao laboratório. Muitos em
          pouco tempo fazem o WhatsApp restringir o número (vale para a conexão por QR). Com a trava
          ligada, acima do limite da última hora o envio é recusado e a atendente vê a partir de que
          horas pode tentar de novo. Conversa em que o paciente já escreveu nunca é barrada.
        </p>
      </div>

      <div className="flex flex-col gap-sm">
        <Toggle
          label="Limitar primeiros contatos por hora"
          checked={rule.enabled}
          disabled={!canEdit}
          onChange={(enabled) => set((next) => void (next.firstContactLimit.enabled = enabled))}
        />
        <div className="w-40 pl-xl">
          <Input
            type="number"
            label="Máximo por hora"
            value={String(rule.perHour)}
            min={FIRST_CONTACT_PER_HOUR_MIN}
            max={FIRST_CONTACT_PER_HOUR_MAX}
            disabled={!canEdit || !rule.enabled}
            error={
              fieldErrors['firstContactLimit.perHour'] ??
              (perHourOutOfRange(rule.perHour) ? rangeMessage : undefined)
            }
            onChange={(e) => {
              const parsed = Number.parseInt(e.target.value, 10);
              const perHour = Number.isFinite(parsed) ? parsed : 0;
              set((next) => void (next.firstContactLimit.perHour = perHour));
            }}
          />
        </div>
      </div>
    </section>
  );
}

/** Algo na seção impede salvar? (máximo fora da faixa) */
export function firstContactLimitBlocked(rule: FunnelRules['firstContactLimit']): boolean {
  return perHourOutOfRange(rule.perHour);
}
