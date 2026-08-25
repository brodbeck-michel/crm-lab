import { useCallback, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AnonymizePatientResponse, PatientDetail, PatientExport } from '@crm-lab/shared';
import { isApiError } from '@/api/client';
import { patientsApi } from '@/api/patients';
import { queryScopes } from '@/api/query-keys';
import { Modal } from '@/components/shared';
import { Button, TextArea } from '@/components/ui';
import { useAuthStore } from '@/stores';

/**
 * Seção LGPD — `GET /patients/:id/export` e `POST /patients/:id/anonymize`
 * (API_CONTRACTS.md §2c, D-062 e D-063). **Admin apenas.**
 *
 * Quem não é admin não vê a seção E a tela não dispara requisição nenhuma:
 * as duas chamadas são mutações disparadas por clique, e sem seção não há
 * clique. É o mesmo padrão do Console da Plataforma — a UI esconde, o
 * servidor recusa (403 com `details.requiredRoles: ["admin"]`).
 *
 * A anonimização é IRREVERSÍVEL. Por isso a consequência está escrita na tela,
 * não só no botão, e o confirmar exige duas coisas: o motivo do titular (vai
 * para o audit log) e o aceite explícito do que vai acontecer.
 */

export interface PatientLgpdSectionProps {
  patient: PatientDetail;
}

/**
 * Entrega o dump como arquivo. O contrato manda `Content-Disposition:
 * attachment`, mas o client lê JSON tipado — quem materializa o arquivo é a
 * tela, com o mesmo nome que o servidor propõe.
 */
