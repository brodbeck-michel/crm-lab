# ⚠️ Catálogo de Erros da API

Formato padrão e catálogo completo de códigos. Backend emite EXATAMENTE estes códigos; frontend trata por código (nunca por mensagem).

---

## Formato Padrão (toda resposta 4xx/5xx)

```json
{
  "error": {
    "code": "DISCOUNT_EXCEEDS_LIMIT",
    "message": "Desconto solicitado excede sua alçada",
    "statusCode": 403,
    "details": { "requestedDiscount": 25, "userLimit": 15, "approvalRequired": true }
  }
}
```

- `code`: SCREAMING_SNAKE, estável (contrato) — frontend faz switch nele
- `message`: pt-BR, amigável, pode mudar sem aviso
- `details`: objeto opcional com contexto estruturado

---

## Autenticação & Autorização

| Código | HTTP | Quando | details |
|--------|------|--------|---------|
| `INVALID_CREDENTIALS` | 401 | Login falhou (não revelar se email existe) | — |
| `TOKEN_EXPIRED` | 401 | Access token expirado → frontend tenta refresh | — |
| `TOKEN_INVALID` | 401 | Token malformado/assinatura inválida | — |
| `REFRESH_TOKEN_INVALID` | 401 | Refresh expirado/revogado → redirect login | — |
| `FORBIDDEN` | 403 | Role sem permissão para a ação | `{ requiredRoles }` |
| `USER_INACTIVE` | 403 | Usuário desativado | — |
| `TENANT_INACTIVE` | 403 | Laboratório suspenso/inativo | — |

## Recursos

| Código | HTTP | Quando |
|--------|------|--------|
| `NOT_FOUND` | 404 | Recurso inexistente OU de outro tenant (não vazar existência) |
| `VALIDATION_ERROR` | 400 | DTO inválido — `details.fields: { campo: motivo }` |
| `CONFLICT` | 409 | Violação de unicidade (ex.: código de exame duplicado) |

## Propostas

| Código | HTTP | Quando | details |
|--------|------|--------|---------|
| `DISCOUNT_EXCEEDS_LIMIT` | 403 | Desconto > alçada (informativo: proposta vai para aprovação, OU bloqueio em updateDiscount de terceiro) | `{ requestedDiscount, userLimit, approvalRequired }` |
| `INVALID_STATUS_TRANSITION` | 400 | Transição fora da matriz de WORKFLOWS §4 | `{ from, to, allowed[] }` |
| `LOSS_REASON_REQUIRED` | 400 | status=perdido sem reasonLost | — |
| `INVALID_LOSS_REASON` | 400 | reasonLost fora do enum | `{ allowed[] }` |
| `PROPOSAL_PENDING_APPROVAL` | 409 | Tentativa de enviar proposta pending | — |
| `PROPOSAL_ALREADY_CLOSED` | 409 | Mutação em proposta ganha/perdida | `{ status }` |
| `APPROVAL_NOT_ALLOWED` | 403 | Aprovador sem alçada suficiente | `{ discount, approverLimit }` |
| `EXAM_NOT_FOUND_OR_INACTIVE` | 400 | Item referencia exame inexistente/inativo | `{ examIds[] }` |

## Conversas

| Código | HTTP | Quando |
|--------|------|--------|
| `CONVERSATION_ALREADY_ASSIGNED` | 409 | Atribuição simultânea — segunda tentativa perde. `details: { assignedTo, assignedToName }` |
| `CONVERSATION_ARCHIVED` | 409 | Enviar mensagem em conversa arquivada |
| `MESSAGE_SEND_FAILED` | 502 | Canal externo (WhatsApp) falhou após retries |

## Sistema

| Código | HTTP | Quando |
|--------|------|--------|
| `RATE_LIMIT_EXCEEDED` | 429 | Limite de requisições — `details: { retryAfter }` |
| `INTERNAL_ERROR` | 500 | Erro não tratado (logar com correlationId; NUNCA vazar stack) |

---

## Tratamento no Frontend

```typescript
// api/error-handler.ts — ÚNICO lugar de tratamento genérico
switch (error.code) {
  case 'TOKEN_EXPIRED':        return refreshAndRetry(request);
  case 'REFRESH_TOKEN_INVALID': return redirectToLogin();
  case 'RATE_LIMIT_EXCEEDED':  return toastRetry(error.details.retryAfter);
  case 'VALIDATION_ERROR':     return mapFieldErrors(error.details.fields);
  default:                     return toast(error.message);
}
// Casos específicos (ex.: DISCOUNT_EXCEEDS_LIMIT no form de orçamento)
// são tratados no componente, por código.
```

---

## Adicionando um Código Novo

1. Adicionar linha na tabela correspondente NESTE arquivo
2. Implementar no backend (exceção tipada)
3. Tratar no frontend se exigir UX específica
4. Mesmo PR para os 3 passos
