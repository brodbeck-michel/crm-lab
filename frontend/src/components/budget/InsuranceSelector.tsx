import { useInsuranceList } from '@/api/insurances';
import { Select } from '@/components/ui';

/**
 * Valor do `<option>` fixo "Particular" — nunca vem da API (D-082: particular
 * é a AUSÊNCIA de convênio, não uma linha de `insurances`). `<select>` HTML
 * não representa `null` nativamente, então a string vazia é o mapeamento
 * local para `insuranceId: null`.
 */
const PARTICULAR_OPTION_VALUE = '';

interface InsuranceSelectorProps {
  /** `null` = particular. */
  value: string | null;
  onChange: (insuranceId: string | null) => void;
}

/**
 * Seletor de convênio do orçamento (`/budget/new`, Onda 7, D-082).
 *
 * "Particular" é sempre a primeira opção e nunca some, mesmo com o catálogo
 * de convênios vazio — é o estado inicial e o mais comum (paciente sem
 * convênio), não um item de uma lista carregada.
 */
export default function InsuranceSelector({ value, onChange }: InsuranceSelectorProps) {
  const { data } = useInsuranceList({ active: true, limit: 100 });
  const insurances = data?.insurances ?? [];

  const options = [
    { value: PARTICULAR_OPTION_VALUE, label: 'Particular' },
    ...insurances.map((insurance) => ({ value: insurance.id, label: insurance.name })),
  ];

  return (
    <Select
      label="Convênio"
      value={value ?? PARTICULAR_OPTION_VALUE}
      onChange={(event) => {
        const next = event.target.value;
        onChange(next === PARTICULAR_OPTION_VALUE ? null : next);
      }}
      options={options}
    />
  );
}
