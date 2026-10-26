import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { normalizeBrazilianPhone } from '@crm-lab/shared';
import { api, isApiError, mapFieldErrors, queryScopes } from '@/api';
import { PhoneField } from '@/components/patients';
import { Button, TextArea, useToast } from '@/components/ui';
import { Modal } from '@/components/shared';
import { useApiErrorHandler } from '@/hooks';
import { formatBrazilianPhone } from '@/lib/phone-suggestion';
import { ContactSearch } from './ContactSearch';

/**
 * "Nova conversa" (CRMLAB-50, D-175) — PAGES.md §2, coluna 1.
 *
 * Telefone + primeira mensagem → `POST /conversations/whatsapp`. O telefone é
 * validado na hora pela MESMA função do backend (`normalizeBrazilianPhone`),
 * então o que o formulário aceita a API aceita. Número que já tem conversa não
 * duplica: o servidor devolve a existente e é ela que abre.
 *
 * Também dá para achar o contato pelo nome (CRMLAB-121, D-287): a busca
 * preenche o telefone, e o campo sugere o nono dígito quando o celular vem
 * com 8.
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
  /** Telefone já preenchido — "Conversar" do cartão de contato (CRMLAB-70, D-236). */
  initialPhone?: string;
}

export function NewConversationModal({
  onClose,
  onStarted,
  initialPhone,
}: NewConversationModalProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const handleApiError = useApiErrorHandler();

  const [phone, setPhone] = useState(initialPhone ?? '');
  /** Nome do contato escolhido na busca; some se o telefone for editado. */
  const [contactName, setContactName] = useState<string | null>(null);
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
    // Enter no telefone submete o form mesmo com o "Enviar" desabilitado: sem
    // este guard, dois Enter rápidos mandariam a mensagem duas vezes.
    if (start.isPending) return;
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
      {/* A busca fica FORA do form: com um segundo campo dentro, o Enter no
          telefone deixaria de enviar (submissão implícita só com um campo). */}
      {!initialPhone && (
        <div className="mb-md">
          <ContactSearch
            onPick={(contact) => {
              setPhone(formatBrazilianPhone(contact.phone));
              setContactName(contact.name);
              setPhoneTouched(true);
              setFormError(null);
            }}
          />
        </div>
      )}
      <form onSubmit={handleSubmit} className="flex flex-col gap-md" noValidate>
        {contactName && (
          <p className="font-body text-caption text-text">
            Para: <strong>{contactName}</strong>
          </p>
        )}
        <PhoneField
          label="Telefone (WhatsApp)"
          value={phone}
          onChange={(value) => {
            setPhone(value);
            setContactName(null);
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
          autoFocus={Boolean(initialPhone)}
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
