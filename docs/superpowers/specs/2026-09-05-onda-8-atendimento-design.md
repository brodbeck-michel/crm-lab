# Spec — Onda 8: ferramentas de atendimento (transferência, emoji, fixar, macros, mídia)

**Data:** 2026-09-05
**Origem:** pedido do lead a partir do uso real da tela de Atendimento, depois que o WhatsApp
por QR passou a receber mensagem de verdade (v1.2.0).
**Status:** aprovada no desenho; ondas ainda não iniciadas.

---

## 1. Contexto e objetivo

A tela de Atendimento hoje recebe e envia **texto**. O que falta é o que uma atendente faz o dia
inteiro: passar a conversa para a colega certa, responder rápido sem redigitar, ouvir o áudio que
o paciente mandou, receber a foto do pedido médico e manter à vista as conversas que importam.

Seis funcionalidades pedidas. Elas **não** têm o mesmo custo — três não tocam infraestrutura
nova, uma cria uma tabela e uma tela, e duas exigem armazenamento de arquivo, que **não existe
em lugar nenhum do projeto hoje**. Por isso a entrega é em ondas: cada uma commitada, testada e
usável antes da seguinte.

### O que já existe (verificado no código, não suposto)

| Pedido | Situação |
|---|---|
| Transferir | `ConversationService.assign(ctx, id, userId)` **já aceita** usuário ou `null` (devolver à fila), com `assertCanReassign` e mensagem de sistema. A tela é que só manda `null`. |
| Anexo | `Composer` tem o botão, mas `onAttach` é um stub que emite um toast. Sem upload, sem storage, sem envio de mídia no `EvolutionClient` (só `sendText`). |
| Áudio | Idem. `MessageType` em `shared/types/conversation.types.ts` **já prevê** `'audio' \| 'image' \| 'pdf' \| 'doc'` — o tipo existe, o caminho não. |
| Emoji | Nada. |
| Fixar | Nada. |
| Macros | Nada. |

### Decisões do lead (2026-09-05)

1. **Armazenamento:** volume local montado no container. Não MinIO/S3 agora. Trocar depois é
   substituir a camada de storage, não o domínio.
2. **Fixar é pessoal**, por atendente — não um estado compartilhado da conversa.
3. **Áudio de saída é condicional:** provar contra o gateway real se ele aceita `webm/opus`
   antes de decidir sobre `ffmpeg`. Nada de assumir.
4. **Ordem:** ondas, do barato ao caro.

---

## 2. Onda 1 — transferência, emoji e fixar

Nenhuma mídia. Uma migração pequena. A onda que o lead consegue testar mais rápido.

### 2.1 Transferir para uma atendente OU devolver à fila

O botão hoje é binário: `"Transferir"` (devolve à fila) quando é sua, `"Assumir"` quando está
livre. Passa a abrir um menu com:

- a lista de colegas que podem receber a conversa;
- **"Devolver para a fila"** (o comportamento atual, agora explícito e nomeado).

**Contrato:** nenhum endpoint novo para a transferência em si — `PATCH /conversations/:id` com
`{ assignedTo: "<uuid>" | null }` já faz as duas coisas.

**Endpoint novo, e este é obrigatório:** `GET /users` é **`admin`-only**
(`user.routes.ts:83`). Uma atendente não consegue listar as colegas, então o menu ficaria vazio
justamente para quem mais transfere. Entra:

```
GET /api/v1/conversations/assignees        (TENANT_ROLES)
→ { assignees: [{ id, name, role }] }      usuários ATIVOS do tenant que podem
                                            receber conversa (attendant/manager/admin)
```

Deliberadamente **não** é um `GET /users` afrouxado: devolve só `id`, `name` e `role` — nada de
e-mail, nada de estado de conta. Afrouxar o `/users` existente vazaria a lista de pessoal
completa para todo atendente, o que é uma mudança de superfície de segurança que ninguém pediu.

**Regras (já no backend, só passam a ser alcançáveis):** `assertCanReassign` mantém "só o dono,
gestor ou admin transferem uma conversa já atribuída"; transferência gera mensagem de sistema
(WORKFLOWS §5); conversa de outro tenant é `NOT_FOUND`.

**UI:** menu ancorado no botão. Uma atendente não vê a si mesma na lista quando a conversa já é
dela. Erro de concorrência (`CONVERSATION_ALREADY_ASSIGNED`) mostra de quem a conversa é agora,
que é o dado que o erro já carrega em `details`.

### 2.2 Emoji

Popover no `Composer` com uma grade de ~48 emojis de uso comum em atendimento, inserindo na
posição do cursor (não no fim do texto).

**Sem dependência.** Um seletor completo com busca por nome custa centenas de KB para um caso que
não pede busca. Se a busca virar necessidade real, aí entra biblioteca — e o popover já estará
isolado num componente.

