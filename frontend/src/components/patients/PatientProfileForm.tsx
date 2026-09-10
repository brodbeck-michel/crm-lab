import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { PatientDetail, UpdatePatientRequest } from '@crm-lab/shared';
import { isApiError } from '@/api/client';
import { patientsApi } from '@/api/patients';
import { queryScopes } from '@/api/query-keys';
import { Button, Chip, Input, TextArea } from '@/components/ui';

/**
 * Cadastro completo editável da ficha — `GET /patients/:id` + `PATCH /patients/:id`
 * (API_CONTRACTS.md §2c, PAGES.md §3).
 *
 * Semântica do PATCH parcial, que esta tela respeita literalmente:
 *   campo AUSENTE preserva · `null` APAGA.
 * Por isso o corpo é montado por DIFERENÇA contra o cadastro carregado: um
 * campo esvaziado pelo usuário vira `null` explícito, e um campo intocado
 * simplesmente não entra no corpo. Enviar o formulário inteiro a cada salvamento
 * transformaria "não mexi nisso" em "apague isso" para qualquer campo que o
 * servidor tivesse preenchido entre a leitura e a escrita.
 *
 * `phone` é editável (D-106, reverte D-061). Continua sendo a chave de
 * deduplicação `UNIQUE (tenant_id, phone)` do webhook — por isso, ao contrário
 * dos outros campos, NUNCA vira `null` (`phonePatch` nunca devolve `null`,
 * só `undefined` ou string) e um valor já usado por outro paciente do tenant
 * é recusado pelo servidor com `409 CONFLICT` / `phone_already_in_use`.
 */

export interface PatientProfileFormProps {
  patient: PatientDetail;
}

/** Campos de texto simples do cadastro — os que aceitam `null` para apagar. */
type TextField = 'name' | 'email' | 'birthDate' | 'document' | 'notes';

interface FormState {
  phone: string;
  name: string;
  email: string;
  birthDate: string;
  document: string;
  notes: string;
  tags: string[];
  customFields: Array<{ key: string; value: string }>;
}

function toFormState(patient: PatientDetail): FormState {
  return {
    phone: patient.phone,
    name: patient.name ?? '',
    email: patient.email ?? '',
    birthDate: patient.birthDate ?? '',
    document: patient.document ?? '',
    notes: patient.notes ?? '',
    tags: [...patient.tags],
    customFields: Object.entries(patient.customFields).map(([key, value]) => ({ key, value })),
  };
}

/**
 * `phone` nunca apaga (diferente de `textPatch`): campo vazio ou intocado não
 * entra no corpo — o servidor recusaria `null`/string vazia de qualquer forma.
 */
function phonePatch(current: string, original: string): string | undefined {
  const trimmed = current.trim();
  return trimmed.length === 0 || trimmed === original ? undefined : trimmed;
}

/**
 * `undefined` = não mudou (não entra no corpo) · `null` = apagar · string = novo valor.
 * O trim acontece aqui: " " digitado num campo vazio não é uma mudança.
 */
function textPatch(current: string, original: string | null): string | null | undefined {
  const trimmed = current.trim();
  if (trimmed === (original ?? '')) return undefined;
  return trimmed.length === 0 ? null : trimmed;
}

function sameTags(current: string[], original: readonly string[]): boolean {
  return current.length === original.length && current.every((tag, i) => tag === original[i]);
}

function toCustomFields(rows: FormState['customFields']): Record<string, string> {
  const mapped: Record<string, string> = {};
  for (const row of rows) {
    const key = row.key.trim();
    if (key.length > 0) mapped[key] = row.value;
  }
  return mapped;
}

function sameCustomFields(
  current: Record<string, string>,
  original: Record<string, string>,
): boolean {
  const currentKeys = Object.keys(current);
  const originalKeys = Object.keys(original);
  if (currentKeys.length !== originalKeys.length) return false;
  return currentKeys.every((key) => current[key] === original[key]);
}

/** Monta o corpo do PATCH só com o que mudou. Vazio ⇒ nada a salvar. */
export function buildPatientPatch(form: FormState, patient: PatientDetail): UpdatePatientRequest {
  const body: UpdatePatientRequest = {};

  const phone = phonePatch(form.phone, patient.phone);
  if (phone !== undefined) body.phone = phone;

  const fields: TextField[] = ['name', 'email', 'birthDate', 'document', 'notes'];
  for (const field of fields) {
    const next = textPatch(form[field], patient[field]);
    if (next !== undefined) body[field] = next;
  }

  const tags = form.tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
  if (!sameTags(tags, patient.tags)) body.tags = tags;

  const customFields = toCustomFields(form.customFields);
  if (!sameCustomFields(customFields, patient.customFields)) body.customFields = customFields;

  return body;
}

