# Diário — CRMLAB-70 [E] Tipos de mensagem: vídeo, documento, áudio, figurinha, localização, contato

Worktree `../CRM Lab-70` · branch `feature/CRMLAB-70-tipos-mensagem` (de `integ/epic-65`, com a main v1.24.0).
Faixas: decisões D-234…D-236 · migração 045.

## Estado: 🔄 docs prontos → backend

## Feito
- [x] Leitura: CLAUDE.md, AGENTS.md, plano do épico, card no Jira, diários 66/69, CSP
      (`nginx/security-headers.conf`: `img-src 'self' blob: data:`, `media-src 'self' blob:`).
- [x] Docs (Regra Zero): D-234 (tipos + metadados: arquivo em `message_media` pela id da URL,
      resto em `messages.metadata JSONB`, LGPD zera `metadata`), D-235 (webhook), D-236 (balão por
      tipo); SCHEMA §4 + lista de migrações; API_CONTRACTS §2 (Message.media/location/contacts,
      attachments `video/* → video`, Evolution upsert); COMPONENTS (MessageBubble, AudioMessage,
      componentes novos).

## Falta (checklist)
- [ ] shared: `MessageType` + `MESSAGE_TYPES`, `MessageMediaInfo`, `MessageLocation`,
      `MessageContact`, `Message.media/location/contacts`; `mediaCategoryOf` com `video`.
- [ ] migração 045 `messages.metadata JSONB`.
- [ ] backend: repository (COLUMNS/FROM/toMessage/insert com metadata), patient.repository
      (anonimização), media.service `messageTypeFromMime` (+ message.service usa o mesmo),
      webhook (vídeo/sticker/áudio/pdf/localização/contato), service repassa `metadata`.
- [ ] testes backend: webhook com payloads (video, sticker, location, contact), shape do Message.
- [ ] frontend: componentes novos, AudioMessage (velocidade), MessageBubble (despacho),
      NewConversationModal `initialPhone`.
- [ ] testes frontend + typecheck + eslint.

## Decisões escritas
D-234, D-235, D-236.

## Perguntas em aberto
(nenhuma ainda)
