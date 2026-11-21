import { useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  BRAZIL_UFS,
  DOCTOR_VISIT_HOURS_MAX,
  WEEKDAYS,
  WEEKDAY_SHORT_LABELS,
  isValidBirthday,
  isValidTimeHHMM,
  normalizeCep,
  normalizeCrm,
  type CreateDoctorRequest,
  type Doctor,
  type DoctorCrmConflictDetails,
  type DoctorSpecialty,
  type DoctorSpecialtyConflictDetails,
  type DoctorVisitHours,
  type Weekday,
} from '@crm-lab/shared';
import { doctorsApi } from '@/api/doctors';
import { lookupCep } from '@/api/viacep';
import { isApiError } from '@/api/client';
import { mapFieldErrors } from '@/api/error-handler';
import { queryKeys, queryScopes } from '@/api/query-keys';
import { useApiErrorHandler } from '@/hooks';
import { useAuthStore } from '@/stores/auth.store';
import { Modal } from '@/components/shared';
import { Button, Input, Select, TextArea, Toggle, useToast } from '@/components/ui';

export interface DoctorModalProps {
  doctor?: Doctor;
  assignees: Array<{ id: string; name: string }>;
  onClose: () => void;
}

/** Faixa de horário no formulário (dias marcados + início/fim como digitados). */
interface VisitHoursRow {
  weekdays: Weekday[];
  start: string;
  end: string;
}

type AcceptsPrivateChoice = '' | 'yes' | 'no';

interface DoctorForm {
  name: string;
  crm: string;
  crmUf: string;
  specialtyId: string;
  birthDay: string;
  birthMonth: string;
  birthYear: string;
  phone: string;
  email: string;
  responsibleId: string;
  notes: string;
  clinic: string;
  acceptsPrivate: AcceptsPrivateChoice;
  monthlyConsultations: string;
  monthlyPrivateConsultations: string;
  consultationFee: string;
  visitHours: VisitHoursRow[];
  visitPreference: string;
  isPartner: boolean;
  partnerSince: string;
  partnershipNotes: string;
  addressZip: string;
  addressStreet: string;
  addressNumber: string;
  addressComplement: string;
  addressDistrict: string;
  addressCity: string;
  addressState: string;
  secretaryName: string;
  secretaryBirthDay: string;
  secretaryBirthMonth: string;
  secretaryBirthYear: string;
  secretaryPhone: string;
  secretaryNotes: string;
}

type TextKey = {
  [K in keyof DoctorForm]: DoctorForm[K] extends string ? K : never;
}[keyof DoctorForm];

const str = (value: number | string | null | undefined): string => (value === null || value === undefined ? '' : String(value));

function toForm(doctor?: Doctor): DoctorForm {
  return {
    name: doctor?.name ?? '',
    crm: doctor?.crm ?? '',
    crmUf: doctor?.crmUf ?? '',
    specialtyId: doctor?.specialtyId ?? '',
    birthDay: str(doctor?.birthDay),
    birthMonth: str(doctor?.birthMonth),
    birthYear: str(doctor?.birthYear),
    phone: doctor?.phone ?? '',
    email: doctor?.email ?? '',
    responsibleId: doctor?.responsible?.id ?? '',
    notes: doctor?.notes ?? '',
    clinic: doctor?.clinic ?? '',
    acceptsPrivate: doctor?.acceptsPrivate === true ? 'yes' : doctor?.acceptsPrivate === false ? 'no' : '',
    monthlyConsultations: str(doctor?.monthlyConsultations),
    monthlyPrivateConsultations: str(doctor?.monthlyPrivateConsultations),
    consultationFee: str(doctor?.consultationFee),
    visitHours: (doctor?.visitHours ?? []).map((entry) => ({ ...entry, weekdays: [...entry.weekdays] })),
    visitPreference: doctor?.visitPreference ?? '',
    isPartner: doctor?.isPartner ?? false,
    partnerSince: doctor?.partnerSince ?? '',
    partnershipNotes: doctor?.partnershipNotes ?? '',
    addressZip: doctor?.addressZip ?? '',
    addressStreet: doctor?.addressStreet ?? '',
    addressNumber: doctor?.addressNumber ?? '',
    addressComplement: doctor?.addressComplement ?? '',
    addressDistrict: doctor?.addressDistrict ?? '',
    addressCity: doctor?.addressCity ?? '',
    addressState: doctor?.addressState ?? '',
    secretaryName: doctor?.secretaryName ?? '',
    secretaryBirthDay: str(doctor?.secretaryBirthDay),
    secretaryBirthMonth: str(doctor?.secretaryBirthMonth),
    secretaryBirthYear: str(doctor?.secretaryBirthYear),
    secretaryPhone: doctor?.secretaryPhone ?? '',
    secretaryNotes: doctor?.secretaryNotes ?? '',
  };
}

