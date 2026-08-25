import { Link } from 'react-router-dom';
import type { PatientListItem } from '@crm-lab/shared';
import { Avatar, DateDisplay } from '@/components/shared';

/**
 * Busca de pacientes da coluna 1 do inbox — o consumidor de `GET /patients`
 * (API_CONTRACTS.md §2c: "a tela chega aqui pela busca do inbox ou por link
 * direto"; PAGES.md §2 e §3, D-079).
 *
 * Por que aqui e não numa tela de lista própria: a busca do inbox já é o lugar
 * onde o atendente digita nome, telefone ou documento, e a mesma digitação
 * serve às duas perguntas — "onde está a conversa?" e "quem é esse paciente?".
 * O bloco só existe quando há termo de busca; sem termo, a coluna continua
 * sendo a fila de conversas e nada some.
 *
 * Cada linha leva a `/patients/:id`. A lista já vem recortada por papel pelo
 * servidor (D-060): o atendente só recebe paciente com conversa visível a ele,
 * então o link nunca revela cadastro que ele não poderia abrir.
 */

export interface PatientResultsProps {
  /** Termo em vigor. Vazio = o bloco inteiro não é renderizado. */
  term: string;
  patients: PatientListItem[];
  isLoading: boolean;
  isError: boolean;
}

export function PatientResults({ term, patients, isLoading, isError }: PatientResultsProps) {
  if (term.length === 0) return null;

  return (
    <section
      aria-label="Pacientes encontrados"
      className="flex flex-col gap-xs border-t border-neutral-300 px-sm py-sm"
    >
      <h2 className="m-0 px-sm font-heading text-micro font-semibold uppercase text-neutral-600">
        Pacientes
      </h2>

      {isLoading && (
        <p role="status" className="m-0 px-sm py-sm text-caption text-neutral-600">
          Buscando pacientes…
        </p>
      )}

      {!isLoading && isError && (
        <p role="alert" className="m-0 px-sm py-sm text-caption text-accent-700">
          Não foi possível buscar pacientes.
        </p>
      )}

      {!isLoading && !isError && patients.length === 0 && (
        <p className="m-0 px-sm py-sm text-caption text-neutral-600">
          Nenhum paciente com esse nome, telefone ou documento.
        </p>
      )}

      {!isLoading &&
        !isError &&
        patients.map((patient) => (
          <Link
            key={patient.id}
            data-testid="patient-result"
            to={`/patients/${patient.id}`}
            className="flex min-w-0 items-center gap-sm rounded-md px-sm py-sm no-underline transition-colors hover:bg-neutral-100"
          >
            <Avatar name={patient.name ?? patient.phone} size={32} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-body font-semibold text-text">
                {patient.name ?? 'Paciente sem nome'}
              </span>
              <span className="truncate text-caption text-neutral-600">
                {patient.phone}
                {patient.lastInteractionAt !== null && (
                  <>
                    {' · '}
                    <DateDisplay value={patient.lastInteractionAt} variant="relative" />
                  </>
                )}
              </span>
            </span>
          </Link>
        ))}
    </section>
  );
}
