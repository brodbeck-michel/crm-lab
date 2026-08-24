import { useState } from 'react';
import { LOSS_REASONS, LOSS_REASON_LABELS } from '@crm-lab/shared';
import { Select, Button } from '@/components/ui';

interface LostReasonFormProps {
  onSubmit: (reason: string) => void;
  isPending?: boolean;
}

export default function LostReasonForm({ onSubmit, isPending = false }: LostReasonFormProps) {
  const [reason, setReason] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (reason) {
      onSubmit(reason);
    }
  };

  const handleSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setReason(e.target.value);
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <Select
        label="Motivo da Perda"
        options={LOSS_REASONS.map((r) => ({
          label: LOSS_REASON_LABELS[r],
          value: r,
        }))}
        value={reason}
        onChange={handleSelectChange}
        required
      />
      <div className="flex gap-2">
        <Button
          variant="confirmation"
          type="submit"
          disabled={!reason || isPending}
        >
          Confirmar
        </Button>
      </div>
    </form>
  );
}