/** Vazio → `null`; senão inteiro (ou `NaN`, que a validação local barra). */
function intOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  return /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/** Valor da consulta: aceita vírgula decimal (`350,50`). */
function moneyOrNull(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  // `1.234,56` → `1234.56`; sem vírgula, o ponto já é o decimal.
  const normalized = trimmed.includes(',') ? trimmed.replace(/\./g, '').replace(',', '.') : trimmed;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

const orNull = (value: string) => (value.trim().length > 0 ? value.trim() : null);

/** Mensagem do 409: diz quem já usa o CRM e, se inativo, que o caminho é reativar. */
function crmConflictMessage(details: Record<string, unknown> | undefined): string {
  const existing = (details as Partial<DoctorCrmConflictDetails> | undefined)?.existingDoctor;
  if (!existing?.name) return 'Já existe um médico com este CRM e UF.';
  return existing.isActive
    ? `CRM já cadastrado para ${existing.name}.`
    : `CRM já cadastrado para ${existing.name} (inativo). Reative o cadastro em vez de criar outro.`;
}

/** Mesmas regras do servidor (D-328) — só para não gastar a ida; o backend valida de novo. */
function validate(form: DoctorForm): Record<string, string> {
  const errors: Record<string, string> = {};
  if (form.name.trim().length === 0) errors.name = 'Informe o nome';
  if (normalizeCrm(form.crm) !== null && form.crmUf === '') errors.crmUf = 'Informe a UF do CRM';

  const birthday = (dayKey: string, yearKey: string, day: string, month: string, year: string) => {
    const d = intOrNull(day);
    const m = intOrNull(month);
    const y = intOrNull(year);
    if ((d === null) !== (m === null)) {
      errors[dayKey] = 'Informe dia e mês juntos';
    } else if (d === null || m === null) {
      if (y !== null) errors[yearKey] = 'Ano só com dia e mês';
    } else if (y !== null && (Number.isNaN(y) || y < 1900 || y > new Date().getFullYear())) {
      errors[yearKey] = 'Ano inválido';
    } else if (!isValidBirthday(d, m, y)) {
      errors[dayKey] = 'Data inválida';
    }
  };
  birthday('birthDay', 'birthYear', form.birthDay, form.birthMonth, form.birthYear);
  birthday(
    'secretaryBirthDay',
    'secretaryBirthYear',
    form.secretaryBirthDay,
    form.secretaryBirthMonth,
    form.secretaryBirthYear,
  );

  const total = intOrNull(form.monthlyConsultations);
  const privateCount = intOrNull(form.monthlyPrivateConsultations);
  if (total !== null && Number.isNaN(total)) errors.monthlyConsultations = 'Número inteiro';
  if (privateCount !== null && Number.isNaN(privateCount)) {
    errors.monthlyPrivateConsultations = 'Número inteiro';
  } else if (total !== null && privateCount !== null && privateCount > total) {
    errors.monthlyPrivateConsultations = 'Particulares não pode passar do total';
  } else if (form.acceptsPrivate === 'no' && privateCount !== null && privateCount > 0) {
    errors.monthlyPrivateConsultations = 'Médico não atende particular';
  }
  const fee = moneyOrNull(form.consultationFee);
  if (fee !== null && (Number.isNaN(fee) || fee < 0)) errors.consultationFee = 'Valor inválido';

  for (const row of form.visitHours) {
    if (row.weekdays.length === 0) {
      errors.visitHours = 'Escolha ao menos um dia em cada faixa';
    } else if (!isValidTimeHHMM(row.start) || !isValidTimeHHMM(row.end)) {
      errors.visitHours = 'Informe início e fim (HH:MM)';
    } else if (row.start >= row.end) {
      errors.visitHours = 'O início tem de ser antes do fim';
    }
  }

  if (form.addressZip.trim().length > 0 && normalizeCep(form.addressZip) === null) {
    errors.addressZip = 'CEP com 8 dígitos';
  }
  return errors;
}

function toRequest(form: DoctorForm): CreateDoctorRequest {
  const visitHours: DoctorVisitHours[] = form.visitHours.map((row) => ({
    weekdays: [...row.weekdays].sort((a, b) => a - b),
    start: row.start,
    end: row.end,
  }));
  // Vazio vai como `null`: no PATCH isso limpa o campo, no POST é o mesmo que ausente.
  return {
    name: form.name.trim(),
    crm: orNull(form.crm),
    crmUf: orNull(form.crmUf),
    specialtyId: form.specialtyId || null,
    birthDay: intOrNull(form.birthDay),
    birthMonth: intOrNull(form.birthMonth),
    birthYear: intOrNull(form.birthYear),
    phone: orNull(form.phone),
    email: orNull(form.email),
    responsibleId: form.responsibleId || null,
    notes: orNull(form.notes),
    clinic: orNull(form.clinic),
    acceptsPrivate: form.acceptsPrivate === '' ? null : form.acceptsPrivate === 'yes',
    monthlyConsultations: intOrNull(form.monthlyConsultations),
    monthlyPrivateConsultations: intOrNull(form.monthlyPrivateConsultations),
    consultationFee: moneyOrNull(form.consultationFee),
    visitHours,
    visitPreference: orNull(form.visitPreference),
    isPartner: form.isPartner,
    partnerSince: form.isPartner ? orNull(form.partnerSince) : null,
    partnershipNotes: orNull(form.partnershipNotes),
    addressZip: orNull(form.addressZip),
    addressStreet: orNull(form.addressStreet),
    addressNumber: orNull(form.addressNumber),
    addressComplement: orNull(form.addressComplement),
    addressDistrict: orNull(form.addressDistrict),
    addressCity: orNull(form.addressCity),
    addressState: orNull(form.addressState),
    secretaryName: orNull(form.secretaryName),
    secretaryBirthDay: intOrNull(form.secretaryBirthDay),
    secretaryBirthMonth: intOrNull(form.secretaryBirthMonth),
    secretaryBirthYear: intOrNull(form.secretaryBirthYear),
    secretaryPhone: orNull(form.secretaryPhone),
    secretaryNotes: orNull(form.secretaryNotes),
  };
}

function FormSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="m-0 grid min-w-0 grid-cols-1 gap-md border-0 p-0 md:col-span-2 md:grid-cols-2">
      <legend className="mb-sm p-0 font-heading text-label font-semibold text-text">{title}</legend>
      {children}
    </fieldset>
  );
}

