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
| `RESET_TOKEN_INVALID` | 400 | `POST /auth/reset-password`: token inexistente, já usado ou vencido (CRMLAB-39, D-172) — os três casos respondem igual, de propósito | — |

## Recursos

| Código | HTTP | Quando |
|--------|------|--------|
| `NOT_FOUND` | 404 | Recurso inexistente OU de outro tenant (não vazar existência) |
| `VALIDATION_ERROR` | 400 | DTO inválido — `details.fields: { campo: motivo }` |
| `CONFLICT` | 409 | Violação de unicidade (ex.: código de exame duplicado) OU estado que impede a escrita — `details.reason` diz qual |

## Pacientes & LGPD (Onda 6)

A seção `/patients` **não introduz código novo**: o catálogo acima já cobre todos os casos, e
`ApiErrorCode` (`shared/types/api.types.ts`) fica inalterado. O que é novo é o `details`:

| Código | HTTP | Quando | details |
|--------|------|--------|---------|
| `NOT_FOUND` | 404 | Paciente inexistente, de outro tenant **ou fora da visibilidade do atendente** (D-060) | — |
| `CONFLICT` | 409 | `PATCH /patients/:id` em paciente já anonimizado (D-063) | `{ reason: "patient_anonymized" }` |
| `FORBIDDEN` | 403 | `/export` e `/anonymize` pedidos por não-admin | `{ requiredRoles: ["admin"] }` |
| `VALIDATION_ERROR` | 400 | CPF com DV inválido, `birthDate` futura, `phone` no corpo do PATCH | `{ fields }` |

**Por que não um `PATIENT_ANONYMIZED` próprio:** o frontend já trata `CONFLICT` de forma
genérica e o caso é raro; um código a mais no catálogo obrigaria os dois lados a um switch novo
para exibir a mesma mensagem. Se a UI vier a precisar de fluxo específico, o código entra pelo
processo de "Adicionando um Código Novo" no fim deste arquivo.

`POST /patients/:id/anonymize` repetido **não** é erro: é idempotente e devolve `200`.

## Configurações e Operação (Onda 6)

Também sem código novo:

| Código | HTTP | Quando | details |
|--------|------|--------|---------|
| `FORBIDDEN` | 403 | `GET /settings/channels` por atendente · `PATCH` por não-admin · `/operations/*` por atendente | `{ requiredRoles }` — `["manager","admin"]` ou `["admin"]` |
| `VALIDATION_ERROR` | 400 | Segredo vazio (`""`), `channel` repetido no array, mensagem automática ligada sem texto, `HH:MM` inválido, `queueLimit`/`decisionsLimit` > 100 | `{ fields }` |

**Segredos nunca aparecem em `details`** — nem o valor recusado, nem parte dele. `details.fields`
carrega o nome do campo e o motivo ("mínimo 16 caracteres"), jamais o conteúdo enviado.

### Convenção de `details.fields` — a chave é o caminho que a TELA conhece

`details.fields` só existe para uma coisa: a tela achar o campo e mostrar o motivo ao lado dele.
Uma chave que a tela não sabe procurar não é um erro no lugar errado, é **erro nenhum** — o
formulário conclui que há erro de campo, apaga a mensagem geral, e nenhum campo casa. O usuário
toma `400` e acha que salvou. Por isso a chave segue o **identificador estável do recurso**, não
a posição no corpo da requisição:

| Caso | Chave | Por quê |
|------|-------|---------|
| Campo simples | `distributionMode`, `businessHours.timezone` | caminho do próprio corpo |
| Item de coleção **com chave natural** | `channels.whatsapp.apiToken` | o array do `PATCH` é esparso (só os canais sujos vão) — o índice `0` não corresponde a nada na tela |
| Dia da semana | `businessHours.days.mon` | idem: a chave é o dia, não a ordem |
| Item **sem** chave natural utilizável | `channels.0.channel` | quando o próprio `channel` é inválido ou ausente, não há nome — o índice é o único identificador possível, e a tela cai na mensagem geral |

Quem escreve tela: mostre uma **mensagem geral** para toda chave de `fields` que a tela não
renderiza. "Não sei onde mostrar" nunca pode virar silêncio.

## Propostas

