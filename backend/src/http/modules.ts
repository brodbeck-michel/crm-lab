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
import { examPackageModule } from '../controllers/exam-package.routes.js';
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
import { insuranceModule } from '../controllers/insurance.routes.js';
import { quickReplyModule } from '../controllers/quick-reply.routes.js';
import { mediaModule } from '../controllers/media.routes.js';
import { attendantModule } from '../controllers/attendant.routes.js';
import { lisImportModule } from '../controllers/lis-import.routes.js';
import { commissionSettingsModule } from '../controllers/commission-settings.routes.js';
import { lisAnalyticsModule } from '../controllers/lis-analytics.routes.js';
import { salesModule } from '../controllers/sales.routes.js';
import { executiveReportModule } from '../controllers/executive-report.routes.js';

export const apiModuleFactories: ApiModuleFactory[] = [
  examModule, // GET/POST/PATCH /exams — API_CONTRACTS.md §4
  examPackageModule, // GET/POST/PATCH /exam-packages[/:id/prices] — API_CONTRACTS.md §4b (CRMLAB-10)
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
  insuranceModule, // GET|POST /insurances, PATCH /insurances/:id — API_CONTRACTS.md §8
  quickReplyModule, // GET|POST /quick-replies, PATCH|DELETE /quick-replies/:id — API_CONTRACTS.md §9
  mediaModule, // GET /media/:id — API_CONTRACTS.md §2d (Onda 8 §4)
  attendantModule, // GET|POST /attendants, PATCH /attendants/:id — API_CONTRACTS.md §12 (Onda 9)
  lisImportModule, // GET|POST /lis-imports, GET /lis-imports/latest, POST /lis-imports/purge — API_CONTRACTS.md §10.1 (Onda 9)
  commissionSettingsModule, // GET|PATCH /settings/commissions — API_CONTRACTS.md §6b (Onda 9)
  lisAnalyticsModule, // GET /lis-budgets[/summary|/pending|/pending/summary|/filters] — API_CONTRACTS.md §10.2 (Onda 9)
  salesModule, // GET|POST /sales, DELETE /sales/:id, GET /sales/summary — API_CONTRACTS.md §11 (Onda 9)
  executiveReportModule, // GET /reports/executive — API_CONTRACTS.md §5c (Onda 9)
  // <- agentes de API: adicione o factory do seu modulo aqui
];
