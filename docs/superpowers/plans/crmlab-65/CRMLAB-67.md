# Diário — CRMLAB-67 [B] Tiques de enviado/entregue/lido e "digitando…"/"online"

Worktree `../CRM Lab-67` · branch `feature/CRMLAB-67-tiques-presenca` (de `integ/epic-65` @ 97a3e19).
Faixas: decisões D-225…D-227 · migração 042 (provavelmente não usada: `messages.status` é
`VARCHAR(50)` sem CHECK na 001).

## ⏸️ PAUSADO em 28/09/2026 17:21 (pedido do Michel: computador vai ser desligado)

**Nenhum código nem doc de domínio foi alterado ainda.** Só leitura e pesquisa. Este diário é o
único arquivo do commit.

### Pronto (leitura e pesquisa)
- Lidos: `CLAUDE.md`, `docs/AGENTS.md`, plano do épico, diários 66/71/72, D-220..D-223 e
  D-237..D-241, card CRMLAB-67 no Jira (status "Aprovado p/ Dev", não mexido).
- Código lido: `backend/src/lib/evolution-client.ts`, `lib/ws-hub.ts`,
  `controllers/webhook.routes.ts` (Evolution), `services/message.service.ts`,
  `repositories/message.repository.ts` (setStatus, confirmSent, hasPendingOutbound,
  setStatusByExternalId), `shared/types/{websocket,conversation}.types.ts`,
  `frontend/src/api/ws.ts` (`applyWsEvent`).

### Fatos levantados (Evolution API v2, código-fonte no GitHub)
- `MESSAGES_UPDATE` (`messages.update`): `data = { keyId, remoteJid, fromMe, participant,
  status, messageId?, instanceId }`; `status` é texto de `renderStatus.ts`:
  `0 ERROR, 1 PENDING, 2 SERVER_ACK, 3 DELIVERY_ACK, 4 READ, 5 PLAYED` (fallback `SERVER_ACK`).
  Aceitar também o número (0..5). Ignorar `remoteJid = status@broadcast`.
- `PRESENCE_UPDATE`: repassa o payload cru do Baileys:
  `data = { id: '<jid>', presences: { '<jid>': { lastKnownPresence, lastSeen? } } }`,
  presença ∈ `unavailable | available | composing | recording | paused`; `lastSeen` em segundos.
- **Não existe rota `presenceSubscribe`** no Evolution v2. A única é
  `POST /chat/sendPresence/{instance}` com `{ number, presence, delay }` (os três obrigatórios);
  ela chama `presenceSubscribe(jid)` do Baileys antes de mandar a presença, **bloqueia `delay` ms**
  e manda `paused` no fim. Para assinar ao abrir a conversa: `sendPresence` com
  `presence: 'paused'` e `delay` pequeno (não mostra nada ao paciente).

### Achados que viram decisão (rascunho — ainda não escritos em DECISIONS.md)
1. **Relógio (enviando):** hoje a mensagem nasce `status='sent'` ANTES do envio
   (`createFromAgent`/`createAttachmentFromAgent`) e o WS `new_message` sai antes do gateway
   responder, então a tela mostraria ✓ para algo não enviado. Proposta D-225: novo
   `MessageStatus = 'pending'` (shared + API_CONTRACTS), gravado no insert do canal `whatsapp`;
   `confirmSent` passa a `sent`; canal `direct`/`web` nasce `sent`. Ajustar
   `hasPendingOutbound` (hoje filtra `status='sent' AND external_message_id IS NULL`) e
   `MESSAGE_STATUSES`/`toMessageStatus` no repositório. Sem migração.
2. **Nunca rebaixar:** `setStatusByExternalId` e `applyExternalStatus` hoje sobrescrevem
   cegamente e **não emitem WS**. Ordem proposta: `pending < sent < delivered < read`;
   `failed` só a partir de `pending`/`sent`; ack nunca volta. Fazer no SQL (CASE de ranking)
   para valer também na rota da Cloud API. `PLAYED` → `read`; `ERROR` → `failed`;
   `PENDING` → ignorado (não rebaixa `sent`).
