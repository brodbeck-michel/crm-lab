/**
 * Credenciais de canal para os testes: um segredo fixo e um mapa slug -> tenant.
 * Fica fora dos `.spec.ts` de proposito — importar um spec de outro faria o
 * vitest registrar as mesmas suites duas vezes.
 */
import type {
  WhatsAppCredentials,
  WhatsAppCredentialsResolver,
} from '../../src/services/whatsapp.service.js';

export const TEST_WEBHOOK_SECRET = 'segredo-de-teste';

export function testCredentialsResolver(
  slugToId: Map<string, string>,
): WhatsAppCredentialsResolver {
  const build = (tenantId: string): WhatsAppCredentials => ({
    tenantId,
    phoneNumberId: 'numero-do-lab',
    apiUrl: '',
    apiToken: '',
    webhookSecret: TEST_WEBHOOK_SECRET,
    // Canal ligado e token nunca revogado: o cenario default (D-074).
    isActive: true,
    apiTokenRevoked: false,
    connectionMode: 'cloud_api',
    qrInstanceApiKey: null,
  });
  return {
    forTenant: async (tenantId) => build(tenantId),
    byWebhookIdentity: async (identity) => {
      const tenantId = slugToId.get(identity);
      return tenantId ? build(tenantId) : null;
    },
  };
}
