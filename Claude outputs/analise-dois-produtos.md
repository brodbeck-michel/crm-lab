# Análise dos dois produtos

Levantamento por engenharia reversa do código, docs e histórico git das duas pastas conectadas.
Data: 2026-09-05.

---

# 1. CRM Lab — CRM SaaS multitenant para laboratórios de análises clínicas

## O que é

Produto SaaS **multitenant** vendido para laboratórios independentes. Cobre a etapa **anterior ao pedido**: da primeira mensagem do paciente no WhatsApp até o orçamento aceito. O LIS do laboratório continua sendo o sistema-mestre — o CRM não o substitui.

A tese do produto está na especificação original (`CRM SaaS Laboratorio Especificacao.docx`) e ataca cinco dores de laboratório pequeno/médio: orçamento respondido no WhatsApp pessoal sem rastreio, preços diferentes por atendente, orçamento esquecido sem follow-up, gestor sem taxa de conversão, e nenhum histórico quando o paciente volta.

O princípio de produto declarado em `docs/README.md` é curto e explica o desenho das telas: **"conversação é o produto"** — toda tela existe para encurtar o caminho entre a primeira mensagem e a coleta agendada.

## Arquitetura real (o que está no código, não o que a spec prometeu)

Monorepo npm workspaces: `shared/` · `backend/` · `frontend/` · `e2e/`.

| Camada | Escolha | Nota |
|---|---|---|
| Backend | **Express 4 + TypeScript ESM** | NestJS da spec foi descartado (decisão D-007) |
| Padrão | controller → service → repository | controller fino: valida zod, chama service, responde |
| Persistência | **Sem ORM.** SQL parametrizado à mão | dois drivers atrás de uma interface: `pg` (Postgres 16) e **PGlite** para testes (D-008) |
| Cache/rate limit | Redis 7, com fallback em memória | |
| Fila | fila **in-process** com retry exponencial | Bull/BullMQ é intenção, não código — a interface existe para Bull entrar depois |
| Real-time | WebSocket próprio (`lib/ws-hub.ts`) | |
| Frontend | React 18 + Vite + Tailwind 3 + TanStack Query + Zustand + React Router v6 | dado de servidor **só** em TanStack Query; Zustand guarda sessão/UI (fronteira é teste, não convenção) |
| Borda | Nginx na imagem do frontend, proxy de `/api` e `/ws` | TLS fica no proxy de borda do host |

**Tipos compartilhados como fonte única:** `shared/types/` espelha `docs/api/API_CONTRACTS.md`; back e front importam de `@crm-lab/shared`. Constantes canônicas (`ALLOWED_TRANSITIONS`, `calculateTotal`, `DEFAULT_DISCOUNT_LIMIT`, `ApiErrorCode`) vivem lá — não são reimplementadas nos dois lados.

## Isolamento multitenant — o ponto mais forte do projeto

Três camadas, com a terceira sendo real e testada:

1. **Identificação** — `tenantId` vem sempre do JWT via `getContext(req)`, nunca de query/body/header.
2. **Filtro de query** — todo SELECT carrega `tenant_id = $1`.
3. **RLS do PostgreSQL** — cada transação abre com `set_config('app.tenant_id', …, true)` seguido de `SET LOCAL ROLE crm_app`. A ordem importa: o `set_config` roda como a role original, a troca vem depois. `crm_app` não é dona das tabelas e não tem `BYPASSRLS`, senão as policies não valeriam nada.

As policies são **fail-closed por construção**: sem contexto de tenant a comparação vira `NULL` e nenhuma linha aparece, nenhum INSERT passa. Funciona igual em Postgres 16 e em PGlite. Até a tabela raiz `tenants` está sob RLS (policy pela própria coluna `id`) — sem isso, qualquer caminho que esquecesse o filtro enumeraria a carteira de clientes.

