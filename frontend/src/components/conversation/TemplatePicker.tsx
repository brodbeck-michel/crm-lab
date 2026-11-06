import { useId, useMemo } from 'react';
import type { SendTemplateRequest, WhatsAppTemplate } from '@crm-lab/shared';
import { Input, Select } from '@/components/ui';

/**
 * Escolha de modelo aprovado da Meta e das variáveis (CRMLAB-136, D-309).
 *
 * Controlado: quem usa guarda `value` e decide quando enviar (Composer abre num
 * modal; a Nova conversa usa no próprio formulário). A prévia mostra o texto
 * exatamente como o paciente vai ler — o mesmo que o servidor grava.
 */
export interface TemplateDraft {
  /** `name|language` do modelo escolhido; `''` = nenhum. */
  key: string;
  variables: string[];
}

export const EMPTY_TEMPLATE_DRAFT: TemplateDraft = { key: '', variables: [] };

export function templateKey(template: Pick<WhatsAppTemplate, 'name' | 'language'>): string {
  return `${template.name}|${template.language}`;
}

const CATEGORY_LABEL: Record<WhatsAppTemplate['category'], string> = {
  utility: 'utilidade',
  marketing: 'marketing',
};

/** Corpo com as variáveis; as vazias ficam como `{{n}}` para a atendente ver o que falta. */
export function previewTemplate(body: string, variables: readonly string[]): string {
  return body.replace(/\{\{\s*(\d+)\s*\}\}/g, (whole, token: string) => {
    const value = variables[Number(token) - 1]?.trim();
    return value ? value : whole;
  });
}

/** Pedido pronto para a API, ou `null` enquanto falta modelo ou variável. */
export function templateRequestOf(
  templates: readonly WhatsAppTemplate[],
  draft: TemplateDraft,
): SendTemplateRequest | null {
  const template = templates.find((t) => templateKey(t) === draft.key);
  if (!template) return null;
  const variables = template.variables.map((_, i) => (draft.variables[i] ?? '').trim());
  if (variables.some((v) => v.length === 0)) return null;
  return { name: template.name, language: template.language, variables };
}

export interface TemplatePickerProps {
  templates: readonly WhatsAppTemplate[];
  value: TemplateDraft;
  onChange: (draft: TemplateDraft) => void;
  disabled?: boolean;
}

export function TemplatePicker({ templates, value, onChange, disabled }: TemplatePickerProps) {
  const previewId = useId();
  const selected = useMemo(
    () => templates.find((t) => templateKey(t) === value.key) ?? null,
    [templates, value.key],
  );

  return (
    <div data-testid="template-picker" className="flex flex-col gap-md">
      <Select
        label="Modelo aprovado"
        placeholder="Escolha um modelo"
        value={value.key}
        disabled={disabled}
        onChange={(event) => onChange({ key: event.target.value, variables: [] })}
        options={templates.map((t) => ({
          value: templateKey(t),
          label: `${t.name} (${t.language}, ${CATEGORY_LABEL[t.category]})`,
        }))}
      />

      {selected?.variables.map((variable, i) => (
        <Input
          key={`${value.key}-${variable.index}`}
          label={`Variável {{${variable.index}}}`}
          placeholder={variable.example ? `ex.: ${variable.example}` : undefined}
          value={value.variables[i] ?? ''}
          maxLength={1024}
          disabled={disabled}
          onChange={(event) => {
            const next = selected.variables.map((_, j) => value.variables[j] ?? '');
            next[i] = event.target.value;
            onChange({ key: value.key, variables: next });
          }}
        />
      ))}

      {selected && (
        <div className="flex flex-col gap-xs">
          <span id={previewId} className="font-body text-caption font-semibold text-neutral-700">
            Como o paciente vai receber
          </span>
          <p
            aria-labelledby={previewId}
            data-testid="template-preview"
            className="m-0 whitespace-pre-wrap rounded-sm bg-chat-quote px-sm py-xs font-body text-body text-neutral-900"
          >
            {previewTemplate(selected.body, value.variables)}
          </p>
        </div>
      )}
    </div>
  );
}