3. **WS:** evento novo `message.status_updated { conversationId, messageId, status }` (o card
   sugere) e `conversation.presence { conversationId, presence, lastSeenAt }`. Status leva o
   valor no payload (exceção à regra "só ids", registrar) e o front aplica direto no cache em
   formato de páginas (`{ pages, pageParams }`, chave `[...queryKeys.conversation(id),
   'messages']`), sem refetch e sem tocar `queryScopes.conversations` (não dispara o aviso do 72).
   Presença vai para um store Zustand com expiração de ~10 s; nada no banco.
4. **Anti-replay (`isReplay`, 10 min):** `presence.update` repete corpo idêntico
   (ex. `composing` de novo) e seria descartado como replay. Colocar `PRESENCE_UPDATE` em
   `replayExempt` (efêmero, idempotente). `MESSAGES_UPDATE` também é idempotente com a regra de
   não rebaixar. Ambos entram em `INSTANCE_CHECKED_EVENTS` (checagem de `instance`).
5. **"Tentar de novo":** não existe rota de reenvio. Criar
   `POST /conversations/:id/messages/:messageId/retry` (só mensagem `failed` do lado `agent`,
   conversa ativa, 404 cross-tenant), entrada no inventário de
   `backend/tests/kernel/route-tenant-isolation.spec.ts` (76 → 77). Dúvida técnica em aberto:
   reenvio de ANEXO precisa reler o buffer da mídia guardada (`MediaService`/`message_media`) —
   conferir se dá; se não, retry só de texto e registrar.
6. **`composing` para o paciente** (decidir): proposta D-227 = sim, com debounce (1 envio a cada
   ~5 s enquanto digita, `delay` curto), só canal `whatsapp` em modo Evolution; rota nova
   `POST /conversations/:id/presence` (entra no inventário) ou reaproveitar a de assinatura.

## Checklist do que falta
- [ ] Docs (Regra Zero): D-225..D-227, API_CONTRACTS (eventos WS, `pending`, rota retry e
      presença), FRONTEND_BACKEND "Real-time", SERVICES §3/§16, COMPONENTS (MessageBubble
      tiques, cabeçalho do ConversationPanel), PAGES §2; `shared/types` (`MessageStatus`,
      `WsEventName`/`WsEventPayloads`).
- [ ] Backend: `EVOLUTION_WEBHOOK_EVENTS` + `MESSAGES_UPDATE`/`PRESENCE_UPDATE`;
      `sendPresence` no `evolution-client.ts`; parser de ack e de presença no
      `webhook.routes.ts`; `applyExternalStatus` sem rebaixar + WS; status `pending`;
      rota retry; rota de presença/assinatura.
- [ ] Frontend: tiques no `MessageBubble` (tokens de cor, zero hex/px), "Tentar de novo",
      `ws.ts` (status no cache em páginas, presença no store), linha de presença no cabeçalho
      do `ConversationPanel` (aditiva; a lupa do CRMLAB-68 fica nos botões), debounce no Composer.
- [ ] Testes: payloads Evolution v2 reais (`messages.update` com ack texto e número,
      `presence.update`), não rebaixar, cross-tenant no WS, retry, specs de front com o cache real.
- [ ] Typecheck `.wt` back/front/shared + specs afetados (com `flock` e `--maxWorkers=3`).

## Decisões escritas
Nenhuma ainda (faixa D-225..D-227 livre).

## Próximo passo exato
Escrever D-225 (status `pending` + ordem que nunca rebaixa + mapeamento de ack), D-226 (presença
efêmera: WS, expiração 10 s, assinatura por `sendPresence paused`, replay isento) e D-227
(composing para o paciente + rota de retry) no fim de `docs/DECISIONS.md`, antes do "Template";
depois `shared/types` + API_CONTRACTS no mesmo commit.