O escape hatch `db.withoutTenant()` roda como dona das tabelas e burla RLS. **Só dois caminhos podem usá-lo:** o login (busca usuário por e-mail antes de saber o tenant) e o console de plataforma. Está registrado como exceção auditada em `src/db/types.ts`.

Há um teste que varre as **39 rotas** de laboratório com dois tenants e um meta-teste que reprova rota nova sem declaração de isolamento.

## Regras de negócio críticas

1. **Total é sempre derivado** — `totalPrice = Σ items × (1 − desconto)`, calculado no backend. O cliente nunca envia total.
2. **Alçada por perfil** — atendente 15%, gestor 30%, admin sem limite. Validada **sempre** no backend; o frontend só faz UX.
3. **Aprovação via chat interno** — desconto acima da alçada vira pedido no canal `#aprovacoes` com o orçamento anexado, WS `approval.requested`, sem auto-aprovação (D-046).
4. **Pipeline de 6 estágios** com matriz `ALLOWED_TRANSITIONS`; `perdido` exige `reasonLost` válido.
5. **Tema é dado, não código** — cor/raio/fonte por tenant, zero hex hardcoded em componente (há teste que reprova token cru).
6. **Auditoria** — proposta, aprovação e permissão geram audit log; `audit_logs` é **por tenant**, não compartilhada.
7. **Erro de outro tenant → `NOT_FOUND`**, nunca `FORBIDDEN` (não confirma existência).
8. **Dinheiro no fio** é decimal (`179.80`), nunca string formatada; datas ISO 8601 UTC.

## Módulos entregues

`auth` · `users` · `conversations` · `messages/whatsapp` · `webhooks` · `proposals` · `approvals` · `exam-catalog` · `insurances` (convênios/TUSS) · `themes` · `audit` · `analytics` · `internal-chat` · `platform` (console + billing) · `patients` (ficha + timeline + LGPD export/anonimização) · `channel-settings` · `operations`.

24 telas no frontend, incluindo Atendimento (inbox 3 colunas), Novo Orçamento, Pipeline kanban, Catálogo, Convênios, Conversão (analytics), Ficha do Paciente, Canais & Equipe, Gestão da Operação, Chat Interno, Personalização, Usuários e o Console da Plataforma.

## Maturidade e volume

| Métrica | Valor |
|---|---|
| Backend | 86 arquivos, ~21.900 linhas TS |
| Frontend | 187 arquivos, ~22.650 linhas TS/TSX |
| Shared | 16 arquivos, ~1.350 linhas |
| E2E | 18 arquivos, ~4.470 linhas |
| Migrações | 6 arquivos, 1.090 linhas SQL |
| Arquivos de teste | 112 |
| Testes (fim da Onda 6) | 674 backend · 728 frontend · 103 e2e, zero skip |
| Decisões registradas | 108 (D-001 → D-108) |
| Fluxos E2E | 16 (`flow-1` … `flow-14` + isolamento) |

CI/CD em GitHub Actions: `quality → build → docker → e2e`, com o e2e **bloqueante** (Postgres 16 real + migrate + seed). O job de build verifica **artefatos emitidos**, não só exit code. Duas imagens Docker, non-root. `docker-compose.prod.yml` sobe postgres, redis, migrate, backend, frontend e o gateway Evolution.

## O processo de desenvolvimento é parte do produto

Vale registrar porque é atípico: o projeto é construído por **agentes paralelos com `docs/` como contrato** ("Regra Zero": nenhum agente inventa endpoint, tabela ou componente que não esteja documentado — documenta primeiro, implementa depois). Cada onda termina com uma **rodada de validação independente** por três auditores que não participaram da implementação (Contratos, Segurança, Verificação), e os achados viram decisões registradas.

As duas lições de processo escritas em `STATUS.md` são boas o suficiente para virar padrão fora deste projeto:

