import { normalizeCep } from '@crm-lab/shared';

/** O que o ViaCEP devolve e o formulário do médico aproveita. */
export interface CepAddress {
  street: string;
  district: string;
  city: string;
  state: string;
  complement: string;
}

const TIMEOUT_MS = 5000;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Consulta o CEP no ViaCEP, DIRETO do navegador (D-328 item 6): endereço de
 * consultório, sem dado de paciente, e nada a cachear no servidor.
 *
 * Falha em silêncio: CEP inválido, inexistente (`{ erro: true }`), rede fora,
 * timeout ou resposta estranha → `null`, e a pessoa digita o endereço.
 */
export async function lookupCep(value: string, fetchImpl: typeof fetch = fetch): Promise<CepAddress | null> {
  const cep = normalizeCep(value);
  if (cep === null) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(`https://viacep.com.br/ws/${cep}/json/`, { signal: controller.signal });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null) return null;
    const data = body as Record<string, unknown>;
    if (data.erro !== undefined) return null;
    return {
      street: text(data.logradouro),
      district: text(data.bairro),
      city: text(data.localidade),
      state: text(data.uf).toUpperCase(),
      complement: text(data.complemento),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
