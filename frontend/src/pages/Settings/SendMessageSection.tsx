import {
  DEFAULT_SEND_MESSAGE_TEMPLATE,
  SEND_MESSAGE_TEMPLATES_MAX,
  SEND_MESSAGE_TEMPLATE_MAX,
  SEND_MESSAGE_TEMPLATE_NAME_MAX,
  SEND_MESSAGE_VARIABLES,
  renderSendMessageTemplate,
  validateSendMessageTemplates,
  type FunnelRules,
  type SendMessageRules,
  type SendMessageTemplate,
} from '@crm-lab/shared';
import { Button, Chip, Input, TextArea } from '@/components/ui';
import { formatMoney } from '@/lib/format';

/**
 * Seção "Mensagem de envio" da página de Regras (PAGES.md §21, CRMLAB-95 —
 * D-265). De 1 a 5 modelos com nome; o primeiro é o padrão (o que o painel de
 * envio abre). Faz parte do formulário das Regras: mexe no `draft` e é salva
 * pelo mesmo `PATCH /settings/funnel-rules`, com a lista inteira.
 */

export interface SendMessageSectionProps {
  draft: FunnelRules;
  canEdit: boolean;
  fieldErrors: Record<string, string>;
  set: (mutate: (next: FunnelRules) => void) => void;
}

const PREVIEW_VALUES = {
  paciente: 'Maria Souza',
  numero_orcamento: '70034',
  valor: formatMoney(179.8),
  convenio: 'Particular',
} as const;

/** `true` quando a lista não pode ir para o servidor (mesma validação do back). */
export function sendMessageBlocked(rules: SendMessageRules): boolean {
  return validateSendMessageTemplates(rules.templates).templates === null;
}

/** "Modelo N" com o menor N ≥ 2 que ainda não é nome de outro modelo. */
function nextTemplateName(templates: readonly SendMessageTemplate[]): string {
  const taken = new Set(templates.map((t) => t.name.trim().toLocaleLowerCase('pt-BR')));
  let n = templates.length + 1;
  while (taken.has(`modelo ${n}`)) n += 1;
  return `Modelo ${n}`;
}

function move<T>(list: T[], from: number, to: number): void {
  const [item] = list.splice(from, 1);
  if (item !== undefined) list.splice(to, 0, item);
}

export function SendMessageSection({ draft, canEdit, fieldErrors, set }: SendMessageSectionProps) {
  const templates = draft.sendMessage.templates;
  const local = validateSendMessageTemplates(templates).errors;
  const errorOf = (key: string): string | undefined =>
    fieldErrors[`sendMessage.${key}`] ?? local[key];

  const update = (mutate: (list: SendMessageTemplate[]) => void) =>
    set((next) => mutate(next.sendMessage.templates));

  return (
    <section
      id="mensagem"
      aria-labelledby="mensagem-titulo"
      className="space-y-md rounded-lg border border-neutral-200 bg-neutral-100 p-lg"
    >
      <div className="space-y-xs">
        <h2 id="mensagem-titulo" className="font-heading text-section text-text">
          Mensagem de envio
        </h2>
        <p className="font-body text-caption text-neutral-600">
          Textos do WhatsApp ao enviar o orçamento (até {SEND_MESSAGE_TEMPLATES_MAX}). O padrão é o
          que o envio abre; a atendente troca de modelo e edita o texto antes de enviar.
        </p>
      </div>

      {templates.map((template, index) => {
        const isDefault = index === 0;
        return (
          <div
            key={index}
            role="group"
            aria-label={`Modelo ${index + 1}`}
            className="space-y-sm rounded-md border border-neutral-200 bg-bg p-md"
          >
            <div className="flex flex-wrap items-end gap-sm">
              <div className="min-w-0 flex-1">
                <Input
                  label="Nome do modelo"
                  value={template.name}
                  maxLength={SEND_MESSAGE_TEMPLATE_NAME_MAX}
                  disabled={!canEdit}
                  error={errorOf(`templates.${index}.name`)}
                  onChange={(e) => {
                    const name = e.target.value;
                    update((list) => {
                      const item = list[index];
                      if (item) item.name = name;
                    });
                  }}
                />
              </div>
              {isDefault && <Chip tone="positive">Padrão</Chip>}
            </div>

            <TextArea
              label="Texto do modelo"
              rows={4}
              maxLength={SEND_MESSAGE_TEMPLATE_MAX}
              value={template.text}
              disabled={!canEdit}
              error={errorOf(`templates.${index}.text`)}
              onChange={(e) => {
                const text = e.target.value;
                update((list) => {
                  const item = list[index];
                  if (item) item.text = text;
                });
              }}
            />

            {canEdit && (
              <div className="flex flex-wrap gap-sm">
                {SEND_MESSAGE_VARIABLES.map((name) => (
                  <Button
                    key={name}
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      update((list) => {
                        const item = list[index];
                        if (item) item.text = `${item.text}{${name}}`;
                      })
                    }
                  >
                    {`{${name}}`}
                  </Button>
                ))}
              </div>
            )}

            <div className="space-y-xs">
              <span className="font-body text-caption font-semibold text-neutral-700">
                Pré-visualização
              </span>
              <p
                data-testid="preview-mensagem"
                className="whitespace-pre-wrap rounded-md border border-neutral-200 bg-neutral-100 p-md font-body text-body text-text"
              >
                {renderSendMessageTemplate(template.text, PREVIEW_VALUES)}
              </p>
            </div>

            {canEdit && templates.length > 1 && (
              <div className="flex flex-wrap gap-sm">
                {!isDefault && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => update((list) => move(list, index, 0))}
                  >
                    Tornar padrão
                  </Button>
                )}
                {index > 0 && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => update((list) => move(list, index, index - 1))}
                  >
                    Subir
                  </Button>
                )}
                {index < templates.length - 1 && (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => update((list) => move(list, index, index + 1))}
                  >
                    Descer
                  </Button>
                )}
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  onClick={() => update((list) => void list.splice(index, 1))}
                >
                  Remover
                </Button>
              </div>
            )}
          </div>
        );
      })}

      {errorOf('templates') && (
        <span role="alert" className="font-body text-caption text-accent-700">
          {errorOf('templates')}
        </span>
      )}

      {canEdit && templates.length < SEND_MESSAGE_TEMPLATES_MAX && (
        <Button
          type="button"
          variant="secondary"
          onClick={() =>
            update((list) =>
              void list.push({ name: nextTemplateName(list), text: DEFAULT_SEND_MESSAGE_TEMPLATE }),
            )
          }
        >
          Adicionar modelo
        </Button>
      )}
    </section>
  );
}
