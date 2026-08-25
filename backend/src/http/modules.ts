/**
 * ============================================================================
 * REGISTRO DE MODULOS DA API — o UNICO arquivo que um agente de API edita
 * para plugar o seu router. Uma linha por modulo.
 * ============================================================================
 *
 * Como funciona e quais sao as regras: veja `src/http/api-module.ts`.
 *
 * Exemplo (descomente/adicione a sua linha):
 *
 *   import { authModule } from '../controllers/auth.routes.js';
 *   import { proposalModule } from '../controllers/proposal.routes.js';
 *
 *   export const apiModuleFactories: ApiModuleFactory[] = [
 *     authModule,
 *     proposalModule,
 *   ];
 *
 * Ordem nao importa: os `basePath` nao se sobrepoem. Conflito de `basePath`
 * quebra o boot com mensagem explicita (ver `mountApiModules`).
 */
import type { ApiModuleFactory } from './api-module.js';
import { examModule } from '../controllers/exam.routes.js';
import { auditModule } from '../controllers/audit.routes.js';
import { authModule } from '../controllers/auth.routes.js';
import { themeModule } from '../controllers/theme.routes.js';
import { userModule } from '../controllers/user.routes.js';
import { analyticsModule } from '../controllers/analytics.routes.js';
import { platformModule } from '../controllers/platform.routes.js';
import { proposalModule } from '../controllers/proposal.routes.js';
import { internalChatModule } from '../controllers/internal-chat.routes.js';
import { conversationModule } from '../controllers/conversation.routes.js';
import { webhookModule } from '../controllers/webhook.routes.js';
import { channelSettingsModule } from '../controllers/channel-settings.routes.js';
import { operationModule } from '../controllers/operation.routes.js';
import { patientModule } from '../controllers/patient.routes.js';

export const apiModuleFactories: ApiModuleFactory[] = [
  examModule, // GET/POST/PATCH /exams — API_CONTRACTS.md §4
  authModule, // POST /auth/login|refresh|logout — API_CONTRACTS.md §1
  userModule, // GET /users/me, GET|POST /users, PATCH /users/:id — §1
  themeModule, // GET|PATCH /themes/current, GET /themes/presets — SERVICES.md §8
  auditModule, // GET /audit — SERVICES.md §10
  analyticsModule, // GET /analytics/conversion|pipeline|team — SERVICES.md §9
  platformModule, // GET|POST /platform/tenants, GET /platform/billing — PAGES.md §11
  proposalModule, // GET|POST /proposals, PATCH /proposals/:id/* — API_CONTRACTS.md §3
  internalChatModule, // GET|POST /internal-chat/channels[/:id/messages] — SERVICES.md §7
  conversationModule, // GET|PATCH /conversations[/:id], POST /:id/messages|read — API_CONTRACTS.md §2
  webhookModule, // POST /webhooks/whatsapp[/:tenant][/status] — PUBLICO, autenticado por HMAC
  patientModule, // GET|PATCH /patients[/:id], /:id/timeline|export|anonymize — API_CONTRACTS.md §2c
  channelSettingsModule, // GET|PATCH /settings/channels — API_CONTRACTS.md §6
  operationModule, // GET /operations/overview — API_CONTRACTS.md §7
  // <- agentes de API: adicione o factory do seu modulo aqui
];
