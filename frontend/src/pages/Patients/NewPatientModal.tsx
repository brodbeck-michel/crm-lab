import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { normalizeBrazilianPhone } from '@crm-lab/shared';
import type { PatientDetail } from '@crm-lab/shared';
import { api, isApiError, mapFieldErrors, queryScopes } from '@/api';
import { PhoneField } from '@/components/patients';
import { Modal } from '@/components/shared';
import { Button, Input, useToast } from '@/components/ui';
import { useApiErrorHandler } from '@/hooks';

/**
 * "Novo contato" — `POST /patients` (CRMLAB-121, D-287).
 *
 * Nome + telefone obrigatórios; CPF e e-mail opcionais. O telefone é validado
 * pela MESMA função do servidor (`normalizeBrazilianPhone`) e o campo sugere o
 * nono dígito quando o celular vem com 8. Telefone já cadastrado (inclusive no
 * outro formato do celular) não duplica: o 409 vira aviso com o link para a
 * ficha existente, quando a pessoa a enxerga.
 */

const PHONE_INVALID = 'Telefone inválido: informe DDD + número, ex.: (48) 99999-1234';

export interface NewPatientModalProps {
  onClose: () => void;
  /** Contato criado — a tela abre a ficha. */
  onCreated: (patient: PatientDetail) => void;
}

export function NewPatientModal({ onClose, onCreated }: NewPatientModalProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const handleApiError = useApiErrorHandler();

  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [document, setDocument] = useState('');
  const [email, setEmail] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [duplicate, setDuplicate] = useState<{ patientId: string | null } | null>(null);

  const normalizedPhone = normalizeBrazilianPhone(phone);
  const trimmedName = name.trim();

  const create = useMutation({
    mutationFn: () =>
      api.patients.create({
        name: trimmedName,
        phone: normalizedPhone ?? phone,
        ...(document.trim().length > 0 ? { document: document.trim() } : {}),
        ...(email.trim().length > 0 ? { email: email.trim() } : {}),
      }),
    onSuccess: async (patient) => {
      await queryClient.invalidateQueries({ queryKey: queryScopes.patients });
      toast('Contato cadastrado.', { tone: 'positive' });
      onCreated(patient);
    },
    onError: (error) => {
      if (isApiError(error)) {
        if (error.code === 'CONFLICT' && error.details?.reason === 'phone_already_in_use') {
          const patientId = error.details.patientId;
          setDuplicate({ patientId: typeof patientId === 'string' ? patientId : null });
          return;
        }
        if (error.code === 'VALIDATION_ERROR') {
          const fields = mapFieldErrors(error.details);
          if (Object.keys(fields).length > 0) {
            setServerErrors(fields);
            return;
          }
        }
      }
      handleApiError(error);
    },
  });

  function handleSubmit(event?: FormEvent) {
    event?.preventDefault();
    if (create.isPending) return;
    setSubmitted(true);
    setServerErrors({});
    setDuplicate(null);
    if (trimmedName.length === 0 || normalizedPhone === null) return;
    create.mutate();
  }

  const nameError = submitted && trimmedName.length === 0 ? 'Informe o nome' : serverErrors.name;
  const phoneError =
    submitted && normalizedPhone === null ? PHONE_INVALID : serverErrors.phone;

  return (
    <Modal
      open
      onClose={onClose}
      title="Novo contato"
      footer={
        <div className="ml-auto flex gap-md">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            onClick={() => handleSubmit()}
            loading={create.isPending}
            disabled={create.isPending}
          >
            Cadastrar
          </Button>
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-md" noValidate>
        <Input
          label="Nome"
          autoFocus
          maxLength={255}
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={nameError}
        />
        <PhoneField
          label="Telefone (WhatsApp)"
          value={phone}
          onChange={(value) => {
            setPhone(value);
            setDuplicate(null);
          }}
          error={phoneError}
          hint="DDD + número. Quando a pessoa escrever, a conversa já chega com este nome."
        />
        <Input
          label="CPF (opcional)"
          inputMode="numeric"
          maxLength={14}
          value={document}
          onChange={(event) => setDocument(event.target.value)}
          error={serverErrors.document}
        />
        <Input
          label="E-mail (opcional)"
          type="email"
          maxLength={255}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={serverErrors.email}
        />
        {duplicate && (
          <p role="alert" className="font-body text-caption text-accent-700">
            Este telefone já está cadastrado.{' '}
            {duplicate.patientId && (
              <Link to={`/patients/${duplicate.patientId}`} className="font-semibold underline">
                Abrir o contato
              </Link>
            )}
          </p>
        )}
      </form>
    </Modal>
  );
}