Acessibilidade: cada emoji é um `<button>` com `aria-label` (o nome em pt-BR), navegável por
teclado; `Esc` fecha e devolve o foco ao campo.

### 2.3 Fixar conversa (pessoal)

```sql
-- migração 007_conversation_pins.sql (Onda 1)
CREATE TABLE conversation_pins (
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, conversation_id)
);
CREATE INDEX conversation_pins_lookup ON conversation_pins (tenant_id, user_id);
```

RLS no mesmo padrão das demais (`tenant_id = current_setting('app.tenant_id')`), fail-closed,
provada com dois tenants — a disciplina de `004_rls_onda6.sql` / `006_rls_onda7.sql`.

**Contrato:**

```
POST   /api/v1/conversations/:id/pin      (TENANT_ROLES) → 204
DELETE /api/v1/conversations/:id/pin      (TENANT_ROLES) → 204
```

Idempotentes: fixar o que já está fixado é `204`, não erro. `GET /conversations` passa a devolver
`pinned: boolean` **do usuário que pediu** e ordena fixadas primeiro, mantendo a ordenação atual
dentro de cada grupo. O contador das abas **não muda**: fixar é organização visual, não filtro.

**Por que tabela e não coluna:** `pinned_at` em `conversations` seria menor, mas uma atendente
fixando entupiria o topo da lista das outras. Pin é ferramenta pessoal — é assim que WhatsApp e
Slack se comportam, e a expectativa do usuário já está formada.

---

## 3. Onda 2 — macros (respostas rápidas)

### 3.1 Onde mora a tela, e por quê

**Página própria `/quick-replies` ("Respostas rápidas"), `requiredRoles: TENANT_ROLES`.**

Não é aba de "Canais & Equipe": aquela rota é `MANAGER_PLUS` (`route-config.ts:95`) e barraria
exatamente quem o lead quer que crie e edite as macros. Também não é o mesmo tipo de coisa —
configurar canal de WhatsApp é ato de administração; escrever resposta pronta é ferramenta de
trabalho diária. Misturar as duas obrigaria a inventar permissão por aba dentro de uma tela,
que é a solução que ninguém consegue auditar depois.

### 3.2 Schema

Migração própria da onda — `008_quick_replies.sql`. RLS no mesmo padrão fail-closed, provada com
dois tenants.

```sql
CREATE TABLE quick_replies (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  shortcut   TEXT NOT NULL,          -- sem a barra: "horariocoleta"
  title      TEXT NOT NULL,
  content    TEXT NOT NULL,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT quick_replies_shortcut_format CHECK (shortcut ~ '^[a-z0-9-]{2,32}$'),
  UNIQUE (tenant_id, shortcut)
);
```

`shortcut` é minúsculo, sem acento e sem espaço — é o que a pessoa digita depois da `/`. O CHECK
existe para o atalho não virar `/Horário Coleta`, que ninguém consegue digitar sem errar.

### 3.3 Contrato

```
GET    /api/v1/quick-replies          (TENANT_ROLES) → { quickReplies: [...] }
POST   /api/v1/quick-replies          (TENANT_ROLES) → 201
PATCH  /api/v1/quick-replies/:id      (TENANT_ROLES) → 200
DELETE /api/v1/quick-replies/:id      (TENANT_ROLES) → 204
```

Atalho repetido no mesmo tenant → `VALIDATION_ERROR` com o campo `shortcut` (não erro genérico de
banco). Macro de outro tenant → `NOT_FOUND`.

**Permissão:** qualquer papel de tenant cria, edita e apaga. Restringir a exclusão a gestor foi
considerado e descartado: são textos de trabalho, versionados no audit log, e travar a exclusão
só produziria uma lista suja que ninguém limpa. Criação, edição e exclusão **geram audit log**
(Regra 7 do `CLAUDE.md`).

### 3.4 Uso no Composer

Digitar `/` **com o campo vazio** abre a lista, filtrando por atalho conforme se digita; escolher
substitui o texto pelo `content`. Setas navegam, `Enter` escolhe, `Esc` fecha.

A restrição "campo vazio" é deliberada: disparar em qualquer `/` atrapalharia quem escreve
"km/h", "24/48h" ou uma URL.

---

## 4. Onda 3 — mídia (anexo e áudio)

A onda cara. Cria infraestrutura que o projeto não tem.

### 4.1 Armazenamento

Volume `media/` montado no container do backend, caminho em `MEDIA_DIR` (env nova, obrigatória
em produção como `CHANNEL_SECRET_KEY` já é).

Migração própria da onda — `009_message_media.sql`, com a mesma RLS.

