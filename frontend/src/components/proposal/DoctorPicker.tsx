import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { doctorsApi } from '@/api/doctors';
import { queryKeys } from '@/api/query-keys';
import { Button, Input, SearchInput } from '@/components/ui';

/** Quantos médicos a busca mostra. */
const PICKER_LIMIT = 8;
/** Termo mínimo para buscar. */
const MIN_TERM = 2;

export interface DoctorPickerValue {
  /** Texto livre do "Médico solicitante" (`requestingDoctor`). */
  text: string;
  /** Médico do cadastro vinculado. `null` = sem vínculo. */
  doctorId: string | null;
  /** Nome do médico vinculado, para mostrar o vínculo. */
  doctorName: string | null;
}

export interface DoctorPickerProps {
  value: DoctorPickerValue;
  onChange: (value: DoctorPickerValue) => void;
}

/**
 * "Médico solicitante" da proposta com busca no cadastro (PAGES.md —
 * Formulário de proposta, CRMLAB-188, D-328). Escolher um médico vincula o
 * `doctorId` (base da curva ABC) e preenche o texto com o nome; [desvincular]
 * limpa só o vínculo. Texto livre sem vínculo continua valendo.
 */
export function DoctorPicker({ value, onChange }: DoctorPickerProps) {
  const [term, setTerm] = useState('');
  const searching = term.trim().length >= MIN_TERM;

  const results = useQuery({
    queryKey: queryKeys.doctorPicker(term.trim()),
    // `/doctors/lookup` e não `GET /doctors`: a atendente não entra na Visitação (D-329 item 12).
    queryFn: () => doctorsApi.lookup({ search: term.trim(), limit: PICKER_LIMIT }),
    enabled: searching && value.doctorId === null,
  });
  const doctors = results.data?.doctors ?? [];

  return (
    <div className="flex flex-col gap-sm">
      <Input
        label="Médico solicitante (opcional)"
        value={value.text}
        onChange={(e) => onChange({ ...value, text: e.target.value })}
        placeholder="Nome do médico"
        maxLength={255}
      />

      {value.doctorId !== null ? (
        <div className="flex flex-wrap items-center gap-sm text-caption text-neutral-600">
          <span>
            Vinculado ao cadastro: <span className="font-semibold text-text">{value.doctorName ?? 'médico'}</span>
          </span>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => onChange({ ...value, doctorId: null, doctorName: null })}
          >
            Desvincular
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-xs">
          <SearchInput
            placeholder="Buscar no cadastro (nome ou CRM)"
            aria-label="Buscar médico no cadastro"
            onSearch={setTerm}
          />
          {searching && !results.isLoading && doctors.length === 0 && (
            <p className="m-0 text-caption text-neutral-600">Nenhum médico ativo encontrado.</p>
          )}
          {doctors.length > 0 && (
            <ul className="m-0 flex list-none flex-col gap-xs p-0" aria-label="Médicos encontrados">
              {doctors.map((doctor) => (
                <li key={doctor.id}>
                  <button
                    type="button"
                    className="w-full rounded-md border border-neutral-200 bg-neutral-100 px-md py-xs text-left text-caption text-text hover:border-accent"
                    onClick={() => {
                      onChange({ text: doctor.name, doctorId: doctor.id, doctorName: doctor.name });
                      setTerm('');
                    }}
                  >
                    <span className="font-semibold">{doctor.name}</span>
                    {doctor.crm && (
                      <span className="text-neutral-600">
                        {' '}
                        · CRM {doctor.crm}/{doctor.crmUf ?? ''}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
