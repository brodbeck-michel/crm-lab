import { useState } from 'react';
import { HOLIDAY_DESCRIPTION_MAX, type Holiday } from '@crm-lab/shared';
import { useCreateHoliday, useDeleteHoliday, useHolidays } from '@/api/holidays';
import { Button, Input, useToast } from '@/components/ui';

/**
 * Seção "Feriados" da página de Regras (PAGES.md §21, CRMLAB-62 — D-213).
 * Fora do formulário das Regras: cada inclusão/remoção é salva na hora em
 * `/settings/holidays`. Os nacionais vêm prontos (só leitura); os do
 * laboratório, gestor e admin incluem e removem. Atendente só vê.
 */

/** `2026-03-19` -> `19/03`. */
function dayMonth(date: string): string {
  return `${date.slice(8, 10)}/${date.slice(5, 7)}`;
}

function HolidayRow({
  holiday,
  onRemove,
  removing,
}: {
  holiday: Holiday;
  onRemove?: () => void;
  removing?: boolean;
}) {
  return (
    <li className="flex items-center justify-between gap-md py-xs font-body text-body text-text">
      <span>
        <span className="inline-block w-16 font-semibold tabular-nums">{dayMonth(holiday.date)}</span>
        {holiday.description}
      </span>
      {onRemove && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          loading={removing}
          aria-label={`Remover ${holiday.description}`}
          onClick={onRemove}
        >
          Remover
        </Button>
      )}
    </li>
  );
}

export function HolidaysSection({ canEdit, now = new Date() }: { canEdit: boolean; now?: Date }) {
  const [year, setYear] = useState(now.getFullYear());
  const { data, isLoading, isError } = useHolidays(year);
  const createHoliday = useCreateHoliday();
  const deleteHoliday = useDeleteHoliday();
  const { toast } = useToast();
  const [date, setDate] = useState('');
  const [description, setDescription] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  function handleAdd(event: React.FormEvent) {
    event.preventDefault();
    setErrors({});
    createHoliday.mutate(
      { date, description },
      {
        onSuccess: (created) => {
          setDate('');
          setDescription('');
          setYear(Number(created.date.slice(0, 4)));
          toast('Feriado incluído.', { tone: 'positive' });
        },
        onError: (err) => {
          const fields = (err as { details?: { fields?: Record<string, string> } })?.details?.fields;
          setErrors(fields ?? {});
          toast(fields ? 'Confira os campos destacados.' : 'Não foi possível incluir o feriado.', {
            tone: 'attention',
          });
        },
      },
    );
  }

  return (
    <section
      id="feriados"
      aria-labelledby="feriados-titulo"
      className="space-y-md rounded-lg border border-neutral-200 bg-surface p-lg"
    >
      <div className="space-y-xs">
        <h2 id="feriados-titulo" className="font-heading text-section text-text">
          Feriados
        </h2>
        <p className="font-body text-caption text-neutral-600">
          Em feriado o reingajamento não envia. Os nacionais já vêm prontos; cadastre aqui os
          municipais, estaduais e os dias sem expediente do laboratório.
        </p>
      </div>

      <div className="flex items-center gap-sm">
        <Button type="button" variant="secondary" size="sm" aria-label="Ano anterior" onClick={() => setYear(year - 1)}>
          ‹
        </Button>
        <span className="font-body text-label font-semibold text-text" data-testid="feriados-ano">
          {year}
        </span>
        <Button type="button" variant="secondary" size="sm" aria-label="Próximo ano" onClick={() => setYear(year + 1)}>
          ›
        </Button>
      </div>

      {isLoading && <p className="font-body text-caption text-neutral-600">Carregando...</p>}
      {isError && (
        <p className="font-body text-caption text-neutral-600">Não foi possível carregar os feriados.</p>
      )}

      {data && (
        <div className="grid gap-lg md:grid-cols-2">
          <div className="space-y-xs">
            <h3 className="font-body text-caption font-semibold text-neutral-700">Do laboratório</h3>
            {data.custom.length === 0 ? (
              <p className="font-body text-caption text-neutral-600">Nenhum feriado cadastrado em {year}.</p>
            ) : (
              <ul aria-label="Feriados do laboratório" className="divide-y divide-neutral-200">
                {data.custom.map((holiday) => (
                  <HolidayRow
                    key={holiday.id ?? holiday.date}
                    holiday={holiday}
                    removing={deleteHoliday.isPending && deleteHoliday.variables === holiday.id}
                    onRemove={
                      canEdit && holiday.id
                        ? () =>
                            deleteHoliday.mutate(holiday.id ?? '', {
                              onSuccess: () => toast('Feriado removido.', { tone: 'positive' }),
                              onError: () =>
                                toast('Não foi possível remover o feriado.', { tone: 'attention' }),
                            })
                        : undefined
                    }
                  />
                ))}
              </ul>
            )}
          </div>
          <div className="space-y-xs">
            <h3 className="font-body text-caption font-semibold text-neutral-700">Nacionais</h3>
            <ul aria-label="Feriados nacionais" className="divide-y divide-neutral-200">
              {data.national.map((holiday) => (
                <HolidayRow key={holiday.date} holiday={holiday} />
              ))}
            </ul>
          </div>
        </div>
      )}

      {canEdit && (
        <form onSubmit={handleAdd} className="flex flex-wrap items-end gap-md" aria-label="Incluir feriado">
          <div className="w-44">
            <Input
              type="date"
              label="Data"
              value={date}
              error={errors.date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div className="min-w-0 flex-1">
            <Input
              label="Descrição"
              value={description}
              maxLength={HOLIDAY_DESCRIPTION_MAX}
              error={errors.description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <Button
            type="submit"
            variant="primary"
            loading={createHoliday.isPending}
            disabled={date === '' || description.trim() === ''}
          >
            Incluir feriado
          </Button>
        </form>
      )}
    </section>
  );
}
