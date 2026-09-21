# 🤝 Contrato Frontend ↔ Backend

Resumo executivo da integração. Detalhes de shapes em `docs/api/API_CONTRACTS.md`; este arquivo define as REGRAS do contrato.

---

## Princípios

1. **O shape documentado é lei.** Frontend e backend implementam exatamente `API_CONTRACTS.md`. Divergência = bug de quem divergiu do doc.
2. **Tipos compartilhados** em `shared/types/` espelham os contratos — mudança de shape quebra compilação dos dois lados (proposital).
3. **Backward compatible por padrão:** campo novo em response é sempre opcional até ambos os lados suportarem; campo removido passa por deprecação (1 onda de aviso).
4. **A UI esconde, o servidor recusa:** toda permissão verificada nos dois lados. O frontend NUNCA é a única barreira.
5. **Frontend nunca envia valores derivados** (`totalPrice`, contagens, somas) — o backend calcula e é a fonte da verdade.

---

## Autenticação

**CRMLAB-32** — o refresh (7d) deixou de viajar pelo corpo/JS: vive só no cookie
httpOnly `crm_refresh` (`Set-Cookie`, `Secure` em produção, `SameSite=Strict`,
`Path=/` — ampliado de `/api/v1/auth` pelo CRMLAB-33, D-151, porque o
handshake de `/ws` também precisa dele; `PATCH /users/me/password` se
beneficia do mesmo alargamento). O access token
(15min) continua no corpo, mas o frontend guarda ele SÓ EM MEMÓRIA (Zustand
sem `persist` para `tokens`) — `localStorage` não guarda token nenhum.

```
1. POST /auth/login → { accessToken (15min), user, tenant (com theme) } + Set-Cookie crm_refresh
2. Toda request: Authorization: Bearer <accessToken>
3. Carga de página: POST /auth/refresh (cookie vai sozinho) → access token novo
   (bootstrap — o access token não sobrevive a um reload)
4. 401 TOKEN_EXPIRED → POST /auth/refresh → retry transparente (interceptor)
5. 401 REFRESH_TOKEN_INVALID → limpar sessão → /login
6. POST /auth/refresh exige header X-Requested-With: crm-lab (proteção CSRF
   extra — SameSite=Strict + Path já reduzem o risco, mas um form cross-site
   não consegue setar header custom)
7. POST /auth/logout limpa o cookie (Max-Age=0) além de revogar a família
```

`RefreshRequest.refreshToken` no corpo é fallback DEPRECIADO de transição
(clientes que ainda não migraram para o cookie) — remoção prevista para
2026-10-04. O caminho normal e o único suportado pelo frontend atual é o
cookie.

O tema vem no login — o frontend NÃO faz request extra de tema no bootstrap.

NÃO ligar `credentials: true` no CORS geral do backend: nginx serve SPA e API
no mesmo origin em produção/homologação, então o cookie viaja sozinho sem
precisar de CORS com credenciais.

---

## Paginação (padrão único)

```
Request:  ?page=1&limit=20&sortBy=createdAt&order=desc
Response: { data: [...], pagination: { page, limit, total, totalPages } }
```

---

## Datas e Dinheiro

- **Datas:** sempre ISO 8601 UTC no fio (`2026-08-23T14:30:00Z`); formatação pt-BR é responsabilidade do frontend (`DateDisplay`)
- **Dinheiro:** número decimal no fio (`179.80`); formatação (`R$ 179,80`) é do frontend (`MoneyDisplay`); backend NUNCA envia string formatada

---

## Real-time (WebSocket)

```
Conexão: ws://host/ws?token=<accessToken>
Servidor coloca socket na room do tenantId (do token — nunca do cliente)
```

| Evento | Payload | Reação do frontend |
|--------|---------|--------------------|
| `conversation.new_message` | `{ conversationId, messageId }` | invalidate `['conversations']` + `['conversation', id]` |
| `proposal.status_changed` | `{ proposalId, status }` | invalidate `['proposals']` + `['proposal', id]` |
| `proposal.updated` | `{ proposalId }` | itens/desconto/médico solicitante mudaram (CRMLAB-12, D-134) — invalidate `['proposals']` + `['proposal', id]` |
| `approval.requested` | `{ proposalId }` | badge em #aprovacoes + invalidate pendentes |
| `approval.decided` | `{ proposalId, decision }` | toast + invalidate `['proposal', id]` |

**Regra:** eventos WS são NOTIFICAÇÃO, não transporte de dados — o cliente refaz fetch (invalidateQueries). Payloads carregam só IDs.

Reconexão: exponential backoff; ao reconectar, invalidar queries ativas (pode ter perdido eventos).

---

## Erros

- Formato e códigos: `docs/api/API_ERRORS.md`
- Frontend trata por `code`, nunca por `message`
- `NOT_FOUND` para recurso de outro tenant (não `FORBIDDEN` — não vazar existência)

---

## Checklist para Mudança de Contrato

- [ ] `API_CONTRACTS.md` atualizado
- [ ] `shared/types/` atualizado
- [ ] Backend implementa
- [ ] Frontend consome
- [ ] Testes de integração cobrem o novo shape
- [ ] Tudo no mesmo PR (ou PRs encadeados na mesma onda)