/** `details.fields` (API_ERRORS.md) → `{ campo: motivo }`, sem `any`. */
function readFieldErrors(details: Record<string, unknown> | undefined): Record<string, string> {
  const raw = details?.fields;
  if (typeof raw !== 'object' || raw === null) return {};
  const mapped: Record<string, string> = {};
  for (const [field, reason] of Object.entries(raw as Record<string, unknown>)) {
    mapped[field] = typeof reason === 'string' ? reason : String(reason);
  }
  return mapped;
}

export function PatientProfileForm({ patient }: PatientProfileFormProps) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<FormState>(() => toFormState(patient));
  const [tagDraft, setTagDraft] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const anonymized = patient.anonymizedAt !== null;

  // O cadastro pode mudar sob os pés do formulário (anonimização em outra aba,
  // invalidação por WebSocket). `updatedAt` é o carimbo dessa mudança.
  useEffect(() => {
    setForm(toFormState(patient));
    setFieldErrors({});
    setFormError(null);
  }, [patient.id, patient.updatedAt, patient.anonymizedAt]);

  const patch = useMemo(() => buildPatientPatch(form, patient), [form, patient]);
  const dirty = Object.keys(patch).length > 0;

  const save = useMutation({
    mutationFn: (body: UpdatePatientRequest) => patientsApi.update(patient.id, body),
    onSuccess: () => {
      setFieldErrors({});
      setFormError(null);
      setSaved(true);
      void queryClient.invalidateQueries({ queryKey: queryScopes.patient });
    },
    onError: (error: unknown) => {
      setSaved(false);
      if (!isApiError(error)) {
        setFormError('Não foi possível salvar o cadastro. Tente novamente.');
        return;
      }
      // switch pelo CÓDIGO, nunca pela mensagem (API_ERRORS.md).
      switch (error.code) {
        case 'VALIDATION_ERROR': {
          const fields = readFieldErrors(error.details);
          setFieldErrors(fields);
          setFormError(Object.keys(fields).length > 0 ? null : error.message);
          break;
        }
        case 'CONFLICT':
          if (error.details?.reason === 'patient_anonymized') {
            setFormError('Este cadastro foi anonimizado e não pode mais ser editado.');
          } else if (error.details?.reason === 'phone_already_in_use') {
            setFieldErrors({ phone: 'Este telefone já pertence a outro paciente.' });
            setFormError(null);
          } else {
            setFormError(error.message);
          }
          break;
        default:
          setFormError(error.message);
      }
    },
  });

  const setField = (field: TextField | 'phone', value: string) => {
    setSaved(false);
    setForm((current) => ({ ...current, [field]: value }));
  };

  const addTag = () => {
    const tag = tagDraft.trim();
    if (tag.length === 0 || form.tags.includes(tag)) return;
    setSaved(false);
    setForm((current) => ({ ...current, tags: [...current.tags, tag] }));
    setTagDraft('');
  };

  const removeTag = (tag: string) => {
    setSaved(false);
    setForm((current) => ({ ...current, tags: current.tags.filter((item) => item !== tag) }));
  };

  const setCustomField = (index: number, part: 'key' | 'value', value: string) => {
    setSaved(false);
    setForm((current) => ({
      ...current,
      customFields: current.customFields.map((row, i) =>
        i === index ? { ...row, [part]: value } : row,
      ),
    }));
  };

  const removeCustomField = (index: number) => {
    setSaved(false);
    setForm((current) => ({
      ...current,
      customFields: current.customFields.filter((_, i) => i !== index),
    }));
  };

  return (
    <section aria-labelledby="patient-profile-heading" className="flex flex-col gap-md">
      <div className="flex flex-wrap items-baseline justify-between gap-sm">
        <h2 id="patient-profile-heading" className="m-0 font-heading text-section text-text">
          Cadastro
        </h2>
        <p className="m-0 font-body text-caption text-neutral-600">
          Campo esvaziado é apagado no cadastro; campo não alterado permanece como está.
        </p>
      </div>

      {anonymized && (
        <p
          role="status"
          className="m-0 rounded-md bg-accent-100 px-md py-sm font-body text-caption text-accent-800"
        >
          Cadastro anonimizado a pedido do titular. Os dados pessoais foram apagados e a edição
          está encerrada.
        </p>
      )}

      <form
        className="flex flex-col gap-md"
        onSubmit={(event) => {
          event.preventDefault();
          if (!dirty || anonymized) return;
          save.mutate(patch);
        }}
      >
        <div className="grid grid-cols-1 gap-md sm:grid-cols-2">
          <Input
            label="Nome"
            value={form.name}
            disabled={anonymized}
            error={fieldErrors.name}
            onChange={(event) => setField('name', event.target.value)}
          />

          {/* D-106: editável, mas continua sendo a chave que reconhece o paciente no WhatsApp. */}
          <Input
            label="Telefone"
            value={form.phone}
            disabled={anonymized}
            error={fieldErrors.phone}
            hint="É o número que identifica o paciente quando ele escreve. Um número já usado por outro cadastro é recusado."
            onChange={(event) => setField('phone', event.target.value)}
          />

          <Input
            label="E-mail"
            type="email"
            value={form.email}
            disabled={anonymized}
            error={fieldErrors.email}
            onChange={(event) => setField('email', event.target.value)}
          />

          <Input
            label="Data de nascimento"
            type="date"
            value={form.birthDate}
            disabled={anonymized}
            error={fieldErrors.birthDate}
            onChange={(event) => setField('birthDate', event.target.value)}
          />

          <Input
            label="CPF"
            value={form.document}
            disabled={anonymized}
            error={fieldErrors.document}
            hint="Com ou sem pontuação — o servidor normaliza para 11 dígitos."
            onChange={(event) => setField('document', event.target.value)}
          />
        </div>

        <TextArea
          label="Anotações internas"
          rows={4}
          value={form.notes}
          disabled={anonymized}
          error={fieldErrors.notes}
          hint="Visível apenas para a equipe do laboratório — nunca é enviado ao paciente."
          onChange={(event) => setField('notes', event.target.value)}
        />

        <fieldset className="m-0 flex flex-col gap-sm border-none p-0">
          <legend className="mb-xs p-0 font-body text-caption font-semibold text-neutral-700">
            Etiquetas
          </legend>

          {form.tags.length === 0 ? (
            <p className="m-0 font-body text-caption text-neutral-600">Nenhuma etiqueta.</p>
          ) : (
            <div className="flex flex-wrap gap-xs">
              {form.tags.map((tag) => (
                <Chip key={tag} tone="positive">
                  <span>{tag}</span>
                  {!anonymized && (
                    <button
                      type="button"
                      aria-label={`Remover etiqueta ${tag}`}
                      onClick={() => removeTag(tag)}
                      className="cursor-pointer border-none bg-transparent font-body text-caption"
                    >
                      ×
                    </button>
                  )}
                </Chip>
              ))}
            </div>
          )}

          {!anonymized && (
            <div className="flex items-end gap-sm">
              <div className="min-w-[200px] flex-1">
                <Input
                  aria-label="Nova etiqueta"
                  placeholder="Nova etiqueta"
                  value={tagDraft}
                  error={fieldErrors.tags}
                  onChange={(event) => setTagDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addTag();
                    }
                  }}
                />
              </div>
              <Button variant="secondary" size="sm" onClick={addTag}>
                Adicionar etiqueta
              </Button>
            </div>
          )}
        </fieldset>

        <fieldset className="m-0 flex flex-col gap-sm border-none p-0">
          <legend className="mb-xs p-0 font-body text-caption font-semibold text-neutral-700">
            Campos personalizados
          </legend>

          {form.customFields.length === 0 ? (
            <p className="m-0 font-body text-caption text-neutral-600">
              Nenhum campo personalizado.
            </p>
          ) : (
            form.customFields.map((row, index) => (
              <div key={`custom-${index}`} className="flex items-end gap-sm">
                <div className="min-w-[140px] flex-1">
                  <Input
                    aria-label={`Nome do campo ${index + 1}`}
                    value={row.key}
                    disabled={anonymized}
                    onChange={(event) => setCustomField(index, 'key', event.target.value)}
                  />
                </div>
                <div className="min-w-[140px] flex-1">
                  <Input
                    aria-label={`Valor do campo ${index + 1}`}
                    value={row.value}
                    disabled={anonymized}
                    onChange={(event) => setCustomField(index, 'value', event.target.value)}
                  />
                </div>
                {!anonymized && (
                  <Button variant="destructive" size="sm" onClick={() => removeCustomField(index)}>
                    Remover
                  </Button>
                )}
              </div>
            ))
          )}

          {!anonymized && (
            <div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  setForm((current) => ({
                    ...current,
                    customFields: [...current.customFields, { key: '', value: '' }],
                  }))
                }
              >
                + Campo personalizado
              </Button>
            </div>
          )}
        </fieldset>

        {formError && (
          <p role="alert" className="m-0 font-body text-caption text-accent-700">
            {formError}
          </p>
        )}

        {saved && !dirty && (
          <p role="status" className="m-0 font-body text-caption text-accent2-800">
            Cadastro salvo.
          </p>
        )}

        {!anonymized && (
          <div className="flex flex-wrap items-center gap-sm">
            <Button type="submit" variant="primary" disabled={!dirty} loading={save.isPending}>
              Salvar cadastro
            </Button>
            <Button
              variant="secondary"
              disabled={!dirty || save.isPending}
              onClick={() => {
                setForm(toFormState(patient));
                setTagDraft('');
                setFieldErrors({});
                setFormError(null);
                setSaved(false);
              }}
            >
              Descartar alterações
            </Button>
            {!dirty && (
              <span className="font-body text-caption text-neutral-600">
                Nada alterado desde a última leitura.
              </span>
            )}
          </div>
        )}
      </form>
    </section>
  );
}

export default PatientProfileForm;
