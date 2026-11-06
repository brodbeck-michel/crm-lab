import { useState } from 'react';
import type { FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { normalizeBrazilianPhone, type StartWhatsAppConversationRequest } from '@crm-lab/shared';
import {
  api,
  firstContactLimitMessage,
  isApiError,
  mapFieldErrors,
  queryKeys,
  queryScopes,
  useWhatsAppTemplates,
} from '@/api';
import {
  EMPTY_TEMPLATE_DRAFT,
  TemplatePicker,
  templateRequestOf,
  type TemplateDraft,
} from '@/components/conversation';
import { PhoneField } from '@/components/patients';
import { Button, SegmentedControl, TextArea, useToast } from '@/components/ui';
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
  // CRMLAB-136 (D-309): com modelos aprovados (Cloud API), o primeiro contato
  // sai por modelo — é o padrão. Em QR a lista vem vazia e só há texto.
  const templatesQuery = useWhatsAppTemplates();
  const templates = templatesQuery.data?.templates ?? [];
  // `null` = a pessoa ainda não escolheu: com modelos, o padrão é "Modelo
  // aprovado" — mas só se nada foi digitado (a lista que chega depois não
  // esconde o texto já escrito). O campo de texto aparece logo, sem esperar a lista.
  const [chosenKind, setChosenKind] = useState<'template' | 'text' | null>(null);
  const [templateDraft, setTemplateDraft] = useState<TemplateDraft>(EMPTY_TEMPLATE_DRAFT);
  const kind = chosenKind ?? (content.trim() === '' ? 'template' : 'text');
  const byTemplate = templates.length > 0 && kind === 'template';

  const normalizedPhone = normalizeBrazilianPhone(phone);
  const showPhoneError = (submitted || phoneTouched) && normalizedPhone === null;
  const trimmedContent = content.trim();
  const showContentError = !byTemplate && submitted && trimmedContent.length === 0;

  const finish = async (conversationId: string) => {
    await queryClient.invalidateQueries({ queryKey: queryScopes.conversations });
    onStarted(conversationId);
    onClose();
  };

  const start = useMutation({
    mutationFn: (body: StartWhatsAppConversationRequest) => api.conversations.startWhatsApp(body),
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
        if (
          error.code === 'CHANNEL_CLOUD_API_NOT_CONFIGURED' ||
          error.code === 'CHANNEL_CLOUD_API_UNAVAILABLE'
        ) {
          // D-308: a conversa ficou criada, sem mensagem; falta credencial da
          // API oficial (ou a instalação não tem a API). Aviso no modal, como o
          // teto de D-306.
          // Só houve criação com `conversationId` e `created !== false`; sem
          // `conversationId` (modelo conferido antes de criar, CRMLAB-136) nada existe.
          const createdNow =
            typeof error.details?.conversationId === 'string' && error.details?.created !== false;
          const prefix = createdNow ? 'A conversa foi criada' : 'Nada foi enviado';
          setFormError(
            error.code === 'CHANNEL_CLOUD_API_NOT_CONFIGURED'
              ? `${prefix}, mas a API oficial do WhatsApp ainda não está configurada ` +
                  'neste laboratório. Peça ao administrador para completar em Canais.'
              : error.details?.reason === 'meta_unreachable'
                ? `${prefix}: a Meta não respondeu agora. Tente de novo em instantes.`
                : `${prefix}, mas a API oficial do WhatsApp não está disponível nesta ` +
                    'instalação. Fale com o suporte.',
          );
          await queryClient.invalidateQueries({ queryKey: queryScopes.conversations });
          return;
        }
        if (error.code === 'NOT_FOUND' && error.details?.resource === 'whatsapp_template') {
          // O modelo saiu da lista aprovada depois que a tela carregou: atualiza a lista.
          setFormError('Esse modelo não está mais aprovado na Meta. A lista foi atualizada; escolha outro.');
          setTemplateDraft(EMPTY_TEMPLATE_DRAFT);
          await queryClient.invalidateQueries({ queryKey: queryKeys.whatsappTemplates() });
          return;
        }
        if (error.code === 'WHATSAPP_WINDOW_CLOSED') {
          // D-310: número novo nunca escreveu, então a janela de 24 h está
          // fechada. A conversa ficou criada; o primeiro contato pela API
          // oficial só sai por template aprovado (CRMLAB-136).
          // `created: false` = conversa que já existia (pode ter falas antigas):
          // não é primeiro contato, a janela só expirou.
          setFormError(
            error.details?.created === false
              ? 'Nada foi enviado: o paciente não escreve há mais de 24 h e, pela API oficial do ' +
                  'WhatsApp, só um modelo aprovado pela Meta pode ser enviado agora.'
              : 'A conversa foi criada, mas pela API oficial do WhatsApp o primeiro contato só pode ' +
                  'sair por um modelo aprovado pela Meta. O paciente precisa escrever antes, ou use um modelo.',
          );
          await queryClient.invalidateQueries({ queryKey: queryScopes.conversations });
          return;
        }
        if (error.code === 'FIRST_CONTACT_LIMIT_REACHED') {
          // D-306: a conversa ficou criada, sem mensagem. O aviso fica no modal,
          // para a atendente ler com calma o que fazer.
          setFormError(firstContactLimitMessage(error.details));
          await queryClient.invalidateQueries({ queryKey: queryScopes.conversations });
          return;
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
    if (byTemplate) {
      const template = templateRequestOf(templates, templateDraft);
      if (normalizedPhone === null) return;
      if (!template) {
        setFormError('Escolha o modelo e preencha todas as variáveis.');
        return;
      }
      start.mutate({ phone: normalizedPhone, template });
      return;
    }
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
        {templatesQuery.isLoading && (
          <p data-testid="templates-loading" className="m-0 font-body text-caption text-neutral-700">
            Carregando os modelos aprovados…
          </p>
        )}
        {templatesQuery.isError && (
          <div
            role="alert"
            data-testid="templates-error"
            className="flex flex-wrap items-center gap-sm rounded-md bg-accent-100 px-md py-sm"
          >
            <p className="m-0 min-w-0 flex-1 font-body text-caption text-accent-800">
              Não foi possível carregar os modelos aprovados (a Meta não respondeu ou o canal está sem
              credencial). Para um número que ainda não escreveu, o envio precisa de um modelo.
            </p>
            <Button variant="secondary" size="sm" onClick={() => void templatesQuery.refetch()}>
              Tentar de novo
            </Button>
          </div>
        )}
        {templates.length > 0 && (
          <SegmentedControl
            aria-label="Tipo da primeira mensagem"
            value={kind}
            onChange={(value) => {
              setChosenKind(value);
              setFormError(null);
            }}
            options={[
              { value: 'template', label: 'Modelo aprovado' },
              { value: 'text', label: 'Texto livre' },
            ]}
          />
        )}
        {byTemplate ? (
          <>
            <TemplatePicker
              templates={templates}
              value={templateDraft}
              onChange={(draft) => {
                setTemplateDraft(draft);
                setFormError(null);
              }}
              disabled={start.isPending}
            />
            {serverErrors['template.variables'] && (
              <p role="alert" className="m-0 font-body text-caption text-accent-700">
                {serverErrors['template.variables']}
              </p>
            )}
          </>
        ) : (
          <>
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
            {templates.length > 0 ? (
              <p
                role="note"
                data-testid="free-text-window-notice"
                className="m-0 rounded-md bg-accent-100 px-md py-sm font-body text-caption text-accent-800"
              >
                Pela API oficial, texto livre só sai se o paciente escreveu nas últimas 24 horas. Para
                o primeiro contato, use um modelo aprovado.
              </p>
            ) : (
              <p
                role="note"
                data-testid="first-contact-notice"
                className="m-0 rounded-md bg-accent-100 px-md py-sm font-body text-caption text-accent-800"
              >
                Mensagem para quem nunca escreveu ao laboratório é <strong>primeiro contato</strong>: o
                WhatsApp pode restringir o número se forem muitos. Quando der, peça ao paciente que mande
                uma mensagem primeiro.
              </p>
            )}
          </>
        )}
        {formError && (
          <p role="alert" className="font-body text-caption text-accent-700">
            {formError}
          </p>
        )}
      </form>
    </Modal>
  );
}
