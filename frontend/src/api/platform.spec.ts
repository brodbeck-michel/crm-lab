import { describe, it, expect, expectTypeOf, vi, beforeEach } from 'vitest';
import type { CreateTenantResponse, TenantSummary } from '@crm-lab/shared';
import { http } from './client';
import { platformApi } from './platform';

vi.mock('./client', () => ({
  http: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
}));

const TENANT: TenantSummary = {
  id: 'tenant-1',
  name: 'Laboratório Sul',
  slug: 'lab-sul',
  isActive: true,
  subscriptionPlan: 'pro',
  subscriptionUntil: '2027-01-31T00:00:00Z',
  userCount: 1,
  createdAt: '2026-08-25T12:00:00Z',
};

describe('platformApi.createTenant — envelope de resposta (D-070)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  /**
   * `POST /platform/tenants` era o ÚNICO ponto da API que envelopava um recurso
   * singular (`{ tenant }`). D-070 alinhou com o resto: devolve o recurso cru.
   * Se o backend voltar a envelopar, o consumidor lê `undefined` em silêncio —
   * por isso o formato é teste, não convenção de leitura.
   */
  it('devolve o TenantSummary cru, sem chave `tenant`', async () => {
    vi.mocked(http.post).mockResolvedValue(TENANT);

    const created = await platformApi.createTenant({
      name: 'Laboratório Sul',
      slug: 'lab-sul',
      plan: 'pro',
      adminName: 'Admin Sul',
      adminEmail: 'admin@labsul.com.br',
      adminPassword: 'senha-super-segura',
    });

    expect(created).toEqual(TENANT);
    expect(created.id).toBe('tenant-1');
    expect(created.slug).toBe('lab-sul');
    expect(created).not.toHaveProperty('tenant');
  });

  /**
   * `platform.ts` e um PASS-THROUGH: `http.post` devolve o que o mock mandou e
   * `createTenant` repassa. Ou seja, a asserção de runtime acima morre se
   * alguem voltar a DESEMBRULHAR (`.then((r) => r.tenant)`), mas passaria
   * identica se o envelope `{ tenant }` nunca tivesse sido removido — o mock
   * dita o formato, nao o contrato.
   *
   * Quem guarda a D-070 de verdade e o TIPO: se `CreateTenantResponse` voltar a
   * ser `{ tenant: TenantSummary }`, isto aqui para de compilar e
   * `npm run typecheck` fica vermelho, mesmo com todo teste de runtime verde.
   */
  it('o contrato é o recurso CRU: `CreateTenantResponse` é `TenantSummary`', () => {
    expectTypeOf<CreateTenantResponse>().toEqualTypeOf<TenantSummary>();
    expectTypeOf<Awaited<ReturnType<typeof platformApi.createTenant>>>().toEqualTypeOf<
      TenantSummary
    >();
  });

  it('posta no endpoint do contrato', async () => {
    vi.mocked(http.post).mockResolvedValue(TENANT);

    await platformApi.createTenant({
      name: 'Laboratório Sul',
      slug: 'lab-sul',
      plan: 'starter',
      adminName: 'Admin Sul',
      adminEmail: 'admin@labsul.com.br',
      adminPassword: 'senha-super-segura',
    });

    expect(vi.mocked(http.post).mock.calls[0]?.[0]).toBe('/platform/tenants');
  });
});
