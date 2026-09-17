import { useCallback, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PatientDetail } from '@crm-lab/shared';
import { isApiError } from '@/api/client';
import { patientsApi } from '@/api/patients';
import { queryScopes } from '@/api/query-keys';
import { Modal } from '@/components/shared';
import { Button, TextArea } from '@/components/ui';

/**
 * Inativar/reativar cadastro — `POST /patients/:id/inactivate` e
 * `.../reactivate` (API_CONTRACTS.md §2c, D-132, CRMLAB-11).
 *
 * Ao contrário da seção LGPD, esta ação é de **qualquer papel de laboratório**
 * (mesma alçada do `PATCH /:id`) — não há checagem de `admin` aqui.
 *
 * Os dados do paciente continuam intactos: inativar só marca o cadastro e
 * some da listagem por padrão (checkbox "Mostrar inativos" em `/patients`).
 */

export interface PatientInactivationSectionProps {
  patient: PatientDetail;
}

export function PatientInactivationSection({ patient }: PatientInactivationSectionProps) {
  const queryClient = useQueryClient();
  const isInactive = patient.inactivatedAt !== null;

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const closeConfirm = useCallback(() => {
    setConfirmOpen(false);
    setReason('');
    setError(null);
  }, []);

  const invalidate = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: queryScopes.patient });
    void queryClient.invalidateQueries({ queryKey: queryScopes.patients });
  }, [queryClient]);

  const inactivate = useMutation({
    mutationFn: (body: { reason: string }) => patientsApi.inactivate(patient.id, body),
    onSuccess: () => {
      invalidate();
      closeConfirm();
    },
    onError: (err: unknown) => {
      setError(isApiError(err) ? err.message : 'Não foi possível inativar. Tente novamente.');
    },
  });

  const reactivate = useMutation({
    mutationFn: (body: { reason: string }) => patientsApi.reactivate(patient.id, body),
    onSuccess: () => {
      invalidate();
      closeConfirm();
    },
    onError: (err: unknown) => {
      setError(isApiError(err) ? err.message : 'Não foi possível reativar. Tente novamente.');
    },
  });

  const pending = isInactive ? reactivate : inactivate;

  return (
    <section
      aria-labelledby="patient-inactivation-heading"
      className="flex flex-col gap-sm rounded-md border border-neutral-300 bg-neutral-100 px-lg py-md"
    >
      <div className="flex flex-col gap-xs">
        <h2 id="patient-inactivation-heading" className="m-0 font-heading text-section text-text">
          Status do cadastro
        </h2>
        {isInactive ? (
          <p className="m-0 font-body text-caption text-neutral-600">
            Paciente inativo desde{' '}
            {patient.inactivationReason ? `— motivo: "${patient.inactivationReason}"` : ''}. Some
            das listagens até ser reativado.
          </p>
        ) : (
          <p className="m-0 font-body text-caption text-neutral-600">
            Inativar some o paciente das listagens por padrão. Orçamentos, conversas e histórico
            permanecem intactos.
          </p>
        )}
      </div>

      <div>
        <Button
          variant={isInactive ? 'secondary' : 'destructive'}
          onClick={() => setConfirmOpen(true)}
        >
          {isInactive ? 'Reativar paciente' : 'Inativar paciente'}
        </Button>
      </div>

      <Modal
        open={confirmOpen}
        onClose={closeConfirm}
        title={isInactive ? 'Reativar cadastro do paciente' : 'Inativar cadastro do paciente'}
        footer={
          <>
            <Button variant="secondary" onClick={closeConfirm} disabled={pending.isPending}>
              Cancelar
            </Button>
            <Button
              variant={isInactive ? 'primary' : 'destructive'}
              disabled={reason.trim().length === 0}
              loading={pending.isPending}
              onClick={() => pending.mutate({ reason: reason.trim() })}
            >
              {isInactive ? 'Confirmar reativação' : 'Confirmar inativação'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-md">
          <p className="m-0 font-body text-body text-text">
            {isInactive
              ? `${patient.name ?? 'O paciente'} volta a aparecer nas listagens.`
              : `${patient.name ?? 'O paciente'} deixa de aparecer nas listagens (fica acessível pelo checkbox "Mostrar inativos" ou por link direto).`}
          </p>

          <TextArea
            label={isInactive ? 'Justificativa da reativação' : 'Motivo da inativação'}
            rows={3}
            maxLength={500}
            value={reason}
            hint="Obrigatório, até 500 caracteres. Fica registrado no log de auditoria."
            onChange={(event) => setReason(event.target.value)}
          />

          {error && (
            <p role="alert" className="m-0 font-body text-caption text-accent-700">
              {error}
            </p>
          )}
        </div>
      </Modal>
    </section>
  );
}

export default PatientInactivationSection;