- **Verde por escopo não compõe.** Na Onda 6, nove agentes e três validadores viram verde; a suíte completa não estava. O `flow-12` criava 25 exames sem limpar e, rodando antes na ordem alfabética, empurrava para fora da primeira página o exame que outros dois fluxos clicavam. Debaixo da poluição havia um defeito real de produto: a tela de Novo Orçamento carregava só a primeira página do catálogo — laboratório com mais de 50 exames ativos não conseguia montar orçamento.
- **Pendência se escreve pelo comportamento, não pela tela.** A pendência foi registrada como "`/proposals` e `/catalog`" em vez de "listagem sem paginação", então o fechamento parou nas duas telas conhecidas e deixou a terceira quebrada por mais uma onda.
- **Comentário em código não é contrato.** Três violações vieram com comentários longos documentando a própria violação ("DIVERGÊNCIA CONHECIDA") e nenhuma tinha chegado ao `docs/`.

## Onda 7 — onde está agora

Em andamento, Fase 3 concluída em 2026-09-03, último commit em 2026-09-05. Três frentes:

- **Convênios/TUSS (Trilha A)** — convênio como entidade, preço por convênio, código TUSS/AMB, sinônimos e material no catálogo. Preparação estrutural para o catálogo ser espelhado do Bitlab.
- **WhatsApp por QR via Evolution API** — conexão do número do próprio laboratório sem depender da API oficial da Meta, com modal de aceite e credenciais cifradas por tenant.
- **Fechamento de pendências** — HMAC sobre `rawBody` (era sobre JSON reserializado), `MAX_PAGE` nos services restantes, remoção de contrato sem implementação.

## O que a spec prometeu e não existe

Importante para não vender o que não está construído:

- **OCR + IA** para ler requisição fotografada — não há nada disso no código.
- **Conectores LIS pré-built** (Autolac, Concent, LabSolution, LABSYS, WorkLab) — não existem.
- **API real da Meta** — `WHATSAPP_API_URL` vazia usa `MockWhatsAppDriver`. O webhook nunca foi exercitado contra a Meta real (o bug de HMAC falhava fechado, então ninguém percebia).
- **Stripe / SendGrid** — sem pagamento nem e-mail em nenhum workspace.
- **Bull/BullMQ, Kubernetes, Elasticsearch** — intenções da spec, não código.

## Riscos e pontos abertos