| Código | HTTP | Quando | details |
|--------|------|--------|---------|
| `DISCOUNT_EXCEEDS_LIMIT` | 403 | Desconto > alçada (informativo: proposta vai para aprovação, OU bloqueio em updateDiscount de terceiro) | `{ requestedDiscount, userLimit, approvalRequired }` |
| `INVALID_STATUS_TRANSITION` | 400 | Transição fora da matriz de WORKFLOWS §4 | `{ from, to, allowed[] }` |
| `LOSS_REASON_REQUIRED` | 400 | status=perdido sem reasonLost | — |
| `INVALID_LOSS_REASON` | 400 | reasonLost fora do enum | `{ allowed[] }` |
| `PROPOSAL_PENDING_APPROVAL` | 409 | Tentativa de enviar proposta pending | — |
| `PROPOSAL_ALREADY_CLOSED` | 409 | Mutação em proposta ganha/perdida | `{ status }` |
| `PROPOSAL_EDIT_NOT_ALLOWED` | 409 | `PATCH /proposals/:id/items` fora de `novo_contato`/`orcamento_enviado` (CRMLAB-12, D-134) | `{ status }` |
| `APPROVAL_NOT_ALLOWED` | 403 | Aprovador sem alçada suficiente | `{ discount, approverLimit }` |
| `EXAM_NOT_FOUND_OR_INACTIVE` | 400 | Item referencia exame inexistente/inativo | `{ examIds[] }` |

## Conversas

| Código | HTTP | Quando |
|--------|------|--------|
| `CONVERSATION_ALREADY_ASSIGNED` | 409 | Atribuição simultânea — segunda tentativa perde. `details: { assignedTo, assignedToName }` |
| `CONVERSATION_ARCHIVED` | 409 | Enviar mensagem/anexo em conversa **encerrada** (`closed`). Nome mantido por compatibilidade (D-174); a mensagem é "Atendimento encerrado" |
| `MESSAGE_SEND_FAILED` | 502 | Canal externo (WhatsApp) falhou após retries. `details: { messageId }`; em `POST /conversations/whatsapp` (CRMLAB-50) também `conversationId` — a conversa fica criada e a tela a abre |

## Canais — conexão WhatsApp por QR (Onda 7)

| Código | HTTP | Quando |
|--------|------|--------|
| `CHANNEL_QR_UNAVAILABLE` | 503 | `EVOLUTION_API_URL`, `EVOLUTION_API_KEY` ou `EVOLUTION_WEBHOOK_TOKEN` ausentes, ou o gateway falhou. Nas 4 rotas de `/settings/channels/whatsapp/*` (API_CONTRACTS.md §6.1) — nunca crash, nunca 500. **Exceção:** instância ausente no gateway (404 `does not exist`) **não** é este erro — `/qr` e `/status` devolvem `disconnected` (200) para a tela conseguir reconectar |
| `CHANNEL_SESSION_STALE` | 503 | `POST /settings/channels/whatsapp/disconnect` quando o gateway responde 500 `Connection Closed` ao logout. A sessão Baileys morreu (celular deslogou, 401) mas o Evolution ainda persiste `connectionStatus: "open"`: não há socket para deslogar e `/instance/delete` recusa com 400 enquanto o registro disser `open`. Só reiniciar o **container** do Evolution reavalia o registro — `/instance/restart` não basta. Distinto de `CHANNEL_QR_UNAVAILABLE` porque o gateway está no ar e configurado; mandar o admin conferir a configuração seria mandá-lo para o lugar errado |

## Mídia — anexo e áudio (Onda 8 §4)

| Código | HTTP | Quando |
|--------|------|--------|
| `MEDIA_TOO_LARGE` | 413 | `POST /conversations/:id/attachments` com arquivo acima de 15 MiB (`details: { byteSize, max }`). Nunca grava mensagem. Também `POST /exams/import[/preview]` com CSV acima de 2 MiB (CRMLAB-23) |

## Vendas — domínio LIS (Onda 9)

| Código | HTTP | Quando |
|--------|------|--------|
| `SALE_ATTENDANT_NOT_LINKED` | 403 | `POST /sales` por um login de `attendant` sem vínculo em `attendants` (`attendants.user_id = ctx.userId`) — o vínculo é manual, feito por manager/admin em `PATCH /attendants/:id` (API_CONTRACTS.md §11/§12) |

## Convênios e preço por convênio (Onda 7)

Sem código novo além do acima: `/insurances` e `/exams/:id/prices` reusam o catálogo geral —
`NOT_FOUND` (convênio/exame de outro tenant), `CONFLICT` (nome de convênio duplicado),
`VALIDATION_ERROR` (`details.fields`, ver API_CONTRACTS.md §4/§8) e `FORBIDDEN`
(`details.requiredRoles`).

## Sistema

| Código | HTTP | Quando |
|--------|------|--------|
| `RATE_LIMIT_EXCEEDED` | 429 | Limite de requisições — `details: { retryAfter }` |
| `SERVICE_UNAVAILABLE` | 503 | Redis indisponível em runtime, numa rota **pública** que depende dele (`/auth/login`, `/auth/refresh`, `/auth/forgot-password` — CRMLAB-39, `/webhooks/*` — D-139). Rota autenticada NUNCA devolve este código: degrada fail-open (o JWT já protege) em vez de travar toda a API |
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
  //                             (+ mensagem geral para as chaves que a tela não renderiza)
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
