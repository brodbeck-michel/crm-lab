# 🧩 Componentes do Frontend

Inventário COMPLETO de componentes reutilizáveis. Regra do design system: **não introduzir variantes novas sem registrar aqui primeiro.**

---

## Estrutura de Pastas

```
frontend/src/components/
├── ui/            # Primitivos (Button, Chip, Input, ...)
├── conversation/  # ConversationItem, MessageBubble, AudioMessage, Composer
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
- Avatar 36px com iniciais (flex: 0 0 36px — nunca comprime)
- Nome (13.5px/600) + hora à direita (sálvia-700 se não lidas, cinza se lido)
- Prévia truncada 1 linha (elipse) + Badge contagem
- Chips de status + "aguardando N min" (accent-700)
- Selecionado: fundo neutral-100 + shadow-sm

### MessageBubble
```tsx
<MessageBubble type="received | sent | system" message={m} />
```
- 3 tipos, NUNCA mais. Canto "apontado" (radius-sm) marca a origem
- Largura máx. 62% no inbox
- Cor (CRMLAB-25): recebida `--color-chat-received`, enviada `--color-chat-sent`, as duas com
  borda de 1px do par `-border` e sobre o papel BRANCO da conversa. Lado + cor: bate o olho e
  se sabe quem falou. As antigas `surface` / `accent-200` misturavam com `--color-bg` e, sobre o
  bege do tema, fundo e as duas bolhas viravam a mesma coisa
- Anexo `messageType: 'image'` (CRMLAB-15): thumbnail (`rounded-md`, máx. 300px de altura) no lugar
  do link "Anexo (tipo)". Clique abre `ImageLightbox` em tela cheia — padrão WhatsApp Web
- Anexo `messageType: 'audio'` (CRMLAB-2): `AudioMessage` na própria bolha no lugar do link.
  Os demais `messageType` continuam com o link genérico
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
- `useAuthenticatedMedia` devolve também o `fileName` (do `Content-Disposition` de
  `GET /media/:id`), repassado ao `ImageLightbox` — é o nome com que a imagem é salva (CRMLAB-26)

### AudioMessage (CRMLAB-2)
```tsx
<AudioMessage url={message.attachmentUrl} />
```
- Player de áudio dentro da bolha: `<audio controls>` NATIVO — play/pause, barra com tempo
  decorrido/total, seek e teclado de graça. Player desenhado à mão só entra se o visual virar
  exigência real (mesma lógica do `EmojiPicker` sem biblioteca)
- Busca o blob autenticado por `useAuthenticatedMedia`; `src` é o object URL, nunca a URL crua
- Link "Baixar áudio" sempre visível: o Evolution entrega ogg/opus, que o Safari não toca. Se o
  `<audio>` dispara `error`, o player dá lugar a um aviso e o download fica como plano B

### Composer
- Input pílula + botão anexo + botão emoji + botão enviar (primary)
- Enter envia, Shift+Enter quebra linha
- **Ctrl+B / Cmd+B** (CRMLAB-51, D-183): envolve a seleção em asteriscos (`*seleção*`, que a
  bolha e o WhatsApp mostram em negrito) e mantém o texto selecionado; sem seleção, insere `**`
  com o cursor no meio
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

#### Emoji (Onda 8 §2.2)
- Popover com grade de ~48 emojis de uso comum em atendimento; **sem
  dependência** — um seletor com busca por nome custa centenas de KB para um
  caso que não pede busca. Se a busca virar necessidade real, entra biblioteca,
  e o popover já está isolado num componente (`EmojiPicker`).
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
- Rodapé: nome, "Cargo · vX.Y.Z" (cargo = `role` traduzido em pt-BR, CRMLAB-44) — só a versão
  quando recolhido. `__APP_VERSION__` injetada em build-time pelo Vite a partir do `package.json`
  da raiz do monorepo (`frontend/vite.config.ts`), sem chamada de rede
- Estado recolhido/expandido persiste em `localStorage` (`crm-lab.sidebar-collapsed`,
  `ui.store.ts`) — preferência duradoura, ao contrário do resto do `ui.store` (sessionStorage,
  D-117)

### InboxLayout
- 3 colunas: 336px fixo | flex 1 min 440px | 316px recolhível
- Estreito: overflow-x na linha (não colapsar colunas)

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
```
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

### ImageLightbox (CRMLAB-15, zoom em CRMLAB-21)
```tsx
<ImageLightbox src={url | null} fileName="foto.jpg" onClose={() => {}} />
```
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
- Usado no modal Importar (`/results` e `/reconciliation`, §14-15)

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
| `MessageBubble` | `<MessageBubble type message maxWidth? showMeta? />` | `type` ∈ `received \| sent \| system` — os únicos 3 · `*texto*` em negrito (D-183) |
| `AudioMessage` | `<AudioMessage url />` | `<audio controls>` nativo com blob autenticado · download sempre disponível |
| `Composer` | `<Composer onSend(content) onAttach? disabled? sending? placeholder? quickReplies? />` | Enter envia · Shift+Enter quebra linha · Ctrl/Cmd+B envolve a seleção em `*` · emoji insere no cursor · `/` no campo vazio abre as macros |
| `EmojiPicker` | `<EmojiPicker onPick(emoji) disabled? />` | Grade fixa de 48, sem biblioteca · `Esc` fecha e devolve o foco |
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
