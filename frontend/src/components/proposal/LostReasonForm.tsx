import { useState } from 'react';
import type { LossReason } from '@crm-lab/shared';
import { LOSS_REASONS, LOSS_REASON_LABELS } from '@crm-lab/shared';
import { Select, Button } from '@/components/ui';

interface LostReasonFormProps {
  /** `undefined` só quando o motivo não é exigido e ninguém escolheu um. */
  onSubmit: (reason: LossReason | undefined) => void;
  isPending?: boolean;
  /**
   * Regra "Exigir motivo ao marcar Perdido" (CRMLAB-56, D-192). Padrão `true`,
   * o comportamento de antes.
   */
  requireReason?: boolean;
}

export default function LostReasonForm({
  onSubmit,
  isPending = false,
  requireReason = true,
}: LostReasonFormProps) {
  const [reason, setReason] = useState<LossReason | ''>('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (reason !== '') {
      onSubmit(reason);
    } else if (!requireReason) {
      onSubmit(undefined);
    }
  };

  const handleSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setReason(e.target.value as LossReason);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-md">
      <Select
        label={requireReason ? 'Motivo da Perda' : 'Motivo da Perda (opcional)'}
        options={LOSS_REASONS.map((r) => ({
          label: LOSS_REASON_LABELS[r],
          value: r,
        }))}
        placeholder="Selecione o motivo"
        value={reason}
        onChange={handleSelectChange}
        required={requireReason}
      />
      <div className="flex gap-sm">
        <Button
          variant="confirmation"
          type="submit"
          disabled={(requireReason && !reason) || isPending}
        >
          Confirmar
        </Button>
      </div>
    </form>
  );
}
