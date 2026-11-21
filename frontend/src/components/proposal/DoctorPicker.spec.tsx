import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { doctorsApi } from '@/api/doctors';
import { buildDoctor } from '@/test/doctor-fixtures';
import { DoctorPicker, type DoctorPickerValue } from './DoctorPicker';

/** Médico solicitante com busca no cadastro (CRMLAB-188, D-328). */
vi.mock('@/api/doctors', () => ({
  doctorsApi: { list: vi.fn() },
}));

const listMock = vi.mocked(doctorsApi.list);

function Harness({ initial, spy }: { initial: DoctorPickerValue; spy: (value: DoctorPickerValue) => void }) {
  const [value, setValue] = useState(initial);
  return (
    <DoctorPicker
      value={value}
      onChange={(next) => {
        spy(next);
        setValue(next);
      }}
    />
  );
}

function renderPicker(initial: DoctorPickerValue = { text: '', doctorId: null, doctorName: null }) {
  const spy = vi.fn();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Harness initial={initial} spy={spy} />
    </QueryClientProvider>,
  );
  return spy;
}

describe('DoctorPicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    listMock.mockResolvedValue({
      doctors: [buildDoctor({ id: 'doc-1', name: 'Dra. Júlia Costa', crm: '12345', crmUf: 'SC' })],
      pagination: { page: 1, limit: 8, total: 1, totalPages: 1 },
    });
  });

  it('busca médicos ativos por nome/CRM e vincular preenche o texto com o nome', async () => {
    const user = userEvent.setup({ delay: null });
    const spy = renderPicker();

    await user.type(screen.getByLabelText('Buscar médico no cadastro'), 'júlia');
    await waitFor(() => expect(listMock).toHaveBeenCalledWith({ search: 'júlia', active: true, limit: 8 }));
    await user.click(await screen.findByRole('button', { name: /Dra\. Júlia Costa · CRM 12345\/SC/ }));

    expect(spy).toHaveBeenLastCalledWith({ text: 'Dra. Júlia Costa', doctorId: 'doc-1', doctorName: 'Dra. Júlia Costa' });
    expect(screen.getByLabelText('Médico solicitante (opcional)')).toHaveValue('Dra. Júlia Costa');
    expect(screen.getByText('Dra. Júlia Costa', { selector: 'span.font-semibold' })).toBeInTheDocument();
  });

  it('[desvincular] limpa só o vínculo; o texto fica', async () => {
    const user = userEvent.setup({ delay: null });
    const spy = renderPicker({ text: 'Dra. Júlia', doctorId: 'doc-1', doctorName: 'Dra. Júlia Costa' });

    await user.click(screen.getByRole('button', { name: 'Desvincular' }));
    expect(spy).toHaveBeenLastCalledWith({ text: 'Dra. Júlia', doctorId: null, doctorName: null });
    expect(screen.getByLabelText('Buscar médico no cadastro')).toBeInTheDocument();
  });

  it('texto livre sem vínculo continua possível', async () => {
    const user = userEvent.setup({ delay: null });
    const spy = renderPicker();
    await user.type(screen.getByLabelText('Médico solicitante (opcional)'), 'Dr. X');
    expect(spy).toHaveBeenLastCalledWith({ text: 'Dr. X', doctorId: null, doctorName: null });
    expect(listMock).not.toHaveBeenCalled();
  });
});
