# 🧩 Componentes do Frontend

Inventário COMPLETO de componentes reutilizáveis. Regra do design system: **não introduzir variantes novas sem registrar aqui primeiro.**

---

## Estrutura de Pastas

```
frontend/src/components/
├── ui/            # Primitivos (Button, Chip, Input, ...)
├── conversation/  # ConversationItem, MessageBubble, WhatsAppText, AudioMessage, Composer, AttachmentPreview
├── proposal/      # ProposalCard, ProposalModal, StageColumn
├── layout/        # Sidebar, InboxLayout, PageHeader
└── shared/        # Avatar, EmptyState, DataTable, Modal
```

---

## Primitivos (`ui/`)

### Button
```tsx
<Button variant="primary | secondary | confirmation | destructive"
        size="md | sm" disabled? loading? onClick>
```
- primary: fundo accent, texto bg, pílula. Um por área.
- confirmation: accent-2 — RESERVADO a concluir/positivo (ganho, aprovar)
- destructive: fantasma accent-700 (perda, remoção)
- Todos: border-radius 999px, altura mín. 36px, focus-visible outline accent

### Chip
```tsx
<Chip tone="positive | attention | inactive" onClick?>
```
- positive (sálvia-200/800): estado neutro/positivo
- attention (accent-200/800): exige ação humana — máx. 1 por cartão
- inactive (neutral-200): filtro desligado

### Badge
```tsx
<Badge count={number} />  // círculo accent-2, contagem não lidas
```

### Input / TextArea / SearchInput
- Uma linha = pílula (999px); multilinha = radius-md
- SearchInput com ícone e debounce 300ms

### SegmentedControl
```tsx
<SegmentedControl options={[...]} value onChange />
```
- Trilho com pílula deslizante — NUNCA abas sublinhadas

### Select, Toggle, Tooltip, Toast
- Estilizados com tokens (nada de padrão do navegador)

---

## Conversação (`conversation/`)

### ConversationItem
```tsx
<ConversationItem conversation={c} selected onClick />
```
Anatomia (padrão WhatsApp):
- Avatar 36px com iniciais (flex: 0 0 36px — nunca comprime); na lista do Atendimento, fundo
  `--color-chat-avatar` e iniciais `--color-chat-avatar-text` (CRMLAB-81, D-251)
- Nome (13.5px/600) + hora à direita (sálvia-700 se não lidas, cinza se lido)
- Prévia truncada 1 linha (elipse) + Badge contagem
- Chips de status + "aguardando N min" (accent-700)
- Selecionado: fundo `--color-chat-selected` (acento 20% com branco); hover `--color-chat-hover`
  (10%); divisória `--color-chat-line` entre itens (CRMLAB-81, D-251)
- `onMarkUnread?(id)` (CRMLAB-68, D-229): clique direito ou botão "⋯" abrem o menu
  (`role="menu"`) com "Marcar como não lida", só quando `unreadCount === 0`. Sem handler, nem
  botão nem menu
- **Rascunho (CRMLAB-73, D-243):** com rascunho guardado para a conversa (`useConversationDraft`,
  `stores/drafts.store.ts`), a prévia mostra **"Rascunho:"** (em destaque) + o texto, no lugar da
  última mensagem — menos na conversa selecionada. Conversa encerrada na lista apaga o rascunho

### ConversationSearch · MessageResults (`pages/Attendance/`, locais da tela — CRMLAB-68)
- `ConversationSearch`: barra da busca dentro da conversa (campo, "N de M", ↑ ↓, fechar) + lista
  de resultados. Recebe os `MessageSearchHit` prontos e devolve o id escolhido (`onGoTo`)
- `MessageResults`: o bloco "Mensagens" da busca da coluna 1 (mesma forma de `PatientResults`)
- `SearchSnippet` (`content`, `term`): o trecho com o destaque, usado pelos dois
- O trecho e o destaque vêm de `lib/search-snippet.ts` (`searchSnippet`, `highlightParts`,
  `isSearchableTerm`): comparação sem acento e sem caixa; o destaque é `<mark>` com tokens, nunca
  HTML vindo da API

### MessageBubble
```tsx
<MessageBubble type="received | sent | system" message={m} />
```
- 3 tipos, NUNCA mais. Canto "apontado" (radius-sm) marca a origem
- Largura máx. 62% no inbox
- Visual WhatsApp Web (CRMLAB-81, D-251; substitui o "papel branco" do CRMLAB-25): recebida é
  balão **branco** (`--color-chat-received`) à esquerda com o canto **superior esquerdo** reto;
  enviada é balão no acento clareado (`--color-chat-sent`) à direita com o canto **superior
  direito** reto. Sem borda, sombra `--shadow-sm`, texto `--color-chat-text`. Hora, autor,
  "Editada" e tique ficam no canto **inferior direito** (`--color-chat-meta`). Cor + canto reto:
  enviada × recebida se distinguem de relance, não só pelo lado. Bloco citado em
  `--color-chat-quote`. Nenhum token da conversa depende de `--color-bg/surface/text`
- Anexo `messageType: 'image'` (CRMLAB-15): thumbnail (`rounded-md`, máx. 300px de altura) no lugar
  do link "Anexo (tipo)". Clique chama `onOpenImage(message)` (CRMLAB-64, D-244): o balão **não**
  tem lightbox próprio — quem abre, navega entre as fotos e fecha é o `ConversationPanel`. Sem
  handler, a thumbnail não é clicável
- Anexo `messageType: 'audio'` (CRMLAB-2): `AudioMessage` na própria bolha no lugar do link.
- **Um componente por tipo (CRMLAB-70, D-236)** — o balão só despacha: `video` → `VideoMessage`,
  `pdf`/`doc` → `DocumentCard`, `sticker` → `StickerMessage` (balão sem fundo nem borda),
  `location` → `LocationCard`, `contact` → `ContactCard`. O texto do balão some quando é só o
  fallback (figurinha, localização, contato, e mídia cujo `content` é o próprio `media.fileName`).
  Bloco citado ganha "🎥 Vídeo", "Figurinha", "📍 Localização" e "👤 Contato"
- `GET /media/:id` exige `Authorization` (requireAuth) — um `<img src>`/`<audio src>` cru nunca
  manda esse header. A mídia vem por `useAuthenticatedMedia` (`hooks/`), que chama
  `fetchAuthenticatedBlob` (`api/client.ts`) e usa `URL.createObjectURL` como `src`. Enquanto
  carrega ou se a busca falhar, mostra texto no lugar da mídia — nunca `<img>`/player quebrado
- **Negrito padrão WhatsApp** (CRMLAB-51, D-183): `*texto*` aparece em **negrito** na bolha,
  enviada ou recebida. O texto guardado e enviado ao WhatsApp continua com os asteriscos (o
  WhatsApp do paciente formata sozinho). Regra em `splitBold` (`lib/whatsapp-format.ts`):
  abertura não seguida de espaço, fechamento não precedido de espaço, não atravessa quebra de
  linha, `**` vazio e `2 * 3 * 4` não formatam, e o asterisco precisa estar na borda da palavra
  (`2*3*4` fica como está). Renderiza como nós React (`<strong>`), nunca
  `dangerouslySetInnerHTML`. A prévia da lista (`ConversationItem`) mostra o texto cru