/**
 * Cadastro/edição do médico (PAGES.md §22 · CRMLAB-86, ampliado no CRMLAB-188,
 * D-328) — aberto pela lista e pela ficha. Seções: Dados do médico, Clínica,
 * Horário para representante, Parceria, Endereço (CEP via ViaCEP) e Secretária.
 */
export function DoctorModal({ doctor, assignees, onClose }: DoctorModalProps) {
  const queryClient = useQueryClient();
  const handleApiError = useApiErrorHandler();
  const { toast } = useToast();
  const role = useAuthStore((s) => s.user?.role);
  const canManageSpecialties = role === 'manager' || role === 'admin';
  const isEdit = doctor !== undefined;

  const [form, setForm] = useState<DoctorForm>(() => toForm(doctor));
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [newSpecialty, setNewSpecialty] = useState<string | null>(null);

  const specialtiesQuery = useQuery({
    queryKey: queryKeys.doctorSpecialties(),
    queryFn: () => doctorsApi.specialties(),
  });
  // Ativas + a atual do médico (mesmo inativa: quem já usa continua com ela).
  const specialties = (specialtiesQuery.data?.specialties ?? []).filter(
    (s) => s.isActive || s.id === doctor?.specialtyId,
  );

  const save = useMutation({
    mutationFn: (body: CreateDoctorRequest) => (doctor ? doctorsApi.update(doctor.id, body) : doctorsApi.create(body)),
    onSuccess: () => {
      toast(isEdit ? 'Médico atualizado' : 'Médico cadastrado', { tone: 'positive' });
      void queryClient.invalidateQueries({ queryKey: queryScopes.doctors });
      onClose();
    },
    onError: (error) => {
      if (isApiError(error) && error.code === 'DOCTOR_CRM_ALREADY_EXISTS') {
        setFieldErrors({ crm: crmConflictMessage(error.details) });
        return;
      }
      if (isApiError(error) && error.code === 'VALIDATION_ERROR') {
        const fields = mapFieldErrors(error.details);
        if (Object.keys(fields).length > 0) {
          // Erros do zod em faixa (`visitHours.0.start`) caem no bloco inteiro.
          const merged: Record<string, string> = {};
          for (const [key, message] of Object.entries(fields)) {
            merged[key.startsWith('visitHours') ? 'visitHours' : key] = message;
          }
          setFieldErrors(merged);
          return;
        }
      }
      handleApiError(error);
    },
  });

  const createSpecialty = useMutation({
    mutationFn: (name: string) => doctorsApi.createSpecialty({ name }),
    onSuccess: (specialty: DoctorSpecialty) => {
      void queryClient.invalidateQueries({ queryKey: ['doctors', 'specialties'] });
      set('specialtyId', specialty.id);
      setNewSpecialty(null);
      toast('Especialidade criada', { tone: 'positive' });
    },
    onError: (error) => {
      if (isApiError(error) && error.code === 'DOCTOR_SPECIALTY_ALREADY_EXISTS') {
        const existing = (error.details as Partial<DoctorSpecialtyConflictDetails> | undefined)?.existingSpecialty;
        if (existing?.isActive) {
          set('specialtyId', existing.id);
          setNewSpecialty(null);
          toast(`"${existing.name}" já está na lista — selecionada.`, { tone: 'positive' });
          return;
        }
        setFieldErrors((current) => ({ ...current, specialtyId: 'Já existe (inativa) na lista do laboratório' }));
        return;
      }
      handleApiError(error);
    },
  });

  function clearError(field: string) {
    if (fieldErrors[field]) setFieldErrors(({ [field]: _removed, ...rest }) => rest);
  }

  function set<K extends keyof DoctorForm>(field: K, value: DoctorForm[K]) {
    setForm((current) => ({ ...current, [field]: value }));
    clearError(field);
  }

  /** Props comuns de um `Input` de texto ligado ao formulário. */
  function bind(field: TextKey) {
    return {
      value: form[field],
      onChange: (e: { target: { value: string } }) => set(field, e.target.value),
      error: fieldErrors[field],
    };
  }

  async function handleZipChange(value: string) {
    set('addressZip', value);
    const cep = normalizeCep(value);
    if (cep === null) return;
    const found = await lookupCep(cep);
    if (!found) return; // falha em silêncio: a pessoa digita
    // Só preenche o que estiver vazio — não pisa no que já foi digitado.
    setForm((current) => ({
      ...current,
      addressStreet: current.addressStreet || found.street,
      addressDistrict: current.addressDistrict || found.district,
      addressCity: current.addressCity || found.city,
      addressState: current.addressState || found.state,
      addressComplement: current.addressComplement || found.complement,
    }));
  }

  function updateRow(index: number, patch: Partial<VisitHoursRow>) {
    set(
      'visitHours',
      form.visitHours.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  }

  function toggleWeekday(index: number, day: Weekday) {
    const row = form.visitHours[index];
    if (!row) return;
    updateRow(index, {
      weekdays: row.weekdays.includes(day) ? row.weekdays.filter((d) => d !== day) : [...row.weekdays, day],
    });
  }

  function handleSubmit(event?: FormEvent) {
    event?.preventDefault();
    const errors = validate(form);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    save.mutate(toRequest(form));
  }

  // O responsável atual pode ter sido desativado e sumir da lista de ativos:
  // ele continua aparecendo para o formulário não trocar a carteira sozinho.
  const responsibleOptions = [
    { value: '', label: 'Sem responsável' },
    ...assignees.map((a) => ({ value: a.id, label: a.name })),
  ];
  if (doctor?.responsible && !assignees.some((a) => a.id === doctor.responsible?.id)) {
    responsibleOptions.push({ value: doctor.responsible.id, label: `${doctor.responsible.name} (inativo)` });
  }

  const ufOptions = [{ value: '', label: '—' }, ...BRAZIL_UFS.map((uf) => ({ value: uf, label: uf }))];
  // Texto livre antigo sem correspondência na lista (médico ainda sem `specialtyId`).
  const legacySpecialty = doctor && !doctor.specialtyId && doctor.specialty ? doctor.specialty : null;

  return (
    <Modal
      open
      onClose={onClose}
      dismissible={false}
      title={isEdit ? 'Editar médico' : 'Novo médico'}
      footer={
        <div className="ml-auto flex gap-md">
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="primary" onClick={() => handleSubmit()} loading={save.isPending}>
            {isEdit ? 'Salvar' : 'Cadastrar'}
          </Button>
        </div>
      }
    >
      <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-lg md:grid-cols-2" noValidate>
        <FormSection title="Dados do médico">
          <div className="md:col-span-2">
            <Input label="Nome" required {...bind('name')} />
          </div>
          <Input label="CRM" hint="Opcional. Só os números." inputMode="numeric" {...bind('crm')} />
          <Select
            label="UF do CRM"
            value={form.crmUf}
            onChange={(e) => set('crmUf', e.target.value)}
            options={ufOptions}
            error={fieldErrors.crmUf}
          />
          <div className="flex flex-col gap-xs md:col-span-2">
            <Select
              label="Especialidade"
              value={form.specialtyId}
              onChange={(e) => set('specialtyId', e.target.value)}
              options={[
                { value: '', label: 'Sem especialidade' },
                ...specialties.map((s) => ({ value: s.id, label: s.isActive ? s.name : `${s.name} (inativa)` })),
              ]}
              error={fieldErrors.specialtyId}
            />
            {legacySpecialty && (
              <p className="m-0 text-caption text-neutral-600">Texto antigo: {legacySpecialty}</p>
            )}
            {canManageSpecialties &&
              (newSpecialty === null ? (
                <div>
                  <Button variant="secondary" size="sm" onClick={() => setNewSpecialty('')}>
                    + nova especialidade
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap items-end gap-sm">
                  <div className="min-w-0 flex-1">
                    <Input
                      label="Nova especialidade"
                      value={newSpecialty}
                      maxLength={120}
                      onChange={(e) => setNewSpecialty(e.target.value)}
                    />
                  </div>
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={newSpecialty.trim().length === 0}
                    loading={createSpecialty.isPending}
                    onClick={() => createSpecialty.mutate(newSpecialty.trim())}
                  >
                    Criar
                  </Button>
                  <Button variant="secondary" size="sm" onClick={() => setNewSpecialty(null)}>
                    Cancelar
                  </Button>
                </div>
              ))}
          </div>
          <div className="grid grid-cols-3 gap-sm md:col-span-2">
            <Input label="Aniversário — dia" inputMode="numeric" {...bind('birthDay')} />
            <Input label="Mês" inputMode="numeric" {...bind('birthMonth')} />
            <Input label="Ano (opcional)" inputMode="numeric" {...bind('birthYear')} />
          </div>
          <Input label="Telefone/WhatsApp" type="tel" {...bind('phone')} />
          <Input label="E-mail" type="email" {...bind('email')} />
          <div className="md:col-span-2">
            <Select
              label="Responsável pela carteira"
              value={form.responsibleId}
              onChange={(e) => set('responsibleId', e.target.value)}
              options={responsibleOptions}
              error={fieldErrors.responsibleId}
            />
          </div>
          <div className="md:col-span-2">
            <TextArea label="Observações" rows={3} {...bind('notes')} />
          </div>
        </FormSection>

        <FormSection title="Clínica">
          <Input label="Clínica/consultório" {...bind('clinic')} />
          <Select
            label="Atende particular"
            value={form.acceptsPrivate}
            onChange={(e) => set('acceptsPrivate', e.target.value as AcceptsPrivateChoice)}
            options={[
              { value: '', label: 'Não informado' },
              { value: 'yes', label: 'Sim' },
              { value: 'no', label: 'Não' },
            ]}
            error={fieldErrors.acceptsPrivate}
          />
          <Input label="Consultas/mês" inputMode="numeric" {...bind('monthlyConsultations')} />
          <Input label="Particulares/mês" inputMode="numeric" {...bind('monthlyPrivateConsultations')} />
          <Input label="Valor da consulta (R$)" inputMode="decimal" {...bind('consultationFee')} />
        </FormSection>

        <FormSection title="Horário para representante">
          <div className="flex flex-col gap-sm md:col-span-2">
            {form.visitHours.map((row, index) => (
              <div
                key={index}
                className="flex flex-col gap-sm rounded-md border border-neutral-200 p-md"
                data-testid="visit-hours-row"
              >
                <div className="flex flex-wrap gap-sm" role="group" aria-label={`Dias da faixa ${index + 1}`}>
                  {WEEKDAYS.map((day) => (
                    <label key={day} className="inline-flex items-center gap-xs text-caption text-text">
                      <input
                        type="checkbox"
                        checked={row.weekdays.includes(day)}
                        onChange={() => toggleWeekday(index, day)}
                      />
                      {WEEKDAY_SHORT_LABELS[day]}
                    </label>
                  ))}
                </div>
                <div className="flex flex-wrap items-end gap-sm">
                  <div className="w-32">
                    <Input
                      label="Início"
                      type="time"
                      value={row.start}
                      onChange={(e) => updateRow(index, { start: e.target.value })}
                    />
                  </div>
                  <div className="w-32">
                    <Input
                      label="Fim"
                      type="time"
                      value={row.end}
                      onChange={(e) => updateRow(index, { end: e.target.value })}
                    />
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-label={`Remover faixa ${index + 1}`}
                    onClick={() =>
                      set(
                        'visitHours',
                        form.visitHours.filter((_, i) => i !== index),
                      )
                    }
                  >
                    Remover
                  </Button>
                </div>
              </div>
            ))}
            {fieldErrors.visitHours && (
              <p role="alert" className="m-0 font-body text-caption text-accent-700">
                {fieldErrors.visitHours}
              </p>
            )}
            {form.visitHours.length < DOCTOR_VISIT_HOURS_MAX && (
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => set('visitHours', [...form.visitHours, { weekdays: [], start: '', end: '' }])}
                >
                  + faixa
                </Button>
              </div>
            )}
          </div>
          <div className="md:col-span-2">
            <Input label="Observação de horário" placeholder="Ex.: terças à tarde" {...bind('visitPreference')} />
          </div>
        </FormSection>

        <FormSection title="Parceria">
          <div className="flex items-center md:col-span-2">
            <Toggle checked={form.isPartner} onChange={(checked) => set('isPartner', checked)} label="É parceiro" />
          </div>
          {form.isPartner && <Input label="Parceiro desde" type="date" {...bind('partnerSince')} />}
          <div className="md:col-span-2">
            <TextArea label="Anotações da parceria" rows={2} {...bind('partnershipNotes')} />
          </div>
        </FormSection>

        <FormSection title="Endereço">
          <Input
            label="CEP"
            inputMode="numeric"
            hint="Com 8 dígitos o endereço é buscado sozinho."
            value={form.addressZip}
            onChange={(e) => void handleZipChange(e.target.value)}
            error={fieldErrors.addressZip}
          />
          <Input label="Logradouro" {...bind('addressStreet')} />
          <Input label="Número" {...bind('addressNumber')} />
          <Input label="Complemento" {...bind('addressComplement')} />
          <Input label="Bairro" {...bind('addressDistrict')} />
          <Input label="Cidade" {...bind('addressCity')} />
          <Select
            label="UF"
            value={form.addressState}
            onChange={(e) => set('addressState', e.target.value)}
            options={ufOptions}
            error={fieldErrors.addressState}
          />
          {doctor?.address && (
            <p className="m-0 text-caption text-neutral-600 md:col-span-2">Endereço antigo (texto): {doctor.address}</p>
          )}
        </FormSection>

        <FormSection title="Secretária">
          <div className="md:col-span-2">
            <Input label="Nome da secretária" {...bind('secretaryName')} />
          </div>
          <div className="grid grid-cols-3 gap-sm md:col-span-2">
            <Input label="Aniversário — dia" inputMode="numeric" {...bind('secretaryBirthDay')} />
            <Input label="Mês" inputMode="numeric" {...bind('secretaryBirthMonth')} />
            <Input label="Ano (opcional)" inputMode="numeric" {...bind('secretaryBirthYear')} />
          </div>
          <Input label="Telefone/WhatsApp da secretária" type="tel" {...bind('secretaryPhone')} />
          <div className="md:col-span-2">
            <TextArea label="Anotações sobre a secretária" rows={2} {...bind('secretaryNotes')} />
          </div>
        </FormSection>
      </form>
    </Modal>
  );
}
