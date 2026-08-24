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
| Sensitive Data Exposure | HTTPS obrigatório; segredos só em env vars; logs sem PII/tokens/mensagens |
| SSRF | Nenhum fetch de URL fornecida por usuário |
| Rate limiting | 100 req/min por usuário; login mais restrito |

---

## Webhooks (WhatsApp)

- Validar assinatura HMAC ANTES de processar payload
- Endpoint idempotente (dedupe por `external_message_id`)
- Payload inválido → 200 vazio (não dar oráculo a atacante) + log

## LGPD

- Exportação de dados do paciente: permissão checada na UI E no servidor; gera audit log
- Retenção: mensagens e dados de paciente conforme política do tenant (config futura)
- `deleted_at` (soft delete) em dados pessoais; expurgo físico via job agendado

## Auditoria

- Ações críticas → `audit_logs` (append-only): propostas, aprovações, permissões, login, exportação LGPD
- Logs de auditoria NUNCA são editáveis via API

---

## Checklist de Release

- [ ] Testes de isolamento multitenant passam (2 tenants, cross-access = 404)
- [ ] Operador de plataforma bloqueado de rotas de laboratório
- [ ] Nenhum segredo em código/commits (scan no CI)
- [ ] Rate limiting ativo
- [ ] RLS habilitado em todas as tabelas com tenant_id
- [ ] Dependências sem CVEs críticas (npm audit no CI)
