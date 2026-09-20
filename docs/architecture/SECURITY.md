# 🔐 Segurança e Isolamento Multitenant

Requisitos de segurança obrigatórios. Violação de qualquer item = bloqueio de release.

---

## Isolamento Multitenant (defesa em 3 camadas)

### Camada 1 — JWT
- `tenantId` vem SEMPRE do token (assinado pelo servidor), NUNCA de header/query/body do cliente
- Middleware extrai e injeta `TenantContext` em toda request autenticada

### Camada 2 — Aplicação
- Todo método de service recebe `tenantId`/`TenantContext` explícito
- Toda query filtra `tenant_id` — repositórios têm base class que FORÇA o filtro
- Recurso de outro tenant → `404 NOT_FOUND` (nunca 403 — não vazar existência)

### Camada 3 — Banco (Row-Level Security)
```sql
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON conversations
  FOR ALL USING (tenant_id = current_setting('app.tenant_id')::uuid);
-- Repetir para TODAS as tabelas de dados de laboratório
```
- Conexão da aplicação usa role SEM `BYPASSRLS`
- `SET app.tenant_id` por transação (middleware de banco)

### Console de Plataforma
- Credenciais, rotas (`/platform/*`) e guards PRÓPRIOS
- Operador NÃO tem caminho para: conversas, mensagens, pacientes, propostas, canais internos de labs
- Isolamento é REQUISITO, não configuração — testes E2E validam
- **Exceção mínima e nomeada (D-102):** `GET /platform/tenants/:id` expõe status de canal
  (`tenant_channels.channel`/`is_active`/`connection_mode`/`connected_at` — nunca
  `phone_number`/`api_token`/`webhook_secret`) e o e-mail de usuários `role = 'admin'` (nunca
  `name`, nunca `manager`/`attendant`). `PATCH /platform/tenants/:id` (ativar/desativar tenant,
  trocar plano) e `POST /platform/tenants/:id/users/:userId/reset-password` (só contra usuário
  `admin` do próprio tenant) são as únicas escritas do console sobre dado de laboratório, ambas
  auditadas. Fora desta lista nomeada, o isolamento acima continua absoluto.

---

## Autenticação

- Senhas: bcrypt cost 12; política mínima 8 chars
- Access token 15 min; refresh 7 dias, armazenado HASHEADO no Redis, rotacionado a cada uso
- Logout revoga refresh; troca de senha revoga TODOS os refresh do usuário
- Login falho: mensagem genérica + rate limit (5 tentativas / 15 min por email+IP)

## Autorização

- Matriz de permissões: `docs/design` §telas + `PAGES.md` (requiredRoles)
- **A UI esconde, o servidor recusa** — toda checagem duplicada no backend
- Alçada de desconto verificada no backend em TODA escrita de proposta

---

## OWASP Top 10 — mitigações obrigatórias

| Risco | Mitigação |
|-------|-----------|
| SQL Injection | ORM + prepared statements; NUNCA concatenar SQL |
| XSS | React escapa por padrão; `dangerouslySetInnerHTML` PROIBIDO; conteúdo de mensagens de pacientes é texto puro |
| CSRF | API stateless com Bearer token (sem cookie de sessão); CORS restrito aos domínios do app |
| Broken Access Control | 3 camadas acima + testes de isolamento em CI |
| Sensitive Data Exposure | HTTPS obrigatório; segredo de infraestrutura só em env var; **credencial de canal por laboratório é cifrada em repouso** (D-076); logs sem PII/tokens/mensagens |
| SSRF | Nenhum fetch de URL fornecida por usuário |
| Rate limiting | 100 req/min por usuário; login mais restrito |

---

## Webhooks (WhatsApp)

- Validar assinatura HMAC ANTES de processar payload
- Endpoint idempotente (dedupe por `external_message_id`)
- Payload inválido → 200 vazio (não dar oráculo a atacante) + log
- **Canal com `isActive: false` recusa a entrada** — antes do HMAC, sem tocar no banco (D-074).
  Desligar o canal é o único gesto que o contrato oferece para conter um segredo vazado, então
  ele desliga os **dois** sentidos: o webhook não entra e o envio não sai.
- **Revogar revoga:** `{"webhookSecret": null}` não devolve o laboratório ao segredo global da
  instalação. Coluna `NULL` = nunca configurou (cai na env var); `''` = revogado (recusa tudo).
  Ver a emenda de D-073.