| Risco | Situação |
|---|---|
| **`PLAN_CATALOG` (D-019)** | Preço, franquia de mensagens e valor de excedente de `GET /platform/billing` foram **definidos por um agente** para a rota ter resposta. Ninguém confirmou com produto — e isso vira faturamento real. É a pendência de maior consequência comercial. |
| **Hospedagem indefinida** | Os dois documentos de integração com o Bitlab têm `[PREENCHER: nuvem ou on-premise, e faixa de IP de saída]`. A resposta muda o `DEPLOYMENT.md` e provavelmente a topologia de rede. |
| **`CHANNEL_SECRET_KEY` única, sem rotação** | Trocar a chave invalida as credenciais gravadas e obriga cada laboratório a reconectar o canal. Risco aceito conscientemente (D-076). |
| **LGPD: texto de mensagem não é reescrito** | A anonimização cobre cadastro, colunas denormalizadas, anexos e audit log — mas o **texto** das mensagens permanece, para não destruir o histórico de terceiros na mesma conversa. Limitação declarada; vale validar com o jurídico. |
| **Telefone fora do formato é recusado, não normalizado** | Normalizar mudaria a chave de dedupe `(tenant_id, phone)` e poderia fundir cadastros. A perda deixou de ser silenciosa, mas o canal não reentrega. |
| **Árvore de trabalho suja** | Há ~20+ arquivos modificados e não commitados no backend agora. Antes de qualquer coisa, vale um `git status` completo e decidir o que entra. |
| **`.env` com segredos reais numa pasta do OneDrive** | `DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `CHANNEL_SECRET_KEY` e `EVOLUTION_API_KEY` estão em texto claro numa pasta sincronizada com a nuvem corporativa. Não está no git (bom), mas está no OneDrive. |

## Integração com o Bitlab — o que o negócio pede a seguir

`docs/integracoes/` traz a solicitação formal, versão 2.0, Agosto/2026. O Bitlab é o LIS proprietário da própria Unimed Tubarão. A **Fase 1 é somente leitura** e resolve dois problemas nomeados:

1. catálogo e preços mantidos à mão no CRM → divergência entre o valor informado ao paciente e o praticado;
2. impossibilidade de confirmar se o orçamento virou requisição e foi recebido → o desfecho comercial é marcação manual da atendente.

**Bloco A (catálogo/preços)** — o CRM já tem código, nome, categoria, ativo, preparo, TAT e preço particular. A Onda 7 acabou de cobrir preço por convênio, TUSS/AMB e sinônimos. Ainda faltam **composição de painéis** e a **coluna de origem** (interno × espelhado do LIS) que decide quem vence quando a sincronização e a atendente editam a mesma linha — sem ela, sincronização diária e edição manual brigam.

**Bloco B (orçamento → requisição → baixa financeira)** — conceito novo, depende da resposta do Bitlab. A amarração preferida é por **código de referência** em campo livre do orçamento do Bitlab (sem dado pessoal trafegando, sem escrita via API); a alternativa é por CPF/telefone.

---

# 2. orcamentos-sante-main — FluxoLab

## O que é

**Painel interno de gestão comercial do Laboratório Santé.** Um único laboratório, sem multitenancy, sem conceito de assinatura. Analisa retrospectivamente o que já aconteceu: orçamentos emitidos, quantos viraram requisição, quanto foi recebido, quem vendeu.

Não é um produto SaaS. É uma ferramenta de gestão de um cliente específico.

## Origem e estado do repositório

Nasceu no **Lovable** e foi bifurcado em julho/2026 para repositório independente com **banco Supabase próprio** (`nxgpdaoeaafkfwzpyxap`), clonado do original em 2026-07-17 com schema, dados e usuários (senhas preservadas). O app original no Lovable permanece congelado; as duas bases divergem desde a clonagem.

**Três achados sobre o estado atual, em ordem de urgência:**

1. **Toda a pasta `src/` e `specs/` está apagada na árvore de trabalho.** O `git status` mostra `D` para os 148 arquivos rastreados. O código existe apenas no histórico git (e no deploy da Vercel). A pasta, como está, não builda. Recuperável com `git checkout -- .` — mas vale entender o que apagou antes de restaurar.
2. **Último commit em 2026-07-17** — parado há ~7 semanas.
3. Sobraram na pasta apenas `node_modules/`, `dist/`, `.vercel/`, os arquivos de config e a planilha de origem.

## Stack

| Camada | Escolha |
|---|---|
| Framework | **TanStack Start (React 19)** + Vite 7 — SSR com nitro |
| Roteamento | TanStack Router, file-based (`src/routes/_authenticated.*`) |
| Backend | **Nenhum próprio.** O cliente fala direto com o Supabase |
| Dados/Auth | Supabase — Postgres + Auth + RLS |
| UI | Tailwind 4 + shadcn/ui (Radix) + lucide + sonner |
| Estado de servidor | TanStack Query |
| Gráficos | Recharts |
| PDF | jsPDF + jspdf-autotable |
| Planilha | SheetJS (`xlsx`) no navegador |
| Deploy | Vercel, Build Output API via nitro |

Decisão de arquitetura elegante e digna de nota: **não há service_role key em lugar nenhum.** A gestão de usuários (listar, criar, alterar papel, resetar senha) é feita por **RPCs `SECURITY DEFINER`** com `admin_assert_caller()` embutido, chamadas com a sessão do próprio admin (anon key + Bearer). O motivo prático foi que o app roda fora do Lovable e o dashboard do projeto Supabase gerenciado não era acessível para copiar a chave — mas o resultado é melhor que a alternativa: nenhuma chave de superusuário sai do banco.

## Modelo de dados (Supabase)

| Tabela | Papel |
|---|---|
| `profiles` | 1:1 com `auth.users`; guarda `full_name` e o vínculo `atendente` |
| `user_roles` | enum `app_role`: `admin` · `user` · `atendente`; `has_role()` `SECURITY DEFINER` |
| `atendentes` | cadastro de atendentes (unique case-insensitive por nome), seed com 9 nomes |
| `exames` | catálogo com código, nome, categoria, sinônimos, ativo |
| `vendas` | registro manual de venda: atendente, data, código, valor, exames, tipo (`exames`/`checkup`) |
| `importacoes` | evento de carga ou limpeza: arquivo, linhas lidas/aceitas/rejeitadas, status, autor. **Sem policy de DELETE — histórico imutável** |
| `orcamentos` | um registro por `numero` (unique), até 3 cotações de convênio, requisição, valor pago, `importacao_id` |

RLS em todas. `orcamentos` e `importacoes` têm `REVOKE ALL ... FROM anon` explícito como defesa extra de LGPD (nome de paciente nunca acessível a anônimo), além da policy que restringe leitura a `admin ∪ user` — atendente não vê orçamento.

`vendas` tem policy mais fina: cada um vê e edita as próprias, admin vê todas.

## O fluxo central — importação de planilha

É o coração do produto e está bem especificado (Spec Kit, `specs/001-orcamentos-supabase/`, com spec, plan, data-model, contracts, research, tasks e checklist).

1. Gestor sobe o **Relatório de Orçamentos** (XLSX exportado do sistema do laboratório).
2. `parseOrcamentoFile` lê no navegador com SheetJS. Valida assinatura `%PDF` (pega o caso clássico do PDF renomeado para `.xlsx`) e exige a coluna `ORCAMENTO`.
3. Trata data serial do Excel materializando no **fuso local** — porque todos os agrupamentos usam getters locais e criar em UTC deslocava o dia para trás no Brasil. Detalhe pequeno e correto.
4. Convênios 2 e 3 são **cotações alternativas do mesmo orçamento**, não valores adicionais: o valor de referência é o do primeiro convênio informado com valor > 0.
5. Consolida linhas do mesmo número: representativo = maior total; `valor_pago` e `valor_requisicao` = máximo entre as linhas; `data_pagamento` acompanha a linha do maior pago.
6. Upsert por `numero` — **idempotente** (reimportar não duplica) e **acumulativo** (orçamento de importação anterior nunca some).
7. Registra a importação com contagens e status `processando → concluida | falhou`.

Campos derivados (`total`, `convenioPrincipal`, `convertido`, `pago`) **não são persistidos** — são recalculados na leitura, deliberadamente, para preservar paridade exata com o cálculo anterior e evitar coluna divergindo da regra.

Há inclusive um caminho de transição do armazenamento local antigo (`sante-orcamentos-v1`) para a base central, com card de migração no Dashboard.

## Telas

- **Dashboard** (1.076 linhas) — KPIs de total orçado / em requisição / recebido / atendentes com taxa de conversão; evolução mensal (orçado × requisição × recebido); ranking de faturamento por atendente; distribuição por convênio (pizza); comparativo top-5 atendentes ao longo do tempo; detalhe por atendente com % de comissão configurável; detalhe por convênio. Filtros globais de período e convênio.
- **Conferência** (427 linhas) — tabela ordenável por 8 colunas, filtro de com/sem requisição.
- **Busca Ativa** (643 linhas) — orçamentos pendentes de conversão com *aging* em faixas (≤7d verde, ≤15d âmbar, ≤30d laranja, >30d vermelho) e exportação PDF com logo. É a tela que gera trabalho: a lista de quem ligar hoje.
- **Vendas** (592 linhas) — registro manual de venda por atendente com gráficos e comissão.
- **Admin** — usuários (401 linhas), atendentes, exames.
- **Relatório executivo** (`executiveReport.ts`, 1.051 linhas) — PDF que combina orçamentos + vendas, normaliza nomes de atendente para consolidar as duas fontes na mesma linha, limita conversão a 100% e exige amostra mínima de 20 orçamentos para entrar em ranking qualitativo. Cuidado estatístico raro em relatório interno.

Volume: ~7.000 linhas de código próprio (fora os componentes shadcn), 148 arquivos rastreados.

## Pontos fracos

| Ponto | Consequência |
|---|---|
| **Zero testes automatizados, zero CI** | Toda a regra de consolidação, dedupe e KPI — que é onde mora o valor — não tem nenhuma rede. Contraste gritante com o CRM Lab (1.500 testes). |
| **Toda a lógica roda no navegador** | `fetchOrcamentos()` traz a base inteira para o cliente e o `useMemo` faz dedupe, agrupamento e KPI. A própria spec estima "dezenas de milhares" de linhas no histórico anual. Isso degrada de forma previsível — e a paginação/agregação teria que ser refeita como view ou RPC no Postgres. |
| **Comissão em `localStorage`** | `commissionConfig.v1` e `comissao.pct` são por navegador. Duas pessoas geram o mesmo relatório executivo com números de comissão diferentes e nenhuma das duas sabe. Isso deveria estar numa tabela. |
| **Nome de paciente trafega inteiro para o cliente** | Coerente com o desenho atual (gestão vê tudo), mas é dado pessoal saindo do banco em volume para o navegador de todo gestor. |
| **Sem histórico de conversão própria** | O produto sabe se o orçamento virou requisição porque a planilha diz. Não sabe o que a atendente fez no meio — não há follow-up, contato registrado, nem motivo de perda. |
| **`.env` com chaves na pasta do OneDrive** | Mesma observação do outro projeto. Aqui o dano é menor (a anon key é pública por desenho), mas a prática vale rever. |

---

# 3. Como os dois se relacionam

Mesmo domínio, pontas opostas do mesmo processo.

```
          ┌──────────────── CRM Lab ─────────────────┐   ┌──── LIS ────┐   ┌── FluxoLab ──┐
