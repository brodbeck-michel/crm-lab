import { useState } from 'react';
import { usePurgeLisBudgets } from '@/api/lis';
import { useToast, Button, Input } from '@/components/ui';
import { Modal } from '@/components/shared';

const CONFIRM_TEXT = 'LIMPAR';

export interface PurgeDialogProps {
  onClose: () => void;
}

/**
 * "Limpar base" — admin apenas (PAGES.md §14). Exige digitar `LIMPAR` antes
 * de habilitar o botão, mesma barreira do servidor (`POST /lis-imports/purge
 * { confirm: "LIMPAR" }`, D-109) — irreversível, então a UI espelha a
 * barreira de propósito.
 */
export function PurgeDialog({ onClose }: PurgeDialogProps) {
  const { toast } = useToast();
  const purge = usePurgeLisBudgets();
  const [confirmText, setConfirmText] = useState('');

  const canConfirm = confirmText === CONFIRM_TEXT;

  function handleConfirm() {
    if (!canConfirm) return;
    purge.mutate(
      { confirm: confirmText },
      {
        onSuccess: () => {
          toast('Base de orçamentos do LIS apagada.', { tone: 'neutral' });
          onClose();
        },
        onError: () => toast('Não foi possível limpar a base.', { tone: 'attention' }),
      },
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Limpar base de orçamentos do LIS"
      footer={
        <div className="flex gap-md ml-auto">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="destructive"
            disabled={!canConfirm || purge.isPending}
            loading={purge.isPending}
            onClick={handleConfirm}
          >
            Apagar tudo
          </Button>
        </div>
      }
    >
      <div className="space-y-md">
        <p className="font-body text-body text-neutral-800">
          Esta ação apaga <strong>todos</strong> os orçamentos do LIS importados deste
          laboratório. É irreversível.
        </p>
        <Input
          label={`Digite ${CONFIRM_TEXT} para confirmar`}
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
        />
      </div>
    </Modal>
  );
}
