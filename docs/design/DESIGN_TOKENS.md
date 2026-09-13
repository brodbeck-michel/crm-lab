# 🎨 Design Tokens - Sistema de Design

Tokens de cor, tipografia, espaçamento e componentes para manter a consistência visual em todo o projeto.

---

## Cores (CSS Variables)

### 5 Temas Pré-definidos

#### Tema 1: Terracota & Sálvia (Padrão)
```css
:root {
  --color-accent: #c67139;        /* Terracota - ação principal */
  --color-accent-2: #7a8a5e;      /* Sálvia - positivo/interno */
  --color-bg: #f5ead8;            /* Fundo bege quente */
  --color-surface: #ebddc5;       /* Superfície tingida */
  --color-text: #1a1a1a;          /* Texto escuro */
}
```

#### Tema 2: Azul Jaleco
```css
:root {
  --color-accent: #2f6f9f;        /* Azul clínico */
  --color-accent-2: #4f9d8b;      /* Teal */
  --color-bg: #eef3f7;
  --color-surface: #dbe6ef;
  --color-text: #1a1a1a;
}
```

#### Tema 3: Verde Esterilizado
```css
:root {
  --color-accent: #2f7d5f;        /* Verde cirúrgico */
  --color-accent-2: #6d8f4e;      /* Menta */
  --color-bg: #eef5f0;
  --color-surface: #d9e8de;
  --color-text: #1a1a1a;
}
```

#### Tema 4: Hemograma
```css
:root {
  --color-accent: #a63a3a;        /* Bordô */
  --color-accent-2: #7a6b8a;      /* Lilás */
  --color-bg: #f7efee;
  --color-surface: #ecdad8;
  --color-text: #1a1a1a;
}
```

#### Tema 5: Lilás Diagnóstico
```css
:root {
  --color-accent: #6a4f9c;        /* Lilás reagente */
  --color-accent-2: #3f8a9a;      /* Azul petróleo */
  --color-bg: #f3f1f8;
  --color-surface: #e2dcef;
  --color-text: #1a1a1a;
}
```

### Rampas de Cores Derivadas

Cada cor base gera automaticamente 9 tons (100-900):

```css
:root {
  /* Acento: Tons de 100 a 900 */
  --color-accent-100: color-mix(in oklab, var(--color-accent) 12%, var(--color-bg));
  --color-accent-200: color-mix(in oklab, var(--color-accent) 26%, var(--color-bg));
  --color-accent-300: color-mix(in oklab, var(--color-accent) 40%, var(--color-bg));
  --color-accent-400: color-mix(in oklab, var(--color-accent) 54%, var(--color-bg));
  --color-accent-500: var(--color-accent);
  --color-accent-600: color-mix(in oklab, var(--color-accent) 84%, var(--color-text));
  --color-accent-700: color-mix(in oklab, var(--color-accent) 70%, var(--color-text));
  --color-accent-800: color-mix(in oklab, var(--color-accent) 56%, var(--color-text));
  --color-accent-900: color-mix(in oklab, var(--color-accent) 28%, var(--color-text));
  
  /* Similar para --color-accent-2 e --color-neutral */
}
```

### Papéis de Cor

| Token | Uso | Exemplo |
|-------|-----|---------|
| `--color-bg` | Fundo da aplicação | Body, container principal |
| `--color-surface` | Superfície tingida de 2º nível | Trilho lateral, cartões resumo |
| `--color-neutral-100` | Cartão elevado | Cartões de lista, tabelas |
| `--color-text` | Texto principal | Títulos, corpo |
| `--color-accent` | Ação e atenção | Botão primário, filtro ativo |
| `--color-accent-2` | Estado positivo/âmbito interno | Não lidas, ganho, chat interno |
| `--color-neutral-300` | Bordas e divisores | Linhas de tabela |
| `--color-neutral-600` | Texto secundário | Legendas, placeholder |

### Uso de Rampas

```css
/* Regra de uso dos tons 100-900 */

/* Preenchimentos tingidos (hovers) */
background: var(--color-accent-100);  /* 100-300 */

/* Hover state */
background: var(--color-accent-200);

/* Base/pressionado */
background: var(--color-accent-500);

/* Texto sobre preenchimento tingido */
color: var(--color-accent-700);       /* 700-900 */

/* Nota importante: Nunca usar 500 para texto de corpo (contraste insuficiente) */
color: var(--color-accent-600);       /* ✓ Mínimo para corpo */
```

---

## Tipografia

### Fontes

```css
:root {
  --font-heading: 'Playfair Display', 'Caprasimo', serif;
  --font-body: 'Figtree', system-ui, sans-serif;
}
```

