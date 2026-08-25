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

## Segredos — onde cada um mora

| Segredo | Onde | Forma |
|---------|------|-------|
| `JWT_SECRET`, `JWT_REFRESH_SECRET`, `CHANNEL_SECRET_KEY` | env var | claro (nunca no banco, nunca em log — `safeEnv()`) |
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