```sql
CREATE TABLE message_media (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  message_id  UUID REFERENCES messages(id) ON DELETE CASCADE,
  mime_type   TEXT NOT NULL,
  file_name   TEXT NOT NULL,
  byte_size   INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

O arquivo em disco tem o nome do `id` — nada de nome vindo do usuário no caminho, que é
travessia de diretório pronta.

```
GET /api/v1/media/:id     (autenticado, filtrado por tenant)
```

**Nunca servido como arquivo estático público.** É exame e áudio de paciente: `express.static`
numa pasta transformaria UUID adivinhado em vazamento de dado de saúde, sem passar por
autenticação nem por RLS. Mídia de outro tenant → `NOT_FOUND`, como manda a Regra 8.

### 4.2 Entrada (paciente → CRM)

O webhook do Evolution já está registrado com `base64: true` (v1.2.0), então o conteúdo chega no
próprio payload — não é preciso chamar o gateway de volta.

`inboundPhoneOf` continua decidindo **de quem** é a mensagem; o que muda é o corpo:
`message.audioMessage`, `imageMessage` e `documentMessage` passam a ser reconhecidos ao lado de
`conversation`/`extendedTextMessage`. Decodifica, grava, cria a mensagem com o `messageType`
correspondente e o `attachmentUrl` apontando para `/api/v1/media/:id`.

Teto de tamanho recusa o arquivo com log explícito — nunca derruba o webhook, que responde
`200 {received:true}` em todo caminho (contrato atual).

### 4.3 Saída (CRM → paciente)

```
POST /api/v1/conversations/:id/attachments   (TENANT_ROLES)
{ fileName, mimeType, contentBase64 }        → cria a mensagem e envia
```

**Base64 em JSON, não multipart.** Express 4 não faz multipart sozinho, e `multer` seria uma
dependência nova para um caso que o próprio Evolution já resolve em base64 nos dois sentidos. O
custo é ~33% mais bytes no fio — irrelevante para recado de voz e foto de pedido médico, e o teto
de tamanho fica explícito na validação em vez de escondido na configuração de um middleware.

Envio pelo gateway: `POST /message/sendMedia/:instance` com a apikey **da instância** (mesma
disciplina de privilégio mínimo do `sendText`, fix I6 da Onda 7).

### 4.4 Áudio de saída — condicional, decidido por experimento

Gravação no navegador (`MediaRecorder`) produz `webm/opus`; o WhatsApp espera `ogg/opus`. **Antes
de escrever a funcionalidade**, provar contra o gateway real se `webm` é aceito:

- **aceita** → segue sem conversão, custo zero;
- **não aceita** → volta ao lead com o resultado. As opções serão `ffmpeg` na imagem do backend
  (engorda a imagem, processa a cada áudio) ou enviar como anexo comum sem ser nota de voz.

Nenhuma linha de conversão entra no código antes desse resultado. **Ouvir** o áudio do paciente
(entrada, §4.2) não depende disso e vale sozinho — é a metade que resolve a maior parte do
problema.

---

## 5. Fora de escopo desta onda

- Transcrição de áudio.
- Emoji com busca por nome (entra quando houver pedido real).
- Macro com variáveis (`{{nome do paciente}}`) — texto fixo primeiro; variável só depois que o
  uso mostrar quais campos importam.
- Compartilhar macro entre tenants, ou catálogo global de macros.
- Backup/retenção do volume de mídia: é decisão de infraestrutura, não desta onda. Fica
  **registrado como risco** em §6.
- Vídeo. `MessageType` não prevê, e nenhum laboratório pediu.

---

## 6. Riscos aceitos e registrados

| Risco | Decisão |
|---|---|
| Volume local não escala para múltiplas instâncias do backend e não tem backup | Aceito para o momento atual (instância única). Trocar por S3 é substituir a camada de storage; o domínio não muda. **Não** entrar em produção multi-instância sem resolver. |
| Base64 em JSON infla ~33% e ocupa memória do processo | Aceito com teto de tamanho explícito. Se surgir necessidade de arquivo grande, aí entra streaming/multipart. |
| `webm` pode não ser aceito pelo gateway | Endereçado por experimento antes do código (§4.4). |
| Áudio e imagem de paciente em disco no servidor | Servido só por rota autenticada e filtrada por tenant. Cifra em repouso do arquivo **não** entra agora — registrado aqui para a revisão de LGPD. |

---

## 7. Verificação exigida em cada onda

Igual ao que fechou a v1.2.0, porque foi o que revelou os bugs que a suíte não pegava:

1. Doc do domínio atualizado **antes** do código (Regra Zero do `CLAUDE.md`).
2. Teste que falha primeiro, depois o código.
3. `npm run typecheck` verde nos 4 workspaces + suíte do domínio.
4. **Verificação no navegador de verdade** (Playwright contra a stack de dev), não só em jsdom —
   e, para o que toca WhatsApp, contra o gateway Evolution real, não contra mock.
5. Commit próprio por onda, com `docs/STATUS.md` atualizado.