**Google Fonts Import:**
```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Caprasimo&family=Figtree:wght@400;500;600;700&family=Playfair+Display:wght@600;700&display=swap">
```

### Escala Tipográfica

| Tamanho | Família | Peso | Uso |
|---------|---------|------|-----|
| 32px | Heading | 400 | Título de tela |
| 21px | Heading | 400 | Título de seção |
| 30px | Heading | 400 | Indicador (38%) |
| 13.5px | Body | 600 | Rótulo de item |
| 13px | Body | 400 | Corpo e prévia |
| 11px | Body | 600 | Cabeçalho de tabela (caixa alta) |

### Nomes dos degraus (classes Tailwind)

A escala acima existe como `theme.extend.fontSize` em `frontend/tailwind.config.js`.
**São estes sete nomes e nenhum outro** — não existe `text-body-md`, `text-body-sm`,
`text-sm`, `text-xs` nem `text-lg` neste projeto.

| Classe | Tamanho | Papel |
|--------|---------|-------|
| `text-display` | 32px heading | Título de tela (`h1`) |
| `text-metric` | 30px heading | Indicador numérico de cartão |
| `text-section` | 21px heading | Título de seção (`h2`, `h3`) |
| `text-label` | 13.5px / 600 | Rótulo de item, nome em lista, rótulo de campo |
| `text-body` | 13px | Corpo, prévia, célula de tabela |
| `text-caption` | 12px | Legenda, meta, paginação, chip |
| `text-micro` | 11px / 600 caixa alta | Cabeçalho de tabela, rótulo de indicador |

**A escala default do Tailwind (`text-xs`…`text-3xl`) é proibida.** Ela continua existindo
no tema resolvido — `extend` faz *merge* com o default — mas usá-la coloca duas escalas
tipográficas no mesmo app. Vale o mesmo para cor: a rampa neutra vai de **100 a 900**;
`neutral-50` não é nossa, é o `#fafafa` fixo do Tailwind, imune a `applyTheme()`.

Quem garante isso é `frontend/src/components/tailwind-theme-classes.spec.ts`, que valida
toda classe `text-*`/`bg-*` de `src/` contra `theme.extend` (não contra o tema resolvido:
o merge com o default É o problema).

### Cor em biblioteca de gráfico (Recharts)

O Recharts pinta eixo, grade e série por **prop**, não por classe. Os tokens chegam até ele
por `frontend/src/components/analytics/chartTokens.ts` — e são os mesmos papéis da tabela
acima, sem token novo: eixo/legenda `--color-neutral-600`, grade e borda de tooltip
`--color-neutral-300`, série primária/de atenção `--color-accent`, série positiva/receita
`--color-accent-2`, fundo do tooltip `--color-surface`.

Não existem `--color-text-secondary`, `--color-border`, `--color-success` nem
`--color-warning`: são sinônimos inventados de tokens que já existem.

### Aplicação em CSS

```css
/* Título de tela */
h1 {
  font-family: var(--font-heading);
  font-size: 32px;
  font-weight: 400;
  letter-spacing: -0.015em;
  line-height: 1.08;
}

/* Título de seção */
h2 {
  font-family: var(--font-heading);
  font-size: 21px;
  font-weight: 400;
  letter-spacing: -0.015em;
}

/* Indicador numérico (use white-space: nowrap) */
.indicator {
  font-family: var(--font-heading);
  font-size: 30px;
  font-weight: 400;
  white-space: nowrap;
}

/* Corpo de texto */
body {
  font-family: var(--font-body);
  font-size: 13px;
  font-weight: 400;
  line-height: 1.55;
}

/* Rótulo (leve destaque) */
.label {
  font-size: 13.5px;
  font-weight: 600;
}

/* Cabeçalho de tabela */
table thead {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
```

---

## Espaçamento & Raio

### Raio de Borda

```css
:root {
  --radius-sm: 4px;     /* Canto apontado da bolha */
  --radius-md: 8px;     /* Cartões de lista, campos multilinha */
  --radius-lg: 12px;    /* Painéis, colunas, modal */
  --radius-pill: 999px; /* Pílulas: botões, campos 1-linha, avatares (LITERAL, não variável) */
}
```

### Sombra

```css
:root {
  --shadow-sm: 0 1px 3px rgba(0, 0, 0, 0.12), 0 1px 2px rgba(0, 0, 0, 0.08);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.15);
  --shadow-lg: 0 12px 32px rgba(0, 0, 0, 0.20);
}
```