- **Formatação completa e links (CRMLAB-73, D-242):** o texto passa por `WhatsAppText`
  (`parseWhatsApp` de `lib/whatsapp-format.ts`): `*negrito*`, `_itálico_`, `~tachado~` (mesma
  regra de borda do negrito, aninhando símbolos diferentes), ```` ```monoespaçado``` ```` e
  `` `código` `` (literais, `font-mono`), linha com `> ` (citação), `- `/`* ` (lista com •) e
  `1. ` (numerada). `http(s)://…` e `www.…` viram link em nova aba
  (`rel="noopener noreferrer"`); o `_`/`~` dentro da URL não formata. Sem prévia de link.
  HTML/`<script>` do paciente aparece como texto
- `useAuthenticatedMedia` devolve também o `fileName` (do `Content-Disposition` de
  `GET /media/:id`), repassado ao `ImageLightbox` — é o nome com que a imagem é salva (CRMLAB-26).
  O blob é **compartilhado por URL** entre quem está usando (D-245): o lightbox aberto a partir do
  balão reaproveita o que o balão já baixou
- **Menu da mensagem (CRMLAB-66, padrão WhatsApp Web):** passar o mouse (ou focar) mostra uma
  setinha no canto de cima do balão; ela abre o menu **Responder · Reagir · Copiar**. Reagir abre
  a barra rápida `QUICK_REACTIONS` (👍 ❤️ 😂 😮 😢 🙏, `shared/`); clicar no emoji que já é o do
  laboratório remove. Copiar põe `content` na área de transferência. Encaminhar: fora desta
  história. Props opcionais: `onReply`, `onReact(emoji | null)`, `onQuoteClick(messageId)` — sem
  handler, a ação some (nada de botão morto). Balão de sistema não tem menu
- **Bloco citado** em cima do texto: autor + trecho (ou "📷 Foto", "🎤 Áudio", "📄 Documento"
  quando a citada é mídia sem texto; "Mensagem apagada"/"Mensagem original indisponível"). Clicar
  chama `onQuoteClick(quoted.id)`
- **Reações**: pílula pequena embaixo do balão com o emoji de cada lado
- **Apagada** (`deletedAt`): o balão mostra só "🚫 Mensagem apagada" em itálico, sem menu, sem
  mídia. **Editada** (`editedAt`): rótulo "Editada" na linha da hora
- **Tiques (CRMLAB-67, D-225):** só no balão `sent`, na linha da hora, pelo `status`: 🕓
  `pending` (enviando), ✓ `sent`, ✓✓ `delivered` (cinza, `text-neutral-600`), ✓✓ `read`
  (`--color-chat-tick-read`, o azul do WhatsApp — literal como o branco do papel), ⚠
  `failed` (`text-accent-700`, a cor de erro do app) com "Não foi possível enviar" e o botão
  **Tentar de novo** (`onRetry(message)`; sem handler, o botão some). `aria-label` diz o estado
  ("Enviando", "Enviada", "Entregue", "Lida", "Falhou"); `data-testid="message-status"` +
  `data-status`
- `data-message-id` no balão: é por ele que o painel rola até a original
  (`scrollToMessage`, `pages/Attendance/scroll-to-message.ts`) e a destaca por um instante
  (`data-highlighted`). Original fora do que está carregado: toast "A mensagem original não está
  carregada"

### DateSeparator (CRMLAB-71, D-239)
```tsx
<DateSeparator date={message.createdAt} now={new Date()} />
```
- Pílula centralizada entre mensagens de dias diferentes, no fuso do navegador (o fio é ISO UTC)
- Rótulo por `dateSeparatorLabel(date, now)` (exportada, fonte única): "Hoje", "Ontem", dia da
  semana por extenso de 2 a 6 dias atrás ("Segunda-feira"), `dd/mm/aaaa` a partir de 7 dias e
  para data futura. Conta por **dia de calendário** local: 23h59 e 00h01 são dias diferentes
- `isSameLocalDay(a, b)` (exportada) decide onde entra um separador
- `role="separator"` com o rótulo como nome acessível; mesma família visual da bolha de sistema
  (`rounded-pill`, texto `caption`), mas neutra — é marcação de tempo, não evento
- `now` é injetável para teste determinístico (mesma ideia do `ConversationItem`)
- Quem usa: `ConversationPanel` (Atendimento). A faixa "N mensagens não lidas" e o botão ↓ com
  contador são **locais da tela** (`pages/Attendance/`), não primitivos — ver PAGES.md §2. A
  lista marca cada linha com `data-anchor-id` (o id da mensagem), que é onde a rolagem se ancora
  ao carregar histórico (D-238); o `data-message-id` do balão é do `MessageBubble`

### AudioMessage (CRMLAB-2)
```tsx
<AudioMessage url={message.attachmentUrl} durationSec={message.media?.durationSec} />
```
- **Velocidade (CRMLAB-70, D-236):** botão `1x → 1,5x → 2x → 1x` ao lado do player
  (`playbackRate`, só daquele áudio). `durationSec` (opcional) aparece antes de o áudio carregar
- Player de áudio dentro da bolha: `<audio controls>` NATIVO — play/pause, barra com tempo
  decorrido/total, seek e teclado de graça. Player desenhado à mão só entra se o visual virar
  exigência real (mesma lógica do `EmojiPicker` sem biblioteca)
- Busca o blob autenticado por `useAuthenticatedMedia`; `src` é o object URL, nunca a URL crua
- Link "Baixar áudio" sempre visível: o Evolution entrega ogg/opus, que o Safari não toca. Se o
  `<audio>` dispara `error`, o player dá lugar a um aviso e o download fica como plano B

### VideoMessage · DocumentCard · StickerMessage · LocationCard · ContactCard (CRMLAB-70, D-236)
```tsx
<VideoMessage url={message.attachmentUrl} media={message.media} />
<DocumentCard url={message.attachmentUrl} messageType={message.messageType} media={message.media} />
<StickerMessage url={message.attachmentUrl} />
<LocationCard location={message.location} />
<ContactCard contacts={message.contacts} />
```
- **VideoMessage:** miniatura (`media.thumbnail`, JPEG em `data:` — a CSP já libera `img-src data:`;
  sem miniatura, fundo neutro) com ▶ e a duração. O arquivo só é baixado **no clique** e toca ali
  mesmo (`<video controls autoplay>`) — nunca no `ImageLightbox`. Formato que o navegador não toca
  (`.mov`/HEVC no Chrome): aviso + "Baixar vídeo"
