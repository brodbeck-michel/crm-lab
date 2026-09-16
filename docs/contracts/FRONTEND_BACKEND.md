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

```
1. POST /auth/login → { accessToken (15min), refreshToken (7d), user, tenant (com theme) }
2. Toda request: Authorization: Bearer <accessToken>
3. 401 TOKEN_EXPIRED → POST /auth/refresh → retry transparente (interceptor)
4. 401 REFRESH_TOKEN_INVALID → limpar sessão → /login
```

O tema vem no login — o frontend NÃO faz request extra de tema no bootstrap.

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
| `proposal.updated` | `{ proposalId }` | itens/desconto/médico solicitante mudaram (CRMLAB-12, D-132) — invalidate `['proposals']` + `['proposal', id]` |
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