**Uso:**
```css
/* Cartão em repouso */
box-shadow: var(--shadow-sm);

/* Hover de cartão arrastável */
box-shadow: var(--shadow-md);

/* Modal */
box-shadow: var(--shadow-lg);
```

### Espaçamento

```css
:root {
  /* Padding interno em pílulas */
  --padding-pill: 10px 18px;  /* Altura ~36px */
  
  /* Padding em cartões */
  --padding-card: 14px 16px;
  
  /* Gap entre items */
  --gap-xs: 4px;
  --gap-sm: 8px;
  --gap-md: 12px;
  --gap-lg: 16px;
  --gap-xl: 24px;
}
```

**A escala é fechada: 4 · 8 · 12 · 16 · 24.** Não existe degrau de 20px nem de
32px — quem precisava deles encosta no vizinho (`p-5` virou `p-lg`, `py-8` virou
`py-xl`). Precisa mesmo de um degrau novo? **Documente-o AQUI primeiro**, some a
`tailwind.config.js` (`theme.extend.spacing`) e só então use.

**No Tailwind** todo espaçamento sai destes tokens — `p-lg`, `gap-sm`, `mb-md`,
`space-y-xl` —, nunca da escala numérica default (`p-5`, `gap-4`, `mb-4`). A
numérica não passa por `var(--gap-*)`: é pixel cravado no componente, e num
arquivo com as duas convenções o ritmo vertical muda de linha para linha
(Onda 6 — D9 da Onda 5; 57 ocorrências unificadas).

| px | Token | Classe Tailwind |
|----|-------|-----------------|
| 4  | `--gap-xs` | `p-xs` `gap-xs` `mb-xs` |
| 8  | `--gap-sm` | `p-sm` `gap-sm` `mb-sm` |
| 12 | `--gap-md` | `p-md` `gap-md` `mb-md` |
| 16 | `--gap-lg` | `p-lg` `gap-lg` `mb-lg` |
| 24 | `--gap-xl` | `p-xl` `gap-xl` `mb-xl` |

Únicas exceções numéricas: `p-0` / `m-0` (zero é reset, não degrau) e frações
(`top-1/2`). Largura e altura (`w-80`, `h-12`, `min-w-0`) são **dimensão**, não
espaçamento — a escala não as cobre.

> Regra **testada**: `frontend/src/components/no-hardcoded-tokens.spec.ts` lê
> todo `.tsx` de `src/components/` e `src/pages/` e falha em espaçamento fora
> da escala, além de hex, `font-family` literal e raio em px.

---

## Componentes

### Botões

```css
/* Primário */
button.primary {
  background: var(--color-accent);
  color: var(--color-bg);
  border: none;
  border-radius: 999px;
  padding: 10px 18px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s;
}

button.primary:hover {
  background: var(--color-accent-600);
}

/* Secundário */
button.secondary {
  background: transparent;
  border: 1px solid var(--color-neutral-400);
  border-radius: 999px;
  padding: 9px 16px;
  color: var(--color-text);
  cursor: pointer;
}

button.secondary:hover {
  background: var(--color-neutral-200);
}

/* Confirmação (positivo) */
button.confirmation {
  background: var(--color-accent-2);
  color: var(--color-bg);
  border: none;
  border-radius: 999px;
  padding: 10px 18px;
  font-weight: 600;
  cursor: pointer;
}

button.confirmation:hover {
  background: var(--color-accent-2-700);
}

/* Destrutivo */
button.destructive {
  background: transparent;
  border: none;
  color: var(--color-accent-700);
  border-radius: 999px;
  padding: 9px 12px;
  font-weight: 600;
  cursor: pointer;
}

button.destructive:hover {
  background: var(--color-accent-100);
}
```

### Campos

```css
/* Uma linha = pílula */
input[type="text"],
input[type="email"],
textarea.single-line {
  background: var(--color-bg);
  border: 1px solid var(--color-neutral-300);
  border-radius: 999px;
  padding: 10px 16px;
  font-size: 13.5px;
  color: var(--color-text);
}

input:focus {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}

/* Multilinha = radius-md */
textarea {
  border-radius: var(--radius-md);
  padding: 10px 14px;
}

/* Segmentado = trilho com pílula */
.segmented-control {
  display: flex;
  gap: 4px;
  background: var(--color-bg);
  border-radius: 999px;
  padding: 4px;
}

.segmented-control > span {
  flex: 1;
  text-align: center;
  padding: 7px;
  border-radius: 999px;
  cursor: pointer;
  transition: all 0.2s;
}

.segmented-control > span.active {
  background: var(--color-accent);
  color: var(--color-bg);
  font-weight: 600;
}
```

### Chips & Badges