- **DocumentCard:** ícone pelo tipo (PDF, Word, Excel, PowerPoint, texto/CSV, genérico), nome,
  tamanho (`formatBytes`) e "N páginas" no PDF quando vier. Clique abre (PDF) ou baixa — o blob
  autenticado só é buscado no clique (revisão do PR #43)
- **StickerMessage:** 120×120 `object-contain`, sem lightbox
- **LocationCard:** 📍 nome/endereço + "Abrir no mapa" (Google Maps `?api=1&query=lat,lng`, nova
  aba). Sem mapa estático (CSP, CRMLAB-32)
- **ContactCard:** nome + telefone por contato; "Conversar" chama
  `POST /conversations/whatsapp/open`: conversa existente abre direto (navega para
  `/attendance?conversationId=`, encerrada reabre para quem clicou); `404` abre
  `NewConversationModal` (`pages/Attendance/`) com `initialPhone`; `409` (de outra atendente) vira
  toast com o nome. Telefone fora do padrão BR vai direto ao modal. Sem telefone, sem botão

### Composer
- Input pílula + botão anexo + botão emoji + botão microfone + botão enviar (primary)
- Enter envia, Shift+Enter quebra linha
- **O cursor fica no campo depois de enviar (CRMLAB-63).** Com `sending`, só o Enter e o botão
  travam; o textarea segue habilitado (campo desabilitado perde o foco e o navegador não devolve),
  então dá para ir escrevendo a próxima. O textarea só desabilita com `disabled` (arquivada, sem
  permissão). `onSend` pode devolver `Promise`: se rejeitar, o texto volta para o campo, com o foco,
  a não ser que a pessoa já tenha começado outra mensagem. O aviso do erro é de quem chama.
  No Atendimento, `MESSAGE_SEND_FAILED` NÃO rejeita para o Composer: a mensagem já foi gravada
  como falha e aparece na conversa; devolver o texto convidaria a reenviar e duplicar. Já o
  `CONVERSATION_ALREADY_ASSIGNED` (409) rejeita: é assim que a tela devolve o rascunho quando
  outra pessoa assumiu a conversa no mesmo instante (CRMLAB-75, D-215)
- **Ctrl+B / Cmd+B** (CRMLAB-51, D-183): envolve a seleção em asteriscos (`*seleção*`, que a
  bolha e o WhatsApp mostram em negrito) e mantém o texto selecionado; sem seleção, insere `**`
  com o cursor no meio. **Ctrl+I** (`_itálico_`) e **Ctrl+Shift+X** (`~tachado~`) fazem o mesmo
  com o seu símbolo (CRMLAB-73, D-242). Ctrl+X sem Shift continua sendo recortar
- **Rascunho por conversa (CRMLAB-73, D-243):** `draftId` (opcional) liga o campo à store
  `stores/drafts.store.ts`. O campo começa com `initialValue` (o `?draft=` vence) ou o rascunho
  salvo, com o cursor no fim; cada mudança grava, campo vazio (enviou/apagou) remove. Sem
  `draftId` (chat interno), nada é guardado
- **Cresce com o texto** (CRMLAB-49, padrão WhatsApp Web): começa com uma linha e
  ganha altura a cada quebra (por tamanho ou Shift+Enter) até **150px** (~6 linhas);
  dali em diante trava e rola por dentro. Apagar ou enviar faz o campo voltar a
  diminuir. A altura é recalculada a cada mudança do texto, então emoji e resposta
  rápida entram pelo mesmo caminho. JS e não `field-sizing: content`, que o Firefox
  não suporta.
- Uma linha é pílula (999px); passou disso, vira `radius-md` — o raio de campo
  multilinha do DESIGN_TOKENS.md.
- O campo cresce **para cima**: a lista de mensagens encolhe e mantém a borda de
  baixo parada (a última mensagem visível continua visível), e os botões ficam
  alinhados embaixo (`items-end`).
- **Respondendo a (CRMLAB-66):** com `replyTo` (`{ authorName, preview }`), uma faixa em cima do
  campo mostra "Respondendo a *Maria*: trecho…" com × (`onCancelReply`); `Esc` no campo também
  cancela. Quem monta a tela guarda a mensagem escolhida e manda `quotedMessageId` no envio; a
  faixa some depois de enviar
- **Clipe com menu (CRMLAB-69, D-232):** `onPickFiles(files: File[])` — o clipe
  (`aria-label="Anexar arquivo"`) abre um menu com **"Fotos e vídeos"** (`accept="image/*,video/*"`)
  e **"Documento"** (`accept` = `ALLOWED_MEDIA_MIME_TYPES`); os dois com `multiple`. `onAttachClick`
  (opcional) avisa o clique no clipe — a tela usa para tirar a faixa de não lidas. **Ctrl+V** no
  campo com arquivo na área de transferência entrega os arquivos por `onPickFiles` e não cola nada;
  com só texto, cola normal. Sem `onPickFiles`, nem clipe nem colar arquivo (nada de botão morto)

#### Recado de voz (CRMLAB-24, D-181)
- Botão de **microfone** (`aria-label="Gravar áudio"`) ao lado do anexo e do emoji. Só aparece
  quando a tela passa `onSendAudio` (nada de botão morto), e trava junto com o resto do
  compositor (conversa encerrada / envio em voo).
- **Clique inicia, clique para** — não é "segurar para gravar". Enquanto pede permissão:
  "Aguardando o microfone…" + **Cancelar**. Gravando: ponto pulsante, "Gravando", tempo
  `m:ss / 5:00`, **Cancelar** e **Parar**. Parado: prévia com `<audio controls>` nativo e a
  duração, **Cancelar** e **Enviar** (primary, com `loading` durante o envio — sem duplo envio).
  Durante gravação e prévia a barra ocupa o lugar do emoji, do campo e do Enviar; o texto
  digitado fica guardado e volta depois.
- **5 min no máximo**: a gravação para sozinha e a prévia avisa "Limite de 5 min atingido".
  Menos de **1 s** é descartado com "Áudio curto demais" — nunca vai um recado de 0 s.
- Formato: o primeiro suportado entre `audio/ogg;codecs=opus`, `audio/webm;codecs=opus` e
  `audio/mp4`, a 32 kbps. O Composer não conhece a API: entrega
  `onSendAudio({ blob, mimeType, fileName })` e espera a `Promise` — resolveu, volta ao normal;
  rejeitou, a prévia fica para tentar de novo (quem trata o erro é a tela).
- Erro de microfone vira mensagem (`role="alert"`) na linha acima do compositor, nunca silêncio:
  conexão sem https, navegador sem `MediaRecorder`/`getUserMedia`, permissão negada
  (`NotAllowedError` — explica o cadeado da barra de endereço), sem microfone (`NotFoundError`),
  microfone ocupado (`NotReadableError`).
- Microfone liberado (`track.stop()`) ao parar, cancelar, dar erro e desmontar; o object URL da
  prévia é revogado. O `ConversationPanel` monta um Composer **por conversa**
  (`key={conversation.id}`): trocar de conversa cancela a gravação em andamento.
- Implementação: hook `useVoiceRecorder` (máquina de estados + `MediaRecorder`) e a barra
  `VoiceRecorder`, ambos em `components/conversation/`, usados só pelo Composer.

### AttachmentPreview (CRMLAB-69, D-232/D-233)
```tsx
<AttachmentPreview items={drafts} onCaptionChange={(id, caption) => …} onRemove={(id) => …}
  onAdd={(files) => …} onSend={() => …} onClose={() => …} />
```
- Prévia de anexos **antes de enviar**, padrão WhatsApp Web. Cobre a área da conversa (quem monta
  posiciona; o componente ocupa 100% do pai) sem desmontar a lista de mensagens.
- `items: AttachmentDraft[]` (`{ id, file, caption, error }`, montados por
  `createAttachmentDraft(file)` de `attachment-draft.ts`, que valida contra a allow-list e
  `MAX_MEDIA_BYTES` de `shared/`). `error` preenchido = aviso no arquivo ("Tipo de arquivo não
  permitido", "Arquivo acima de 15 MB", "Arquivo vazio") e ele não sobe.
- Arquivo selecionado em destaque: imagem grande (object URL) ou ícone + nome + tamanho. Campo
  **"Adicionar legenda"** (uma por arquivo; Enter envia, Shift+Enter quebra linha). Faixa de
  miniaturas (clique seleciona, × remove) e **+** para adicionar mais (mesmo `accept` do
  "Documento"). **Enviar** (desligado sem nenhum arquivo válido) e **×** que descarta tudo. **Esc**
  fecha. Remover o último arquivo fecha.
- Object URL criado por miniatura/destaque e revogado ao desmontar (remover, fechar, enviar).
- Componente burro: não chama API, não conhece conversa nem citação.

#### Emoji (Onda 8 §2.2, refeito no CRMLAB-73 / D-243)
- Popover com **busca** (campo "Buscar emoji", pt-BR, sem acento e sem caixa, por nome e
  palavras-chave), **abas de categoria** (Recentes · Smileys e pessoas · Animais e natureza ·
  Comidas e bebidas · Atividades · Viagens e lugares · Objetos · Símbolos · Bandeiras) e
  **Recentes** (até 24, `localStorage`, só aparece quando há algum). Lista estática
  versionada (`emoji-data.ts`, ~550), **sem dependência** — `emoji-mart` pesa centenas de KB
  e fala inglês.
- Insere **na posição do cursor**, não no fim do texto.
- Cada emoji é um `<button>` com `aria-label` (nome em pt-BR), navegável por
  teclado; `Esc` fecha e devolve o foco ao campo.

#### Respostas rápidas (Onda 8 §3.4)
- `/` **com o campo vazio** abre o `QuickReplyMenu` sobre o Composer; digitar
  filtra por atalho. Escolher **substitui** o texto pelo `content` da macro.
- Setas ↑/↓ navegam, `Enter` escolhe, `Esc` fecha. `aria-activedescendant`
  aponta o item ativo — o foco continua no campo, que é onde a pessoa digita.
- Só dispara com o campo vazio: em qualquer `/` atrapalharia quem escreve
  "km/h", "24/48h" ou uma URL. Sem macro que case, o menu fecha e a `/` fica
  como texto normal.
- O Composer não busca nada: recebe a lista por prop (`quickReplies`). Quem
  monta a tela é dono do `GET /quick-replies`.

---

## Proposta (`proposal/`)

### ProposalCard
```tsx
<ProposalCard proposal={p} onClick />  // sempre clicável → modal
```
- Nome (13.5/700) + #id à direita (11px cinza)
- Nota/motivo (12px), valor (heading 16px, nowrap), dias à direita
- Chip de status (regras de tom do Chip)
- Valor SEMPRE derivado de items + desconto — nunca prop separada digitada

### ProposalModal
- Ver PAGES.md §6. Composto por: ItemsList, DiscountSection, ApprovalAlert, StageHistory, ActionsRow
- LostReasonForm: select obrigatório ao marcar perdido

### StageColumn
```tsx
<StageColumn stage="novo_contato" proposals={[]} />
```
- Header: nome + contagem + soma derivada
- Lista de ProposalCard; hover em cartão: shadow-md

---

## Layout (`layout/`)

### Sidebar
- Variante "Trilho flutuante" (CRMLAB-44, a partir de `Sidebar CRM - Design System.md`, mapeada
  para os tokens de tema do tenant — a paleta fixa verde do documento NÃO foi adotada, decisão
  registrada no card): **264px expandido / 76px recolhido**, `transition: width 220ms ease`;
  recolhe sozinho em atendente + inbox
- Flutuante: margem de 12px (topo/base/esquerda), `rounded-lg` + `shadow-lg`, fundo `bg-surface`
  sobre o `bg-bg` do app. Altura `calc(100vh - 24px)`, `position: sticky`
- Header: logo (34×34, `rounded-md`, `bg-accent-300`/`text-accent-900`, iniciais do nome do
  tenant) + nome do tenant (`font-heading text-section`) + botão recolher/expandir
  (`panel-left-close`/`panel-left-open`, lucide-react, 30×30)
- Itens: ícone (flex 0 0 38px quando recolhido) + label; hover `neutral-100`; **ativo fundo
  `accent-100` translúcido + barra de 3px à esquerda (`accent-500`, `rounded-r-sm`)** — único
  destaque do trilho (a faixa de grupo nunca usa essa cor). Raio: `rounded-lg` nível 1 (solto),
  `rounded-md` filho de grupo
- Conteúdo do trilho muda por perfil — a ESTRUTURA não
- Itens agrupados em accordion (CRMLAB-4): itens soltos primeiro, um único divisor
  (`<hr>` neutral-300), depois os grupos, na ordem Comunicação → Gestão →
  Configurações (D-129: "Comercial" + "LIS / Operação Laboratorial" fundidos em "Gestão")
  (`sidebarSectionsFor(role)`, route-config.ts). Grupo
  sem nenhum item visível para o perfil não aparece. Abertos por padrão; estado por grupo
  persistido em localStorage por usuário (`sidebar-groups.store.ts`)
- Cabeçalho de grupo (CRMLAB-44): ícone (`NAV_GROUPS[].icon`, route-config.ts) + label
  (`font-body text-label font-bold` — mesmo tamanho do item, só o peso diferencia, D-128) +
  chevron (`chevron-right`, lucide-react, 15px) que gira 90° ao abrir. Fundo `accent-100` quando
  aberto (ou, recolhido, quando o item ativo é um filho seu), `hover:bg-neutral-100` quando
  fechado. Filhos indentados atrás de um trilho (`border-l-2 border-neutral-300`). Grupo fechado
  com item ativo dentro: ponto 6px `bg-accent-500` ao lado do chevron. **Recolhido**: clicar no
  ícone do grupo expande o trilho e abre o grupo
- Item "Decisões" (gestor+): `Badge` com `pendingDecisions.total` de `GET /operations/overview`
  (PAGES.md §12) — some quando o total é zero
- Item "Chat Interno": `Badge` com a soma de `Channel.unreadCount` de todos os canais
  (`GET /internal-chat/channels`) — mesma fonte que o badge por canal do próprio chat (D-132).
  Grupo "Comunicação" fechado com esse total > 0: o mesmo `Badge` aparece no cabeçalho do grupo,
  substituindo o ponto 6px de "item ativo dentro" enquanto houver não lida (o ponto volta a
  aparecer sozinho se o total zerar mas ainda houver item ativo dentro)
- **Recolhido** (CRMLAB-44): qualquer `Badge` de contagem vira um dot de 8px (`bg-accent2`,
  borda 2px `border-surface`) sobre o ícone, no lugar do número
- Ícones: `lucide-react`, 19px, `strokeWidth={1.7}` (`NavGlyph.tsx`, mapa `NavIcon → LucideIcon`)
- Rodapé: avatar + nome do usuário é um botão; clique abre menu com [Sair] (`useLogout`,
  `POST /auth/logout` — API_CONTRACTS.md §1). Fecha ao clicar fora, `Esc` ou depois de sair
- Menu do usuário, acima de [Sair] (CRMLAB-72, D-241): dois `menuitemcheckbox` —
  "Som de mensagem nova" e "Notificações do navegador" — com ✓ quando ligados. Clicar alterna a
  preferência (`useMessageAlertsStore`, `localStorage`) sem fechar o menu
- Rodapé: nome, "Cargo · vX.Y.Z" (cargo = `role` traduzido em pt-BR, CRMLAB-44) — só a versão
  quando recolhido. `__APP_VERSION__` injetada em build-time pelo Vite a partir do `package.json`
  da raiz do monorepo (`frontend/vite.config.ts`), sem chamada de rede
- Estado recolhido/expandido persiste em `localStorage` (`crm-lab.sidebar-collapsed`,
  `ui.store.ts`) — preferência duradoura, ao contrário do resto do `ui.store` (sessionStorage,
  D-117)

### InboxLayout
- 3 colunas: 336px fixo | flex 1 min 440px | 316px recolhível (começa fechada, `contextPanelOpen:
  false` — CRMLAB-74)
- Estreito: overflow-x na linha (não colapsar colunas)
- `listBanner?: ReactNode` (CRMLAB-72): faixa opcional no topo da coluna 1, acima da lista, fora
  da rolagem dela. O Atendimento usa para o `EnableNotificationsBanner`

### AppShell
- Sidebar + `<Outlet/>` + modais globais. Monta `useNewMessageAlerts()` (CRMLAB-72, D-241): o
  aviso de mensagem nova vale em qualquer tela do laboratório. `PlatformShell` não monta

### EnableNotificationsBanner (`pages/Attendance/`, local da tela — CRMLAB-72)
- Aviso discreto no topo da fila: texto `text-caption` `text-neutral-700` + `Button` `secondary`
  `sm` "Ativar notificações", fundo `bg-accent-100`, padding `px-md py-sm`, borda inferior
  `border-neutral-300`
- Só renderiza com `Notification` disponível, `permission === 'default'` e a preferência de
  notificação ligada. O clique chama `Notification.requestPermission()`; qualquer resposta
  esconde o aviso

### useNewMessageAlerts (`hooks/`, CRMLAB-72, D-240/D-241)
- Título "(N) <título>", notificação sem prévia, som e a regra `isInMyQueue`. Funções puras
  exportadas para teste: `isInMyQueue`, `detectNewMessages`, `alertBody`, `countUnreadInQueue`,
  `titleWithCount`. Estado auxiliar em `stores/message-alerts.store.ts` (preferências +
  conversa aberta); som em `lib/notification-sound.ts`

### BudgetLayout
- 2 colunas: flex 1 min 520px | 372px fixo; total em rodapé fixo

### PageHeader
- Título (heading 32px), ações à direita, breadcrumb opcional
- `size="compact"` — título 21px (`text-section`) e `description` em `text-caption`, para tela de
  PAINEL (`/results`): ali o maior tipo da página é o número do KPI (30px), não a palavra que
  nomeia a tela. Telas de leitura continuam no padrão de 32px

---

## Compartilhados (`shared/`)

### Avatar
```tsx
<Avatar name="Marina Alves" size={36} />  // iniciais, fundo accent-2-200
<Avatar name="Marina Alves" className="bg-chat-avatar text-chat-avatar-text" />  // tom sobreposto
```
- `className` opcional (CRMLAB-81) sobrepõe fundo/cor das iniciais — a lista do Atendimento usa
  os tokens `--color-chat-avatar*`
- SEMPRE flex: 0 0 <size> — nunca comprimido

### EmptyState
```tsx
<EmptyState message="Nenhum exame ainda" />
```
- Frase curta centrada em neutral-600 — nunca área em branco

### DataTable
- Container com min-width + overflow-x (coluna nunca colapsa)
- Cabeçalho 11px caixa alta, régua neutral-300, linhas neutral-200, sem zebra
- Última coluna monetária/status: alinhada à direita

### Pagination
```tsx
<Pagination pagination={data.pagination} onPageChange={setPage} itemLabel="propostas" />
```
- Recebe o `pagination` (`{ page, limit, total, totalPages }`) que TODA listagem
  devolve (API_CONTRACTS.md — D-009) e emite a página pedida; não guarda estado
  e não busca dado
- Rende `N <itemLabel> · página X de Y` + [Anterior] [Próxima] (`Button` `secondary`/`sm`)
- **Não renderiza nada** com `total === 0` ou `totalPages <= 1`
- `<nav aria-label="Paginação de <itemLabel>">` — navegável por teclado
- Onde a página é guardada é decisão da tela (URL ou `useState`); **nunca Zustand**
- Usado em `/proposals` e `/catalog`

### Modal
- Backdrop translúcido escuro, cartão radius-lg + shadow-lg, máx 720px
- Rolagem interna; fecha por × e clique-fora (stopPropagation no cartão)

### ImageLightbox (CRMLAB-15, zoom em CRMLAB-21, setas em CRMLAB-64)
```tsx
<ImageLightbox
  src={url | null} fileName="foto.jpg" onClose={() => {}}
  // opcionais (CRMLAB-64, D-244):
  open={true} loading={false} error={false}
  title="Maria Silva · 27/09/2026 14:32" caption="Pedido do Dr. Silva"
  onPrev={() => {}} onNext={() => {}} preload={['blob:…']}
/>
```
- **Setas (CRMLAB-64, D-244):** `onPrev`/`onNext` desenham as setas nas laterais ("Imagem
  anterior" / "Próxima imagem") e ligam ← → no teclado (`preventDefault`). Sem o handler, a seta
  daquele lado some — é assim que o chamador diz "primeira", "última" ou "imagem só" (não dá a
  volta). Clicar na seta não fecha o lightbox
- **Cabeçalho** `title` no canto superior esquerdo (quem mandou · quando) e **legenda** `caption`
  embaixo da imagem; ambos opcionais, texto cru (sem HTML)
- **Carregando:** `open` mantém o lightbox aberto sem `src` — com `loading` mostra "Carregando
  imagem…" no lugar da imagem, com `error` "Não foi possível carregar a imagem"; setas, cabeçalho e
  × continuam. Sem `open`, vale o de sempre: `src={null}` não renderiza nada
- `preload`: URLs das vizinhas, em `<img>` escondidos (a troca fica instantânea)
- O ↓ baixa sempre a imagem **da tela**, com o `fileName` dela
- Visualização de imagem em tela cheia — referência WhatsApp Web. Mais leve que `Modal`: mesmo
  backdrop (`bg-backdrop`), mas sem cartão/título/foco preso — só a imagem (`rounded-lg`,
  `shadow-lg`, `max-h-[86vh]`) sobre o fundo
- Botões − / + (zoom), ⤢ (tamanho original, só com zoom aplicado), ↓ (baixar) e × (fechar)
  circulares no canto superior direito, mesmo padrão do × do Modal
- ↓ (CRMLAB-26): `<a download>` para a pasta de Downloads, com `fileName` como nome do arquivo.
  Sem `fileName` cai em `"imagem"` SEM extensão (o browser completa pelo tipo do blob) — o
  atributo `download` nunca pode sumir, ou o ↓ vira navegação para o blob em vez de salvar.
  O download não fecha o lightbox
- Zoom (CRMLAB-21): roda do mouse, pinça, botões − / + e duplo clique (duplo clique de novo
  volta ao original). Roda e pinça ancoram no ponto sob o cursor/dedos — aproximar num canto não
  joga o trecho de interesse para fora da tela. Escala entre 1× e 6×
- Com a imagem ampliada, arrastar move o enquadramento (`cursor-grab`). O `click` que encerra o
  arraste NÃO fecha o lightbox — só um clique fora de verdade fecha
- Fecha por ×, Esc e clique fora da imagem (clique NA imagem não fecha — `stopPropagation`)
- `src={null}` não renderiza nada — o chamador controla a abertura guardando a própria URL

### MoneyDisplay
```tsx
<MoneyDisplay value={1350} variant="full | compact | thousands" emphasis? size="section | metric" />
// full: R$ 1.350,00 · compact: R$ 24.400 · thousands: R$ 96,4 mil
```
- SEMPRE white-space: nowrap; formatação pt-BR centralizada AQUI (único lugar)
- `emphasis` usa a fonte de título; `size` escolhe o corpo dela — `section` (21px, padrão: tabela
  e total do modal) ou `metric` (30px, número âncora de cartão de painel). Sem `emphasis`, `size`
  não tem efeito

### DateDisplay
- Relativo ("há 4 min") em listas; absoluto (DD/MM/YYYY HH:MM) em detalhes

---

## LIS (`lis/`) — Onda 10

### KpiCard
```tsx
<KpiCard label="Orçamentos pagos" value={165} variant="money | percent | number"
         deltaPct={12.4} deltaTone="positive | negative"? />
```
- Mesma base visual de `MetricTile` (`components/analytics/`, reaproveitado internamente:
  `KpiCard` é `MetricTile` + o bloco opcional de `delta`) — não duplicar a formatação pt-BR de
  valor, só acrescentar a variação
- `deltaPct` opcional: `+12,4%`/`-3,1%` com seta, cor `positive` (sálvia)/`negative` (accent-700)
  conforme o SINAL — a tela decide o sentido (ex.: "requisições em aberto" caindo é bom, então
  passa `deltaTone` explícito em vez de a cor seguir automaticamente o sinal do número)
- Sem `deltaPct`: renderiza igual a `MetricTile`, sem a segunda linha — usado nos cartões de
  Busca Ativa (§16), que não têm "período anterior" para comparar
- Usado em `/results` (§14), `/active-search` (§16)

### UploadDropzone
```tsx
<UploadDropzone accept=".xlsx" maxSizeBytes={10 * 1024 * 1024} onFile={(file) => ...} />
```
- Área clicável + arrastar-e-soltar; um arquivo por vez, substituído se solto de novo antes de
  enviar
- Valida extensão e tamanho **no cliente** antes de chamar `onFile` — arquivo fora do aceito
  mostra mensagem inline (nunca alert/toast) e não chama o callback
- Estado de "enviando" é responsabilidade de quem usa (o componente só entrega o `File`); mostra
  spinner próprio só enquanto lê o arquivo para base64
- Usado no modal Importar (`/results` e `/reconciliation`, §14-15) e no `ExamImportModal` de
  `/catalog` (`accept=".csv"`, 2 MiB — CRMLAB-23)

### ExamImportModal (CRMLAB-23, D-177/D-178)
```tsx
<ExamImportModal onClose={() => ...} />
```
- Modal "Importar catálogo (CSV)" de `/catalog` (PAGES.md §7), só renderizado para admin
- [Baixar modelo] (gerado no navegador por `lib/catalog/exam-import-template.ts`) +
  `UploadDropzone` → `POST /exams/import/preview`; mostra contadores (novos · atualizam · com
  erro), `DataTable` de erros (linha, coluna, motivo) e `DataTable` das linhas válidas
- Guarda o arquivo lido no estado e o reenvia em [Confirmar importação] (`POST /exams/import`)
  — o servidor não guarda o preview; o botão só habilita com zero erros
- `details.reason` do servidor vira mensagem pt-BR inline (`role="alert"`), nunca toast; sucesso
  vira toast `positive` e fecha o modal

### PeriodFilter
```tsx
<PeriodFilter value={{ startDate, endDate }} onChange={(period) => ...} />
```
- Atalhos comuns (Hoje, 7 dias, 30 dias, Mês atual) + dois `Input type="date"` para intervalo
  livre; aplica a cada mudança (sem botão "Aplicar" — mesmo padrão de `/analytics`). `endDate <
  startDate` mostra mensagem inline e a TELA que consome o componente segura o fetch
  (`enabled: false` na query) até o intervalo ficar válido — sem round-trip ao servidor para
  validar isso
- **Tudo em UMA linha, altura de barra de filtro:** o atalho cujo período bate com o valor em
  vigor fica `primary` + `aria-pressed="true"` (quem chega na tela sabe se está vendo 7 ou 30 dias
  sem ler as duas datas); período livre não marca nenhum. Os campos de data são pílulas de 164px
  com o rótulo DENTRO (`prefix` "De"/"até") — rótulo empilhado somava uma linha inteira de altura
  à barra em todas as telas do LIS. O rótulo acessível (`aria-label`) continua "Data inicial" /
  "Data final"
- Com o atalho em evidência, a tela NÃO precisa de um botão "Limpar período": voltar ao padrão é
  clicar em "30 dias"
- Sem valor: aplica o padrão de 30 dias terminando hoje **visualmente** (mesmo default que o
  servidor aplicaria na ausência de query params) — a tela nunca mostra os campos vazios com um
  resultado já carregado, o que pareceria inconsistente
- Usado em `/results`, `/reconciliation`, `/active-search`, `/sales` (período próprio de cada
  tela, mas mesmo componente — só `/results`/`/reconciliation`/`/active-search` compartilham o
  VALOR via `useUIStore.lisFilters`, D-117; `/sales` tem seu próprio estado de período)

### AgeBadge
```tsx
<AgeBadge daysOpen={12} ageBand="8-15" />
```
- Pílula com o número de dias + a faixa, tom crescente de urgência: `0-7` neutral, `8-15`
  atenção (accent-200/800), `16-30` e `30+` mais intensos (accent-300/900 e accent-500/branco) —
  a escala é de tom, não de cor isolada (D5: nunca só cor carrega o significado, o número de
  dias sempre está no mesmo elemento)
- Usado em `/active-search` (§16)

---

## Regras de Largura (evitam os bugs do protótipo)

1. Coluna flexível SEMPRE com min-width explícito
2. Todo elemento redondo (avatar, badge, ponto) leva `flex: 0 0 <tamanho>`
3. Grade de indicadores: `auto-fit + minmax(224px)`, nunca `repeat(N, 1fr)`
4. Números de indicador e valores monetários: `white-space: nowrap`
5. Linha de chips que estoura: `overflow-x` + `flex: 0 0 auto` nos filhos (não flex-wrap quando altura é escassa)

---

## Checklist para Componente Novo

- [ ] Não existe primitivo que resolva? (verificar este arquivo)
- [ ] Usa APENAS tokens CSS (zero hex/px de raio/nome de fonte)
- [ ] Estados: hover, focus-visible, selected, disabled, empty
- [ ] Elementos redondos com flex: 0 0
- [ ] Textos truncáveis com elipse ou text-wrap: pretty
- [ ] Registrado NESTE arquivo antes de usar em 2+ telas

> A regra "zero hex / zero px de raio / zero nome de fonte" é **testada**:
> `frontend/src/components/no-hardcoded-tokens.spec.ts` lê todo `.tsx` de
> `src/components/` e falha em hex, `font-family` literal e `border-radius`
> em px que não seja `999px`. Não é revisão de código — é suíte vermelha.

---

## Implementação da Fundação (Onda 1 — Agent-UI-Foundation)

### Derivação das rampas — decisão

`docs/design/DESIGN_TOKENS.md` publica a rampa completa só do acento
(`12/26/40/54 % sobre bg` · `500 = base` · `84/70/56/28 % sobre text`) e diz
"similar para `--color-accent-2` e `--color-neutral`". Implementado assim:

| Rampa | Fórmula | Origem |
|-------|---------|--------|
| `--color-accent-*` | literal do doc | DESIGN_TOKENS.md |
| `--color-accent-2-*` | **mesmas proporções do acento** | "similar para…" do doc |
| `--color-neutral-100` | `mix(bg 86%, white)` | contrato de derivação do protótipo |
| `--color-neutral-200…900` | `mix(bg, 94/82/71/59/47/35/24/12 %, text)` | idem, interpolado linear de 94→12 % |

Duas notas de decisão:

1. **`--color-neutral` tem base própria**, `mix(text 41%, bg)` — igual ao passo
   500 da rampa. O cinza acompanha o tema do tenant; não existe cinza fixo.
2. O protótipo escreve `accent-100…400 = mix(accent, 12–70%, bg)`; o doc é mais
   específico (12/26/40/54). **O doc venceu**, conforme AGENTS.md
   ("fonte mais específica / interpretação mais restritiva").

Nada disso é calculado em JS: `applyTheme()` escreve **apenas as 5 cores base**
e as 27 variações nascem em `color-mix(in oklab, …)` no CSS estático (D-005).
Teste `theme.spec.ts` verifica que as rampas NÃO são escritas em JS.

### Tokens acrescentados

| Token | Valor | Por quê |
|-------|-------|---------|
| `--color-backdrop` | `rgba(0,0,0,0.45)` | o backdrop do Modal é escuro translúcido por definição, não uma cor de tema — virou token para não ficar literal no componente |
| `[data-radius="reto"]` | sm 0 · md 2px · lg 4px | `radiusId` do ThemeService |
| `[data-radius="suave"]` | sm 4 · md 8 · lg 12 (padrão) | idem |
| `[data-radius="redondo"]` | sm 8 · md 14 · lg 20 | idem |
| `[data-font="figtree"\|"playfair"\|"system"]` | remapeia `--font-heading`/`--font-body` | `fontId` do ThemeService |

`--radius-pill` **não existe** como variável: pílula é `999px` literal
(`rounded-pill` no Tailwind), independente do tema.

### Props acrescentadas aos primitivos do inventário

Adições sobre a anatomia já documentada acima — nenhuma variante nova:

- **Button** — `type` (padrão `"button"`, evita submit acidental). `loading`
  desabilita e marca `aria-busy`.
- **Chip** — `selected` (chip de filtro ligado → `aria-pressed`), `disabled`,
  `title`. Sem `onClick` renderiza `<span>`; com `onClick`, `<button>`.
- **Badge** — `max` (padrão 99 → "99+"), `label` (rótulo acessível).
  `count <= 0` não renderiza.
- **Input** — `label`, `error`, `hint`, `prefix`, `suffix`.
- **TextArea** — `label`, `error`, `hint`.
- **SearchInput** — `defaultValue`, `debounceMs` (padrão 300), `disabled`.
  Não emite na montagem, só quando o usuário mexe.
- **SegmentedControl** — genérico em `T extends string`; opção com `disabled`
  é pulada na navegação por teclado (← → ↑ ↓, Home/End).
- **Select** — `options`, `placeholder`, `label`, `error`.
- **Toggle** — `checked`, `onChange`, `label`, `disabled` (`role="switch"`).
- **Tooltip** — `content`, `placement` (`top`/`bottom`). Abre em hover **e** em
  foco de teclado.
- **Toast** — `<ToastProvider>` + `useToast()` → `{ toast, dismiss }`.
  `toast(msg, { tone: 'positive'|'attention'|'neutral', durationMs })`;
  `durationMs: 0` mantém até o usuário fechar.
- **Modal** — além de ×/Esc/clique-fora: **trap de foco** (Tab circula dentro do
  cartão) e devolução do foco ao elemento anterior ao fechar. `footer` opcional.
- **DataTable** — `columns` (`key`, `header`, `render`, `align`, `minWidth`),
  `rowKey`, `onRowClick` (também por Enter/Espaço), `emptyMessage`, `minWidth`
  (padrão 720). Sem linhas → renderiza `EmptyState`.
- **MoneyDisplay** — `emphasis` usa a fonte de título (indicadores e total).
- **DateDisplay** — `variant: 'relative' | 'absolute'`; no relativo o valor
  absoluto vai para o `title`.
- **EmptyState** — `hint` e `action` opcionais.
- **Avatar** — `size` em px (padrão 36); `flex: 0 0 <size>` sempre.

### `src/lib/format.ts` — formatação pt-BR centralizada

Único lugar do frontend que formata dinheiro e data. Telas **não** chamam
`toLocaleString`.

| Função | Saída |
|--------|-------|
| `formatMoney(v, 'full')` | `R$ 1.350,00` |
| `formatMoney(v, 'compact')` | `R$ 24.400` |
| `formatMoney(v, 'thousands')` | `R$ 96,4 mil` (< 1.000 cai em `compact`; ≥ 1 mi vira `R$ 1,3 mi`) |
| `formatRelativeDate(iso)` | `agora` (<1min) · `há N min` (<1h) · `há N h` (<24h) · `ontem` (<48h) · `DD/MM` |
| `formatDateTime(iso)` | `23/08/2026 14:30` |
| `formatPercent(fração, casas?)` | `38%` · `38,4%` — recebe **fração** (0–1) |
| `initials(nome)` | `MA` (primeiro + último nome) |

### `src/lib/theme.ts`

- `applyTheme(theme: Theme, root?)` — escreve as 5 vars + `dataset.radius`/`dataset.font`
- `applyThemeColors(preset: ThemePreset, root?)` — só as cores (prévia ao vivo da Personalização)
- `THEME_PRESETS: ThemePreset[]` — os 5 temas (`terracota`, `jaleco`, `esteril`, `hemograma`, `diagnostico`)
- `DEFAULT_THEME: Theme` — Tema 1, espelhando o `:root` de `tokens.css`

### Tailwind

`frontend/tailwind.config.js` mapeia o tema **para CSS vars, nunca para hex**:
`bg-accent-200` → `var(--color-accent-200)`. Chaves: `accent`, `accent2`
(classe `bg-accent2-200` → `var(--color-accent-2-200)`), `neutral`, `bg`,
`surface`, `text`/`ink`, `backdrop`; `rounded-sm/md/lg` + `rounded-pill`;
`shadow-sm/md/lg`; `font-heading`/`font-body`;
`text-display|metric|section|label|body|caption|micro`;
espaçamentos `xs/sm/md/lg/xl`; `max-w-modal` (720px).

---

## Implementação dos Layouts (Onda 2 — Agent-UI-Shell)

Barril: `@/components/layout`. Nenhum destes componentes busca dado — são casca.

| Componente | Assinatura | Notas |
|------------|-----------|-------|
| `AppShell` | `<AppShell />` (rota-mãe) | Sidebar + `<main class="min-w-0 flex-1">` com `<Outlet />` |
| `PlatformShell` | `<PlatformShell />` | Igual, mas aplica `PLATFORM_THEME` ao montar e devolve o tema do tenant ao desmontar (PAGES.md §11) |
| `Sidebar` | `<Sidebar />` | Lê papel + rota; itens de `sidebarRoutesFor(role)` |
| `PageHeader` | `<PageHeader title breadcrumb? actions? description? size? />` | Título `text-display` (32px) na fonte de título; `size="compact"` cai para 21px (painel); ações `flex: 0 0 auto` |
| `InboxLayout` | `<InboxLayout list conversation context? contextOpen? />` | `336px \| flex 1 min 440px \| 316px` |
| `BudgetLayout` | `<BudgetLayout catalog summary total />` | `flex 1 min 520px \| 372px`; `total` em rodapé `sticky bottom-0` |
| `PageContainer` | `<PageContainer wide?>…</PageContainer>` | Página de leitura: `max-width 1180px`, `padding 30px 36px 48px` (PAGES.md §3). `wide`: 1440px e `24px 32px 48px`, só para tela de GRADE de dados (`/results`) |
| `NavGlyph` | `<NavGlyph name size? />` | `lucide-react`, 19px/`strokeWidth 1.7`, herda `currentColor` (CRMLAB-44) |

Constantes exportadas para quem precisar do número exato:
`INBOX_LIST_WIDTH` (336) · `INBOX_CONVERSATION_MIN_WIDTH` (440) ·
`INBOX_CONTEXT_WIDTH` (316) · `BUDGET_CATALOG_MIN_WIDTH` (520) ·
`BUDGET_SUMMARY_WIDTH` (372).

Regras de Largura aplicadas e **testadas** (`InboxLayout.spec.tsx`,
`BudgetLayout.spec.tsx`, `Sidebar.spec.tsx`):

- coluna flexível sempre com `min-width` explícito no `style`;
- em tela estreita quem rola é a LINHA (`overflow-x-auto`) — coluna não colapsa;
- ícone do item de menu e avatar com `flex: 0 0 <tamanho>`;
- Sidebar 264px/76px, recolhendo sozinha para atendente em `/attendance`.

---

## Implementação da Conversação (Onda 3 — Agent-UI-Attendance)

Barril: `@/components/conversation`. Nenhum destes componentes busca dado — a
tela passa tudo por props (o dado vem do TanStack Query).

| Componente | Assinatura | Notas |
|------------|-----------|-------|
| `ConversationItem` | `<ConversationItem conversation selected? onClick?(id) now? />` | `now` é injetável só para tornar "aguardando N min" determinístico em teste |
| `MessageBubble` | `<MessageBubble type message maxWidth? showMeta? onRetry? onOpenImage? />` | `type` ∈ `received \| sent \| system` — os únicos 3 · formatação do WhatsApp e links (D-183, D-242) · tiques e "Tentar de novo" (D-225/D-227) · imagem abre o lightbox da conversa (D-244) |
| `DateSeparator` | `<DateSeparator date now? />` | Pílula de dia (CRMLAB-71, D-239) · `dateSeparatorLabel` e `isSameLocalDay` exportadas |
| `AudioMessage` | `<AudioMessage url durationSec? />` | `<audio controls>` nativo com blob autenticado · velocidade 1x/1,5x/2x (D-236) · download sempre disponível |
| `VideoMessage` · `DocumentCard` · `StickerMessage` · `LocationCard` · `ContactCard` | ver acima | Um por tipo de mensagem (CRMLAB-70, D-236) |
| `Composer` | `<Composer onSend(content) → void | Promise onPickFiles?(files) onAttachClick? onSendAudio?(audio) disabled? sending? placeholder? quickReplies? draftId? />` | Enter envia · Shift+Enter quebra linha · Ctrl/Cmd+B envolve a seleção em `*`, Ctrl+I em `_`, Ctrl+Shift+X em `~` (D-242) · rascunho por `draftId` (D-243) · emoji insere no cursor · `/` no campo vazio abre as macros · microfone grava recado de voz (clique/clique, 5 min, D-181) |
| `EmojiPicker` | `<EmojiPicker onPick(emoji) disabled? />` | Busca pt-BR, categorias e recentes sobre lista estática (D-243), sem biblioteca · `Esc` fecha e devolve o foco |
| `WhatsAppText` | `<WhatsAppText text />` | Formatação do WhatsApp + links como nós React (D-242) · usado pela `MessageBubble` |
| `QuickReplyMenu` | `<QuickReplyMenu items filter onPick(reply) onClose() />` | Aberto pela `/` no campo vazio · ↑↓ navega, Enter escolhe, Esc fecha |

Exportações auxiliares (fonte única, para não duplicar regra em tela):

- `MESSAGE_BUBBLE_TYPES` — `['received', 'sent', 'system']`, congelado por teste;
- `bubbleTypeFor(senderType)` — `patient → received`, `agent → sent`, `system → system`;
- `INBOX_BUBBLE_MAX_WIDTH` — `'62%'`.

### Decisões onde doc e protótipo divergiam

1. **Largura da bolha: 62%.** DESIGN_TOKENS.md §"Bolhas de mensagem" escreve
   `max-width: 78%`; PAGES.md §2 e o texto do protótipo dizem 62% no inbox.
   Vale o **62%** aqui (fonte mais específica). O componente aceita `maxWidth`
   para quem precisar da regra geral fora do inbox.
2. **Chip "Minhas N" não tem preenchimento accent sólido.** O protótipo pinta
   o filtro ligado com `--color-accent` cheio, mas `Chip` só publica
   `positive | attention | inactive` — e "não introduzir variantes novas sem
   registrar aqui primeiro" é regra do design system. Implementado com
   `tone="attention"` + `selected` (`aria-pressed` + `shadow-sm`), que é o
   estado ligado já previsto no primitivo. Um `tone="solid"` precisa de
   decisão do dono de `components/ui/` — pedido aberto em STATUS.md.
3. **Prévia e nome truncam com `truncate`**, sempre dentro de um pai
   `min-w-0` — sem isso o flex ignora a elipse e a linha estoura a coluna de
   336px (regra de largura 1).

### Varredura de tokens ampliada

`components/no-hardcoded-tokens.spec.ts` passou a ler `src/components/` **e**
`src/pages/`. Uma tela com hex quebra a Personalização exatamente como um
componente; não havia motivo para a tela ficar de fora.