paciente → conversa → orçamento montado → enviado →  ...  requisição → baixa → planilha → painel
          └── produz o orçamento, antes do LIS ──────┘                        └ lê o que já aconteceu ┘
```

| | CRM Lab | FluxoLab |
|---|---|---|
| Natureza | Produto SaaS multitenant | Ferramenta interna de um laboratório |
| Momento | **Operacional** — produz o orçamento | **Analítico** — lê o resultado |
| Fonte do dado | Conversa real, em tempo real | Planilha exportada do LIS, em lote |
| Backend | Express próprio, 22k linhas | Nenhum — Supabase direto |
| Multitenancy | RLS de 3 camadas, provada com teste | Não existe |
| Testes | ~1.500 | 0 |
| Processo | docs como contrato, validação independente por onda | ad-hoc, com Spec Kit em uma feature |
| Estado | ativo, Onda 7 em curso | parado desde julho, `src/` apagada na árvore |

**A observação estratégica:** o FluxoLab é, na prática, uma implementação manual do **Bloco B** da integração com o Bitlab que o CRM Lab está pedindo — a conciliação orçamento → requisição → baixa financeira, feita hoje por planilha em vez de API. E as regras que o FluxoLab já validou em produção (dedupe por orçamento, maior valor pago por requisição, convênios 2 e 3 como cotações alternativas, cap de conversão, amostra mínima para ranking) são exatamente o que o `AnalyticsService` do CRM vai precisar quando a conciliação real chegar.

Vale tratar o FluxoLab menos como projeto parado e mais como **especificação viva de analytics já batida em campo** — antes que ele se perca. O primeiro passo, aliás, é restaurar a árvore de trabalho.