```css
/* Neutro/Positivo (Sálvia) */
.chip.positive {
  background: var(--color-accent-2-200);
  color: var(--color-accent-2-800);
  border-radius: 999px;
  padding: 3px 11px;
  font-size: 12px;
  font-weight: 600;
}

/* Exige ação (Terracota) */
.chip.attention {
  background: var(--color-accent-200);
  color: var(--color-accent-800);
  border-radius: 999px;
  padding: 3px 11px;
  font-size: 12px;
  font-weight: 700;
}

/* Filtro inativo (Cinza) */
.chip.inactive {
  background: var(--color-neutral-200);
  border-radius: 999px;
  padding: 3px 11px;
  font-size: 12px;
}

/* Badge circular (contagem) */
.badge {
  min-width: 20px;
  height: 20px;
  border-radius: 999px;
  background: var(--color-accent-2);
  color: var(--color-bg);
  font-size: 11px;
  font-weight: 700;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 6px;
}
```

### Bolhas de Mensagem

```css
/* Recebida */
.message-bubble.received {
  background: var(--color-surface);
  border-radius: var(--radius-md) var(--radius-md) var(--radius-md) var(--radius-sm);
  padding: 11px 15px;
  font-size: 13.5px;
  align-self: flex-start;
  max-width: 78%;
}

/* Enviada */
.message-bubble.sent {
  background: var(--color-accent-200);
  border-radius: var(--radius-md) var(--radius-md) var(--radius-sm) var(--radius-md);
  padding: 11px 15px;
  font-size: 13.5px;
  align-self: flex-end;
  max-width: 78%;
}

/* Evento do sistema */
.message-bubble.system {
  background: var(--color-accent-2-100);
  border: 1px solid var(--color-accent-2-300);
  border-radius: 999px;
  padding: 5px 14px;
  font-size: 12px;
  color: var(--color-accent-2-800);
  align-self: center;
}
```

---

## Estados

### Hover
```css
/* Menu item */
.menu-item:hover {
  background: var(--color-accent-100);
}

/* Botão secundário */
button.secondary:hover {
  background: var(--color-neutral-200);
}

/* Cartão arrastável */
.card.draggable:hover {
  box-shadow: var(--shadow-md);
}
```

### Selecionado
```css
.menu-item.active {
  background: var(--color-accent-200);
  box-shadow: var(--shadow-sm);
}

.conversation-item.selected {
  background: var(--color-neutral-100);
  box-shadow: var(--shadow-sm);
}
```

### Foco (Teclado)
```css
*:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
}
```

### Pressionado
```css
button:active {
  background: var(--color-accent-600);
}
```

### Vazio (Sem dados)
```css
.empty-state {
  text-align: center;
  color: var(--color-neutral-600);
  padding: 40px 20px;
}

.empty-state p {
  font-size: 14px;
  line-height: 1.5;
}
```

---

## Layouts

### Sidebar
```css
aside.sidebar {
  width: 272px;           /* Expandido */
  /* width: 64px; */      /* Recolhido (D-128) */
  background: var(--color-surface);
  padding: 26px 16px;
  display: flex;
  flex-direction: column;
  gap: 22px;
  position: sticky;
  top: 0;
  height: 100vh;
  overflow-y: auto;
}
```

### Inbox (3 colunas)
```css
.inbox {
  display: grid;
  grid-template-columns: 336px 1fr 316px;
  gap: 0;
  min-height: 100vh;
}

.inbox-conversations { width: 336px; }
.inbox-chat { flex: 1; min-width: 440px; }
.inbox-context { width: 316px; }
```

### Orçamento (2 colunas)
```css
.budget-layout {
  display: grid;
  grid-template-columns: 1fr 372px;
  gap: 0;
}

.budget-catalog { flex: 1; min-width: 520px; }
.budget-summary { width: 372px; }
.budget-total { position: sticky; bottom: 0; }
```

---

## Responsividade

### Breakpoints
```css
/* Desktop: sem restrição */
/* Tablet: 768px - 1024px */
@media (max-width: 1024px) {
  .inbox {
    grid-template-columns: 1fr 200px;  /* Esconde chat ou reduz */
  }
}

/* Mobile: < 768px */
@media (max-width: 768px) {
  .inbox {
    grid-template-columns: 1fr;  /* Stack vertical */
  }
  
  .inbox-context {
    display: none;  /* Esconde contexto */
  }
}
```

---

## Próximas Leituras

- `docs/design/COMPONENTS_UI.md` - Especificação detalhada de componentes
- `docs/design/THEMES.md` - Como personalizar temas
- `Design System CRM.dc.html` - Implementação visual completa

