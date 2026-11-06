/**
 * Modelos aprovados da Meta (CRMLAB-136, D-309) — funcoes puras: ler a
 * resposta de `GET /{waba_id}/message_templates`, validar e preencher.
 *
 * Entra na lista so o que o CRM sabe enviar por inteiro:
 * - `status = APPROVED`, categoria `MARKETING` ou `UTILITY` (AUTHENTICATION e
 *   codigo de verificacao, nao atendimento);
 * - um componente `BODY` de texto e NENHUM outro (cabecalho, rodape, botao ou
 *   midia ficam de fora nesta entrega);
 * - variaveis POSICIONAIS `{{1}}..{{n}}` sem buraco (o formato nomeado
 *   `{{nome}}` da Meta fica de fora).
 */
import type { WhatsAppTemplate, WhatsAppTemplateCategory } from '@crm-lab/shared';

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toCategory(value: unknown): WhatsAppTemplateCategory | null {
  if (value === 'MARKETING') return 'marketing';
  if (value === 'UTILITY') return 'utility';
  return null;
}

/**
 * Indices `{{n}}` do corpo, 1..n sem buraco (repeticao permitida). `null` =
 * placeholder nomeado ou numeracao com buraco: o modelo nao entra na lista.
 */
export function placeholderCount(body: string): number | null {
  const seen = new Set<number>();
  for (const match of body.matchAll(PLACEHOLDER)) {
    const token = match[1] ?? '';
    if (!/^[1-9]\d*$/.test(token)) return null;
    seen.add(Number(token));
  }
  for (let i = 1; i <= seen.size; i += 1) if (!seen.has(i)) return null;
  return seen.size;
}

/** Um modelo cru da Meta -> `WhatsAppTemplate`, ou `null` se fica de fora. */
export function parseMetaTemplate(raw: unknown): WhatsAppTemplate | null {
  const t = asRecord(raw);
  if (!t || t.status !== 'APPROVED') return null;
  const category = toCategory(t.category);
  if (!category) return null;
  if (typeof t.name !== 'string' || t.name.length === 0 || t.name.length > 512) return null;
  if (typeof t.language !== 'string' || t.language.length === 0 || t.language.length > 20) return null;
  if (t.parameter_format !== undefined && t.parameter_format !== 'POSITIONAL') return null;
  if (!Array.isArray(t.components) || t.components.length !== 1) return null;
  const body = asRecord(t.components[0]);
  if (!body || body.type !== 'BODY' || typeof body.text !== 'string' || body.text.trim() === '') {
    return null;
  }
  const count = placeholderCount(body.text);
  if (count === null) return null;
  const examples = asRecord(body.example)?.body_text;
  const firstRow = Array.isArray(examples) && Array.isArray(examples[0]) ? (examples[0] as unknown[]) : [];
  return {
    name: t.name,
    language: t.language,
    category,
    body: body.text,
    variables: Array.from({ length: count }, (_, i) => {
      const example = firstRow[i];
      return { index: i + 1, example: typeof example === 'string' && example.length > 0 ? example : null };
    }),
  };
}

/** Lista da Meta -> so os aproveitaveis, em `name ASC, language ASC` (contrato §6.2). */
export function parseMetaTemplates(rows: readonly unknown[]): WhatsAppTemplate[] {
  return rows
    .map(parseMetaTemplate)
    .filter((t): t is WhatsAppTemplate => t !== null)
    .sort((a, b) =>
      a.name === b.name ? (a.language < b.language ? -1 : a.language > b.language ? 1 : 0) : a.name < b.name ? -1 : 1,
    );
}

/** Corpo com as variaveis no lugar (`{{n}}` -> `variables[n-1]`). Chamado ja com a contagem conferida. */
export function fillTemplate(body: string, variables: readonly string[]): string {
  return body.replace(PLACEHOLDER, (whole, token: string) => {
    const value = variables[Number(token) - 1];
    return value === undefined ? whole : value;
  });
}
