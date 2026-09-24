import { useState } from 'react';
import type { FormEvent } from 'react';
import type { QuickReply, UpdateQuickReplyRequest } from '@crm-lab/shared';
import { isValidShortcut, normalizeShortcut } from '@crm-lab/shared';
import {
  useCreateQuickReply,
  useDeleteQuickReply,
  useQuickReplyList,
  useUpdateQuickReply,
} from '@/api/quick-replies';
import { isApiError } from '@/api/client';
import { PageContainer, PageHeader } from '@/components/layout';
import { Modal } from '@/components/shared';
import { Button, Input, TextArea, useToast } from '@/components/ui';

/**
 * Respostas rápidas — `/quick-replies` (PAGES.md §13 · API_CONTRACTS.md §9 ·
 * Onda 8 §3).
 *
 * Página própria e `TENANT_ROLES`, não uma aba de "Canais & Equipe": aquela
 * rota é `MANAGER_PLUS` e barraria exatamente quem o lead quer que escreva as
 * macros. Aqui NÃO há controle escondido por papel — atendente, gestora e
 * admin fazem as mesmas quatro coisas, e o servidor concorda (§9).
 */

const SHORTCUT_HINT = 'Só letras minúsculas, números e hífen — 2 a 32 caracteres.';

export default function QuickReplies() {
  const [editing, setEditing] = useState<QuickReply | 'new' | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<QuickReply | null>(null);

  const { data, isLoading } = useQuickReplyList();
  const removeQuickReply = useDeleteQuickReply();
  const quickReplies = data?.quickReplies ?? [];

  return (
    <PageContainer>
      <PageHeader
        title="Respostas rápidas"
        description="Textos prontos que você dispara no atendimento digitando / no campo de mensagem."
        actions={
          <Button variant="primary" onClick={() => setEditing('new')}>
            + Nova resposta
          </Button>
        }
      />

      {isLoading ? (
        <div className="font-body text-body text-neutral-600">Carregando...</div>
      ) : quickReplies.length === 0 ? (
        <EmptyState />
      ) : (
        <ul className="flex list-none flex-col gap-md p-0">
          {quickReplies.map((reply) => (
            <li
              key={reply.id}
              className="flex items-start gap-md rounded-md border border-neutral-200 bg-surface p-md"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline gap-sm">
                  <span className="font-body text-label font-medium text-accent">
                    /{reply.shortcut}
                  </span>
                  <span className="font-body text-label text-text">{reply.title}</span>
                </div>
                <p className="mt-xs line-clamp-2 font-body text-caption text-neutral-600">
                  {reply.content}
                </p>
              </div>

              {/* O rótulo NOMEIA a macro: uma fila de "Editar" idênticos é
                  ambígua para leitor de tela e impossível de endereçar em
                  teste — o mesmo achado do alfinete da Onda 8/1. */}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setEditing(reply)}
                aria-label={`Editar /${reply.shortcut}`}
              >
                Editar
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setConfirmDelete(reply)}
                aria-label={`Apagar /${reply.shortcut}`}
              >
                Apagar
              </Button>
            </li>
          ))}
        </ul>
      )}

      {editing && (
        <QuickReplyModal
          quickReply={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}

      {confirmDelete && (
        <Modal
          open
          onClose={() => setConfirmDelete(null)}
          title={`Apagar /${confirmDelete.shortcut}?`}
          footer={
            <div className="ml-auto flex gap-md">
              <Button variant="secondary" onClick={() => setConfirmDelete(null)}>
                Cancelar
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  removeQuickReply.mutate(confirmDelete.id);
                  setConfirmDelete(null);
                }}
              >
                Apagar
              </Button>
            </div>
          }
        >
          <p className="font-body text-body text-text">
            A resposta rápida é apagada de verdade e não volta. As mensagens já enviadas com esse
            texto continuam no histórico.
          </p>
        </Modal>
      )}
    </PageContainer>
  );
}

function EmptyState() {
  return (
    <div className="rounded-md border border-neutral-200 bg-surface p-lg">
      <p className="font-body text-body text-text">Nenhuma resposta rápida ainda</p>
      <p className="mt-xs font-body text-caption text-neutral-600">
        Respostas rápidas são textos prontos para as perguntas de sempre. Depois de criar uma, no
        atendimento basta digitar <strong>/</strong> no campo vazio e escolher pelo atalho.
      </p>
    </div>
  );
}

