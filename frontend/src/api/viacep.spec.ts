import { describe, expect, it, vi } from 'vitest';
import { lookupCep } from './viacep';

/** ViaCEP direto do navegador, falha silenciosa (CRMLAB-188, D-328). */
function fakeFetch(response: { ok: boolean; body?: unknown } | Error) {
  return vi.fn(async () => {
    if (response instanceof Error) throw response;
    return { ok: response.ok, json: async () => response.body } as Response;
  }) as unknown as typeof fetch;
}

describe('lookupCep', () => {
  it('CEP válido devolve o endereço normalizado e chama a URL do ViaCEP com 8 dígitos', async () => {
    const fetchImpl = fakeFetch({
      ok: true,
      body: { logradouro: 'Rua A ', bairro: 'Centro', localidade: 'Tubarão', uf: 'sc', complemento: '' },
    });
    await expect(lookupCep('88701-100', fetchImpl)).resolves.toEqual({
      street: 'Rua A',
      district: 'Centro',
      city: 'Tubarão',
      state: 'SC',
      complement: '',
    });
    expect(fetchImpl).toHaveBeenCalledWith('https://viacep.com.br/ws/88701100/json/', expect.anything());
  });

  it('CEP incompleto nem chama a rede', async () => {
    const fetchImpl = fakeFetch({ ok: true, body: {} });
    await expect(lookupCep('8870', fetchImpl)).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('inexistente, HTTP de erro e rede fora viram null', async () => {
    await expect(lookupCep('00000000', fakeFetch({ ok: true, body: { erro: true } }))).resolves.toBeNull();
    await expect(lookupCep('00000000', fakeFetch({ ok: false }))).resolves.toBeNull();
    await expect(lookupCep('00000000', fakeFetch(new Error('offline')))).resolves.toBeNull();
  });
});
