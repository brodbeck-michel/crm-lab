import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import type { CreateConversationRequest } from '@crm-lab/shared';
import { conversationsApi, queryScopes } from '@/api';
import { useApiErrorHandler } from '@/hooks';
import { Modal } from '@/components/shared';
import { Button, Input, Select } from '@/components/ui';

/**
 * "Novo atendimento" do pipeline (PAGES.md §5) — a porta de entrada de quem
 * NAO chegou pelo WhatsApp: ligacao, balcao, formulario do site.
 *
 * O modal so cria a CONVERSA e leva para `/budget/new`, onde a proposta e
 * montada pelo caminho de sempre. O card so aparece no pipeline quando a
 * proposta existe — proposta e o que o pipeline mostra.
 */

/**
 * Origem -> `conversations.channel`. O enum do contrato tem tres canais
 * manuais; "ligacao" e "presencial" caem os dois em `direct` porque separa-los
 * exigiria coluna nova (decisao do v1).
 */
const ORIGIN_OPTIONS = [
  { value: 'direct', label: 'Ligação / Presencial' },
  { value: 'web', label: 'Site / Formulário' },
  { value: 'sms', label: 'SMS' },
];

interface NewAttendanceModalProps {
  onClose: () => void;
}

export default function NewAttendanceModal({ onClose }: NewAttendanceModalProps) {
  const [form, setForm] = useState({
    patientName: '',
    patientPhone: '',
    patientEmail: '',
    channel: 'direct',
  });

  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const handleApiError = useApiErrorHandler();

  const create = useMutation({
    mutationFn: (body: CreateConversationRequest) => conversationsApi.create(body),
    onSuccess: (conversation) => {
      queryClient.invalidateQueries({ queryKey: queryScopes.conversations });
      onClose();
      navigate(`/budget/new?conversationId=${conversation.id}`);
    },
    onError: handleApiError,
  });

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    create.mutate({
      patientName: form.patientName.trim(),
      patientPhone: form.patientPhone.trim(),
      patientEmail: form.patientEmail.trim() || null,
      channel: form.channel as CreateConversationRequest['channel'],
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Novo atendimento"
      footer={
        <div className="flex gap-md ml-auto">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            onClick={handleSubmit}
            disabled={create.isPending}
            loading={create.isPending}
          >
            Criar e montar orçamento
          </Button>
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-md">
        <Input
          label="Nome do paciente"
          value={form.patientName}
          onChange={(e) => setForm({ ...form, patientName: e.target.value })}
          required
        />

        <Input
          label="Telefone"
          type="tel"
          placeholder="(48) 99999-1234"
          hint="Se já houver atendimento neste número, ele é reaproveitado."
          value={form.patientPhone}
          onChange={(e) => setForm({ ...form, patientPhone: e.target.value })}
          required
        />

        <Input
          label="E-mail (opcional)"
          type="email"
          value={form.patientEmail}
          onChange={(e) => setForm({ ...form, patientEmail: e.target.value })}
        />

        <Select
          label="Origem"
          options={ORIGIN_OPTIONS}
          value={form.channel}
          onChange={(e) => setForm({ ...form, channel: e.target.value })}
        />
      </form>
    </Modal>
  );
}