function downloadExport(patientId: string, data: PatientExport): void {
  if (typeof URL.createObjectURL !== 'function') return;
  const day = data.generatedAt.slice(0, 10).replace(/-/g, '');
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const href = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = href;
  link.download = `paciente-${patientId}-${day}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(href);
}

export function PatientLgpdSection({ patient }: PatientLgpdSectionProps) {
  const role = useAuthStore((state) => state.user?.role);
  const queryClient = useQueryClient();

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [accepted, setAccepted] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [anonymizeError, setAnonymizeError] = useState<string | null>(null);
  const [anonymizeResult, setAnonymizeResult] = useState<AnonymizePatientResponse | null>(null);

  const closeConfirm = useCallback(() => {
    setConfirmOpen(false);
    setReason('');
    setAccepted(false);
    setAnonymizeError(null);
  }, []);

  const exportData = useMutation({
    mutationFn: () => patientsApi.export(patient.id),
    onSuccess: (data) => {
      setExportError(null);
      downloadExport(patient.id, data);
    },
    onError: (error: unknown) => {
      setExportError(
        isApiError(error) ? error.message : 'Não foi possível gerar a exportação. Tente novamente.',
      );
    },
  });

  const anonymize = useMutation({
    mutationFn: (body: { reason: string }) => patientsApi.anonymize(patient.id, body),
    onSuccess: (data) => {
      setAnonymizeResult(data);
      void queryClient.invalidateQueries({ queryKey: queryScopes.patient });
      void queryClient.invalidateQueries({ queryKey: queryScopes.conversations });
      closeConfirm();
    },
    onError: (error: unknown) => {
      setAnonymizeError(
        isApiError(error) ? error.message : 'Não foi possível anonimizar. Tente novamente.',
      );
    },
  });

  /**
   * Não-admin não vê a seção — e, por consequência, nenhuma requisição sai:
   * export e anonimização são MUTAÇÕES, que só disparam por clique num botão
   * que aqui nem chega a existir. (Os `useMutation` acima são declarações
   * inertes; a regra dos hooks obriga que venham antes deste retorno.)
   */
  if (role !== 'admin') return null;

  const alreadyAnonymized = patient.anonymizedAt !== null;

  return (
    <section
      aria-labelledby="patient-lgpd-heading"
      className="flex flex-col gap-md rounded-md border border-neutral-300 bg-neutral-100 px-lg py-md"
    >
      <div className="flex flex-col gap-xs">
        <h2 id="patient-lgpd-heading" className="m-0 font-heading text-section text-text">
          Dados pessoais (LGPD)
        </h2>
        <p className="m-0 font-body text-caption text-neutral-600">
          Disponível apenas para administradores. As duas ações ficam registradas no log de
          auditoria do laboratório.
        </p>
      </div>

      <div className="flex flex-col gap-sm">
        <h3 className="m-0 font-body text-label font-semibold text-text">Exportar dados</h3>
        <p className="m-0 font-body text-caption text-neutral-600">
          Baixa um arquivo JSON com o cadastro, as conversas, as mensagens e os orçamentos do
          titular — inclusive o que não aparece na sua visão da ficha.
        </p>
        <div className="flex flex-wrap items-center gap-sm">
          <Button
            variant="secondary"
            loading={exportData.isPending}
            onClick={() => exportData.mutate()}
          >
            Exportar dados do paciente
          </Button>
          {exportData.isSuccess && !exportData.isPending && (
            <span role="status" className="font-body text-caption text-accent2-800">
              Exportação gerada.
            </span>
          )}
        </div>
        {exportError && (
          <p role="alert" className="m-0 font-body text-caption text-accent-700">
            {exportError}
          </p>
        )}
      </div>

      <div className="flex flex-col gap-sm">
        <h3 className="m-0 font-body text-label font-semibold text-text">Anonimizar cadastro</h3>

        {alreadyAnonymized ? (
          <p className="m-0 font-body text-caption text-neutral-600">
            Este cadastro já foi anonimizado. Repetir o pedido não muda nada — a operação é
            idempotente.
          </p>
        ) : (
          <ul className="m-0 flex list-disc flex-col gap-xs pl-lg font-body text-caption text-neutral-700">
            <li>Nome, e-mail, data de nascimento, CPF, anotações, etiquetas e campos são apagados.</li>
            <li>O telefone é substituído por um identificador anônimo e o nome some do inbox.</li>
            <li>Orçamentos, mensagens e auditoria permanecem, sem o nome do paciente.</li>
            <li>
              O conteúdo já escrito nas mensagens não é reescrito — se ele contiver o nome, o nome
              continua lá.
            </li>
            <li>Depois disso o cadastro não pode mais ser editado. Não há como desfazer.</li>
          </ul>
        )}

        <div className="flex flex-wrap items-center gap-sm">
          <Button
            variant="destructive"
            disabled={alreadyAnonymized}
            onClick={() => setConfirmOpen(true)}
          >
            Anonimizar cadastro
          </Button>
          {anonymizeResult && (
            <span role="status" className="font-body text-caption text-accent2-800">
              Cadastro anonimizado · {anonymizeResult.conversationsAffected} conversa(s) atualizada(s).
            </span>
          )}
        </div>
      </div>

      <Modal
        open={confirmOpen}
        onClose={closeConfirm}
        title="Anonimizar cadastro do paciente"
        footer={
          <>
            <Button variant="secondary" onClick={closeConfirm} disabled={anonymize.isPending}>
              Cancelar
            </Button>
            <Button
              variant="destructive"
              disabled={reason.trim().length === 0 || !accepted}
              loading={anonymize.isPending}
              onClick={() => anonymize.mutate({ reason: reason.trim() })}
            >
              Confirmar anonimização
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-md">
          <p className="m-0 font-body text-body text-text">
            Esta ação é <strong>irreversível</strong>. O cadastro de{' '}
            {patient.name ?? 'paciente sem nome'} será esvaziado, o telefone {patient.phone} será
            substituído por um identificador anônimo e o nome deixará de aparecer no inbox. Os
            orçamentos e o histórico permanecem, sem o nome.
          </p>

          <TextArea
            label="Motivo do pedido do titular"
            rows={3}
            maxLength={500}
            value={reason}
            hint="Obrigatório, até 500 caracteres. Fica registrado no log de auditoria."
            onChange={(event) => setReason(event.target.value)}
          />

          <label className="flex cursor-pointer items-start gap-sm font-body text-caption text-text">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(event) => setAccepted(event.target.checked)}
            />
            <span>
              Entendi que a anonimização é definitiva e que não existe forma de recuperar estes
              dados.
            </span>
          </label>

          {anonymizeError && (
            <p role="alert" className="m-0 font-body text-caption text-accent-700">
              {anonymizeError}
            </p>
          )}
        </div>
      </Modal>
    </section>
  );
}

export default PatientLgpdSection;