- **Teto de corpo por rota (CRMLAB-31).** O HMAC só é conferido DEPOIS do `express.json()`
  terminar o parse — corpo gigante custaria CPU/memória ANTES de qualquer rejeição, mesmo sem o
  segredo. `/webhooks/whatsapp*` (Meta, não carrega mídia em base64) leva `express.json({ limit:
  '1mb' })`, registrado por caminho ANTES do parser geral (`app.ts`); `/webhooks/evolution/*`
  (gateway em rede interna, mídia base64) e as demais rotas seguem no limite de `25mb`.

## Conexão WhatsApp por QR (Evolution API, Onda 7 — Bloco B)

**Risco aceito, não mitigado por completo — decisão de produto consciente (lead técnico,
2026-08-30, D-083).** Conectar o número do próprio laboratório sem a API oficial da Meta viola
os Termos de Serviço do WhatsApp e pode resultar em **banimento permanente do número** — a
Meta detecta e bane automações não oficiais, sem aviso prévio nem recurso. Não há mitigação
técnica que elimine esse risco; as salvaguardas abaixo reduzem a chance e limitam o dano, elas
não o removem.

**Salvaguardas obrigatórias (registradas em `docs/DECISIONS.md`):**
- **Termo de aceite explícito e auditado.** `POST /settings/channels/whatsapp/connect` exige
  aceite prévio (checkbox na UI) antes de criar a instância; grava `accepted_terms_at`/
  `accepted_terms_by` em `tenant_channels` (SCHEMA.md §15) **e** audit log
  `accept_whatsapp_qr_terms` — dois registros independentes do mesmo fato, um para a tela
  consultar sem ir ao audit log, outro para a trilha imutável. O termo lista: risco de
  banimento permanente, violação dos ToS, recomendação de número dedicado (não o pessoal),
  necessidade de abrir o app no celular a cada ~14 dias, e que as mensagens transitam pelo
  gateway do CRM.
- **Rate-limit de envio.** Espaçamento mínimo configurável entre mensagens por tenant
  (default ~1.5s + jitter), aplicado na fila de envio (`QueueService`, D-011) — reduz o padrão
  de tráfego que a detecção antiautomação da Meta reconhece.
- **Sem disparo em massa.** Nenhum endpoint de broadcast/campanha existe, e nenhum entra nesta
  onda nem em ondas futuras sem decisão própria — é o uso que mais aproxima o padrão de tráfego
  do de um bot de spam.
- **A UI não distingue banimento de desconexão voluntária** (SERVICES.md §16): o evento
  `loggedOut` do gateway cobre os dois casos e o contrato não tenta diferenciá-los — o termo de
  aceite é o lugar onde o risco é comunicado, não uma mensagem de erro que tentaria adivinhar a
  causa.

**Dado de saúde no gateway self-hosted.** O gateway Evolution roda **dentro da nossa
infraestrutura** (Docker, `docker-compose.yml`/`.prod.yml` — nunca um SaaS de terceiro), então
nenhuma mensagem de paciente sai do nosso perímetro por causa dele. Ainda assim, dois pontos
exigem atenção: (1) **a cifra fim-a-fim do WhatsApp termina no dispositivo vinculado** — o
celular que escaneou o QR — e não no gateway; do ponto de vista do CRM, o texto das mensagens
trafega em claro entre o gateway e o backend, exatamente como já acontece com a API oficial da
Meta hoje (nenhuma mudança de superfície nesse ponto, só de operador do endpoint). (2) o gateway
é **stateful** (sessão do WhatsApp de vida longa) e guarda localmente o que a Evolution precisa
para manter o pareamento — por isso ele não é multi-tenant "de graça": cada laboratório é uma
**instância nomeada** (`tenant-<tenantId>`) isolada por apikey própria, e a apikey é a fronteira
de acesso entre tenants dentro do gateway.
- **apikey por instância cifrada em repouso**: gravada em `tenant_channels.api_token` com a
  **mesma infra** de D-076 (AES-256-GCM, `CHANNEL_SECRET_KEY`) — não uma segunda chave nem um
  segredo em claro novo.