interface QuickReplyModalProps {
  quickReply?: QuickReply;
  onClose: () => void;
}

function QuickReplyModal({ quickReply, onClose }: QuickReplyModalProps) {
  const isEditMode = quickReply !== undefined;

  const [form, setForm] = useState({
    shortcut: quickReply?.shortcut ?? '',
    title: quickReply?.title ?? '',
    content: quickReply?.content ?? '',
  });
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const { toast } = useToast();

  const createQuickReply = useCreateQuickReply();
  const updateQuickReply = useUpdateQuickReply();

  /**
   * O formato do atalho e os campos vazios são checados aqui ANTES da chamada
   * porque o erro é do campo, e marcar o input é a única correção possível.
   * O botão fica no `footer` do Modal, FORA do `<form>`: o `required` dos
   * inputs nunca é checado pelo navegador, então a checagem tem de ser nossa.
   * Não é a validação de verdade — essa é do backend (§9), e é ela que decide
   * sobre atalho repetido, que a tela não tem como saber sem corrida.
   *
   * O modal só fecha no `onSuccess`: fechar logo após o `mutate` fazia o
   * `VALIDATION_ERROR` do servidor sumir junto com ele (CRMLAB-47).
   */
  function handleSubmit(event: FormEvent): void {
    event.preventDefault();

    const shortcut = normalizeShortcut(form.shortcut);
    const errors: Record<string, string> = {};
    if (!isValidShortcut(shortcut)) errors.shortcut = SHORTCUT_HINT;
    if (!form.title.trim()) errors.title = 'Informe um título.';
    if (!form.content.trim()) errors.content = 'Escreva a resposta.';
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const callbacks = {
      onSuccess: () => {
        toast(isEditMode ? 'Resposta rápida atualizada.' : 'Resposta rápida criada.', {
          tone: 'positive',
        });
        onClose();
      },
      onError: (err: unknown) => {
        const fields =
          isApiError(err) && err.code === 'VALIDATION_ERROR'
            ? (err.details?.fields as Record<string, string> | undefined)
            : undefined;
        if (fields && Object.keys(fields).length > 0) {
          setFieldErrors(fields);
          return;
        }
        toast('Não foi possível salvar a resposta rápida.', { tone: 'attention' });
      },
    };

    if (quickReply) {
      // PATCH parcial: só o que a pessoa realmente mudou vai no corpo.
      const dto: UpdateQuickReplyRequest = {
        ...(shortcut !== quickReply.shortcut ? { shortcut } : {}),
        ...(form.title !== quickReply.title ? { title: form.title } : {}),
        ...(form.content !== quickReply.content ? { content: form.content } : {}),
      };
      updateQuickReply.mutate({ id: quickReply.id, dto }, callbacks);
    } else {
      createQuickReply.mutate({ shortcut, title: form.title, content: form.content }, callbacks);
    }
  }

  function clearFieldError(field: string): void {
    if (!fieldErrors[field]) return;
    const { [field]: _removed, ...rest } = fieldErrors;
    setFieldErrors(rest);
  }

  const isPending = createQuickReply.isPending || updateQuickReply.isPending;

  return (
    <Modal
      open
      onClose={onClose}
      title={isEditMode ? 'Editar resposta rápida' : 'Nova resposta rápida'}
      footer={
        <div className="ml-auto flex gap-md">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={handleSubmit} disabled={isPending} loading={isPending}>
            {isEditMode ? 'Atualizar' : 'Criar'}
          </Button>
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-md">
        <Input
          label="Atalho"
          // A barra é como se usa, não o que se grava (SCHEMA.md §22).
          prefix={<span className="font-body text-label text-neutral-600">/</span>}
          hint={SHORTCUT_HINT}
          error={fieldErrors.shortcut}
          value={form.shortcut}
          onChange={(e) => {
            clearFieldError('shortcut');
            setForm({ ...form, shortcut: e.target.value });
          }}
          required
        />

        <Input
          label="Título"
          hint="Como você reconhece a resposta na lista."
          error={fieldErrors.title}
          value={form.title}
          onChange={(e) => {
            clearFieldError('title');
            setForm({ ...form, title: e.target.value });
          }}
          required
        />

        <TextArea
          label="Resposta"
          rows={5}
          error={fieldErrors.content}
          value={form.content}
          onChange={(e) => {
            clearFieldError('content');
            setForm({ ...form, content: e.target.value });
          }}
          required
        />
      </form>
    </Modal>
  );
}
