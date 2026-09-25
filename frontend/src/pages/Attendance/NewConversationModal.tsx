import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { normalizeBrazilianPhone } from '@crm-lab/shared';
import { api, isApiError, mapFieldErrors, queryScopes } from '@/api';
import { Button, Input, TextArea, useToast } from '@/components/ui';
import { Modal } from '@/components/shared';
import { useApiErrorHandler } from '@/hooks';

/**
 * "Nova conversa" (CRMLAB-50, D-175) — PAGES.md §2, coluna 1.
 *
 * Telefone + primeira mensagem → `POST /conversations/whatsapp`. O telefone é
 * validado na hora pela MESMA função do backend (`normalizeBrazilianPhone`),
 * então o que o formulário aceita a API aceita. Número que já tem conversa não
 * duplica: o servidor devolve a existente e é ela que abre.
 *
 * Canal fora do ar (`MESSAGE_SEND_FAILED`): a conversa foi criada e a mensagem
 * ficou `failed` — o modal fecha, a conversa abre mesmo assim e o toast explica.
 */

const MAX_CONTENT = 4000;
const PHONE_HINT = 'DDD + número, ex.: (48) 99999-1234';
const PHONE_INVALID = 'Telefone inválido: informe DDD + número, ex.: (48) 99999-1234';

export interface NewConversationModalProps {
  onClose: () => void;
  /** Conversa criada ou reaproveitada — a tela a abre e seleciona. */
  onStarted: (conversationId: string) => void;
}

export function NewConversationModal({ onClose, onStarted }: NewConversationModalProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const handleApiError = useApiErrorHandler();

  const [phone, setPhone] = useState('');
  const [content, setContent] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [phoneTouched, setPhoneTouched] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);

  const normalizedPhone = normalizeBrazilianPhone(phone);
  const showPhoneError = (submitted || phoneTouched) && normalizedPhone === null;
  const trimmedContent = content.trim();
  const showContentError = submitted && trimmedContent.length === 0;

  const finish = async (conversationId: string) => {
    await queryClient.invalidateQueries({ queryKey: queryScopes.conversations });
    onStarted(conversationId);
    onClose();
  };

  const start = useMutation({
    mutationFn: (body: { phone: string; content: string }) => api.conversations.startWhatsApp(body),
    onSuccess: async (response) => {
      toast('Mensagem enviada.', { tone: 'positive' });
      await finish(response.conversation.id);
    },
    onError: async (error) => {
      if (isApiError(error)) {
        if (error.code === 'MESSAGE_SEND_FAILED') {
          const conversationId = error.details?.conversationId;
          if (typeof conversationId === 'string') {
            toast(
              'A conversa foi criada, mas o WhatsApp não enviou a mensagem. ' +
                'Confira a conexão do canal e reenvie.',
              { tone: 'attention' },
            );
            await finish(conversationId);
            return;
          }
        }
        if (error.code === 'CONVERSATION_ALREADY_ASSIGNED') {
          const owner = error.details?.assignedToName;
          setFormError(
            `Este número já está em atendimento com ${
              typeof owner === 'string' && owner.length > 0 ? owner : 'outra pessoa'
            }.`,
          );
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
    setSubmitted(true);
    setServerErrors({});
    setFormError(null);
    if (normalizedPhone === null || trimmedContent.length === 0) return;
    start.mutate({ phone: normalizedPhone, content: trimmedContent });
  }

  const phoneError = showPhoneError ? PHONE_INVALID : serverErrors.phone;
  const contentError = showContentError ? 'Escreva a primeira mensagem' : serverErrors.content;

  return (
    <Modal
      open
      onClose={onClose}
      title="Nova conversa"
      footer={
        <div className="ml-auto flex gap-md">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="primary"
            onClick={() => handleSubmit()}
            loading={start.isPending}
            disabled={start.isPending}
          >
            Enviar
          </Button>
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-md" noValidate>
        <Input
          label="Telefone (WhatsApp)"
          type="tel"
          inputMode="tel"
          autoComplete="off"
          autoFocus
          placeholder="(48) 99999-1234"
          value={phone}
          maxLength={20}
          onChange={(event) => {
            setPhone(event.target.value);
            setFormError(null);
          }}
          onBlur={() => {
            if (phone.length > 0) setPhoneTouched(true);
          }}
          error={phoneError}
          hint={PHONE_HINT}
        />
        <TextArea
          label="Mensagem"
          rows={4}
          maxLength={MAX_CONTENT}
          placeholder="Olá! Aqui é do laboratório…"
          value={content}
          onChange={(event) => setContent(event.target.value)}
          error={contentError}
        />
        {formError && (
          <p role="alert" className="font-body text-caption text-accent-700">
            {formError}
          </p>
        )}
      </form>
    </Modal>
  );
}