- **Webhook autenticado por token estático** em tempo constante
  (`crypto.timingSafeEqual` contra `EVOLUTION_WEBHOOK_TOKEN`), não HMAC — o gateway Evolution
  não assina o corpo, então o token é a única defesa contra injeção de mensagem falsa; kill
  switch `is_active` verificado **antes** do token (D-074).
- **Imagem fixada em v2.3.7** (D-083) — a última versão do gateway **sem** exigência de
  ativação de licença, evitando de saída a dependência de disponibilidade de um servidor de
  licenças de terceiro (Evolution Foundation) para o WhatsApp do laboratório continuar
  funcionando. A linha 2.4.x (que exige essa ativação, com heartbeat periódico contra o servidor
  deles) fica documentada como **fallback**, para subir só se e quando for necessário. Trocar a
  imagem é configuração de infra, sem tocar no código do CRM — o driver fala o mesmo contrato
  HTTP (`/instance/*`, `/message/sendText/*`) nas duas versões.

## Segredos — onde cada um mora

| Segredo | Onde | Forma |
|---------|------|-------|
| `JWT_SECRET`, `JWT_REFRESH_SECRET`, `CHANNEL_SECRET_KEY` | env var | claro (nunca no banco, nunca em log — `safeEnv()`) |
| `EVOLUTION_API_KEY` (admin do gateway), `EVOLUTION_WEBHOOK_TOKEN` (Onda 7) | env var | claro. Ausência desliga a superfície de QR (`CHANNEL_QR_UNAVAILABLE`), nunca crash |
| `users.password_hash` | banco | hash (bcrypt) |
| `refresh_tokens.token_hash` | banco | hash (SCHEMA.md §14) |
| `tenant_channels.api_token`, `tenant_channels.webhook_secret` | banco | **cifrado** AES-256-GCM com `CHANNEL_SECRET_KEY` (D-076) |

Os dois últimos precisam voltar em claro (o token vai no `Authorization` da API do canal, o
segredo assina o HMAC), então hash não serve — e é por isso que "segredos só em env vars" não
podia ser lido como proibição de guardá-los: a regra real é **não guardar segredo em claro**, e
a chave que os abre não mora no banco. Consequência operacional: `CHANNEL_SECRET_KEY` é
obrigatória em produção (o processo não sobe sem ela) e trocá-la invalida as credenciais já
gravadas — os laboratórios precisam reconectar o canal.

## LGPD

- Exportação de dados do paciente: permissão checada na UI E no servidor; gera audit log
- Apagamento a pedido do titular = anonimização (D-063), e ela alcança, na mesma transação:
  cadastro · cópias denormalizadas de `conversations` · `messages.attachment_url` ·
  o **valor** dos campos pessoais em `audit_logs` (D-075). Limitação declarada: o **texto** das
  mensagens não é reescrito
- Retenção: mensagens e dados de paciente conforme política do tenant (config futura)
- `deleted_at` (soft delete) em dados pessoais; expurgo físico via job agendado

## Auditoria

- Ações críticas → `audit_logs` (append-only): propostas, aprovações, permissões, login, exportação LGPD
- **NUNCA existe `DELETE`** em `audit_logs` — essa regra não tem exceção
- Logs de auditoria não são editáveis via API. **Uma exceção nomeada:** o apagamento LGPD
  (D-075) substitui o **valor** dos campos pessoais por `"[ERASED]"` nas linhas
  `entity_type = 'patient'` do titular apagado, preservando linha, ação, autor, timestamp e as
  **chaves** — a auditoria continua provando *que* a edição aconteceu e *qual* campo mudou.
  A exceção vive em `auditRepo.eraseEntityValues`, dentro da transação de anonimização, e
  nenhum controller a alcança.

---

## Checklist de Release

- [ ] Testes de isolamento multitenant passam (2 tenants, cross-access = 404)
- [ ] Operador de plataforma bloqueado de rotas de laboratório
- [ ] Nenhum segredo em código/commits (scan no CI)
- [ ] `CHANNEL_SECRET_KEY` definida no ambiente de produção (o boot falha sem ela — D-076)
- [ ] Segredo de seed/homologação não derivado de valor público (slug, e-mail) — D-074
- [ ] Rate limiting ativo
- [ ] RLS habilitado em todas as tabelas com tenant_id
- [ ] Dependências sem CVEs críticas (npm audit no CI)
