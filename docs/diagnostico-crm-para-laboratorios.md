# Diagnóstico do CRM Apexio para Laboratórios

> Documento gerado por investigação de código. Segue a regra obrigatória: nenhuma informação de negócio (clientes, faturamento, métricas, preços, resultados, diferenciais) foi inventada. Toda afirmação está classificada como `CONFIRMADO` (com evidência de arquivo/linha), `INFERÊNCIA` (conclusão provável baseada no código), `NÃO ENCONTRADO`, `NÃO SEI RESPONDER` ou `DECISÃO NECESSÁRIA`.

## 1. Resumo executivo

`CONFIRMADO`: o código implementa um **CRM operacional multitenant para gestão de atendimento comercial via WhatsApp e propostas/orçamentos**, com um domínio de dados já modelado para laboratórios de análises clínicas (pacientes, catálogo de exames com códigos TUSS/AMB, convênios/preço por convênio). Evidência: `shared/types/patient.types.ts`, `shared/types/exam.types.ts`, `shared/types/insurance.types.ts`, `shared/types/proposal.types.ts`, tabelas `patients`, `exam_catalog`, `insurances`, `exam_prices` (migrações `003_patients_and_channels.sql`, `005_insurances_and_catalog.sql`).

`CONFIRMADO`: o produto **não é um protótipo estático** — é um sistema funcional com autenticação real (JWT + refresh + rotação + detecção de reuso), isolamento multitenant real via Row-Level Security do Postgres, integração real com WhatsApp (dois modos: API oficial da Meta e gateway Evolution self-hosted via QR Code, testado contra um número real segundo `docs/STATUS.md`), motor de aprovação de desconto com alçada por papel, auditoria e anonimização LGPD. Evidência detalhada nas seções 3, 5, 6, 7.

`CONFIRMADO`: **não há evidência de nenhum cliente real, contrato, CNPJ ou faturamento real** no repositório. O nome "Apexio" citado na tarefa que originou este diagnóstico **não aparece** em nenhum lugar do código-fonte, `package.json` (que se chama `"crm-lab"`) ou documentação de produto — aparece apenas no arquivo de instrução externo `prompt avaliacao crm.txt`, que não faz parte do produto.

`INFERÊNCIA`: o produto foi construído em um ciclo muito curto e intenso — 60 commits entre 2026-08-24 e 2026-09-06 (13 dias corridos), com múltiplos agentes trabalhando por domínio (padrão de commits `[api]`, `[ui]`, `[db]`, `[docs]`, `[qa]`, `[infra]`) — consistente com um MVP construído por um processo de desenvolvimento assistido por IA, ainda em fase de validação interna ("dogfooding"), e não com um produto maduro em operação comercial.

A oportunidade real, com base apenas no que o código entrega hoje, é de um **CRM de atendimento + funil comercial para laboratórios pequenos/médios que atendem majoritariamente via WhatsApp**, com ainda pouca cobertura de funcionalidades tipicamente esperadas em "gestão comercial completa" (prospecção ativa, campanhas, gestão de parceiros/franquias, cobrança real). Detalhamento nas seções 8 a 17.

## 2. Escopo da análise

`CONFIRMADO`: foram analisados, por 4 investigações paralelas de código (sem alterar nenhum arquivo):
- Backend completo: `backend/src/controllers/*.routes.ts`, `backend/src/services/*.service.ts`, `backend/src/repositories/*.repository.ts`, `backend/src/http/*`, `backend/src/db/*`, `backend/src/lib/*`, `backend/src/main.ts`, `backend/src/app.ts`.
- Banco de dados: as 9 migrações reais em `backend/migrations/` (`001` a `009`), cruzadas com `docs/database/SCHEMA.md`.
- Frontend: roteamento (`frontend/src/routes/*`), layout (`frontend/src/components/layout/*`), todas as pastas de páginas em `frontend/src/pages/**`, componentes de negócio (`proposal/`, `conversation/`, `analytics/`, `users/`, `theme/`).
- Tipos compartilhados: todo `shared/types/*.ts` (fonte única de contratos, conforme `CLAUDE.md`).
- Documentação interna do projeto: `docs/README.md`, `docs/QUICK_START.md`, `docs/ARCHITECTURE.md`, `docs/DECISIONS.md` (parcial — ver limitação abaixo), `docs/STATUS.md`, `docs/AGENTS.md`, `docs/domain/*`, `docs/api/*`, `docs/frontend/*`, `docs/database/SCHEMA.md`, specs e planos em `docs/superpowers/*`.
- Histórico Git (`git log`) e pasta `e2e/` (17 specs de fluxo Playwright).

**Limitações desta análise** (`NÃO SEI RESPONDER` / não coberto):
- `docs/DECISIONS.md` tem ~1150 linhas; apenas as primeiras ~656 (até D-063) foram lidas integralmente por um dos agentes. Decisões D-064 em diante (parte da Onda 6 tardia, 7 e 8) foram cruzadas indiretamente via código, não lidas linha a linha no próprio documento.
- Alguns arquivos de service/página foram confirmados por uso/importação, mas não lidos linha a linha: `backend/src/services/theme.service.ts`, `channel-settings.service.ts`, `internal-chat.service.ts`, `quick-reply.service.ts`, `media.service.ts` em detalhe; `frontend/src/pages/InternalChat/ApprovalActions.tsx`, `Settings/Operation.tsx`, `Settings/Insurances.tsx`, `QuickReplies/QuickReplies.tsx`, `Patients/Profile.tsx`.
- `backend/src/db/tenant-context.ts` (mecanismo exato de troca de role/RLS) teve sua existência confirmada mas não seu conteúdo lido linha a linha.
- Não houve execução de `npm run typecheck` nem das suítes de teste nesta investigação (não era necessário — trabalho puramente de leitura, nenhum código foi alterado).
- Não há acesso a nenhum sistema externo (CRM comercial, planilha de vendas, e-mail, conversas de clientes) — a análise está 100% restrita ao que existe no repositório de código.

## 3. O produto atual

`CONFIRMADO` (`docs/README.md:1,5,7-9`, `docs/QUICK_START.md:7-13`): o próprio código/documentação descreve o produto como um "CRM SaaS para Laboratórios" — "sistema de chat + orçamentos + propostas para laboratórios de análises clínicas", multitenant, com pipeline comercial de 6 estágios.

`CONFIRMADO`, funcionalmente, o produto é composto por três blocos que já funcionam de ponta a ponta no código:
1. **Atendimento (Inbox)**: recebe mensagens de WhatsApp (dois provedores), permite responder, transferir, fixar, arquivar, anexar mídia, usar macros ("/" no composer) e emoji.
2. **Funil comercial (Propostas/Orçamentos)**: criação de orçamento a partir de uma conversa ou avulso, cálculo de total sempre no backend, desconto com alçada por papel, fluxo de aprovação quando o desconto excede a alçada, pipeline Kanban/Lista com 6 estágios e motivo obrigatório para "perdido".
3. **Administração multitenant**: cadastro de usuários e permissões, catálogo de exames (com preço por convênio), convênios, tema visual por tenant, auditoria, e um console de plataforma (visão do dono do SaaS sobre todos os tenants, incluindo um dashboard de uso/faturamento estimado).

`CONFIRMADO`: o produto tem uma camada explícita de "console de plataforma" (`/platform/*`, papel `platform_operator`) separada da camada "tenant" (laboratório) — ou seja, já existe a arquitetura de um SaaS multi-cliente operado por um provedor central, não apenas um sistema single-tenant.

`NÃO ENCONTRADO`: qualquer posicionamento comercial, proposta de valor, ou material de vendas dentro do repositório — o produto "fala de si mesmo" apenas em termos técnicos/funcionais nos documentos internos de engenharia.

## 4. Problema resolvido atualmente

- **Confirmado**: o sistema resolve a centralização e triagem do atendimento via WhatsApp (fila de conversas, atribuição, transferência) e a padronização/rastreabilidade do processo de orçamento comercial (cálculo confiável de total, controle de desconto por alçada, funil com estágios e motivo de perda, histórico de aprovação). Evidência: `backend/src/services/conversation.service.ts`, `proposal.service.ts`, `approval.service.ts`, tabelas `conversations`, `proposals`, `proposal_status_history`.
- **Inferência**: isso resolve, para um laboratório real, a dor de "descontos dados sem controle" e "orçamento perdido/esquecido no WhatsApp pessoal do atendente" — mas essa é uma leitura do que a modelagem de dados e as regras de negócio implicam, não uma afirmação testada com um cliente real.
- **Não comprovado**: não há qualquer evidência (log de uso real, depoimento, métrica) de que esse problema já foi resolvido *na prática* para algum laboratório. Tudo o que existe é a capacidade técnica do sistema de resolvê-lo, validada apenas por testes automatizados e dados de seed fictícios (`Laboratório Vida`, `Laboratório Central` — `backend/src/db/seeds/dev.ts:241-242,261`).

## 5. Funcionalidades existentes

| Funcionalidade | Existe? | Classificação | Evidência | Relevância para laboratório |
|---|---|---|---|---|
| Login/autenticação multitenant | Sim | CONFIRMADO | `backend/src/services/auth.service.ts`, `shared/types/auth.types.ts` | Alta — pré-requisito básico |
| Papéis e permissões (attendant/manager/admin/platform_operator) | Sim | CONFIRMADO | `shared/types/auth.types.ts:5`, `route-config.ts` (guards por papel) | Alta — reflete hierarquia real de clínica/laboratório |
| Inbox de atendimento via WhatsApp | Sim | CONFIRMADO | `frontend/src/pages/Attendance/*`, `backend/src/services/conversation.service.ts` | Alta — canal dominante de contato com paciente |
| WhatsApp via API oficial (Meta Cloud API) | Sim | CONFIRMADO | `backend/src/services/whatsapp.service.ts` (`HttpWhatsAppDriver`) | Alta, mas exige aprovação/custo Meta |
| WhatsApp via QR (Evolution API self-hosted) | Sim | CONFIRMADO | `backend/src/lib/evolution-client.ts`, `EvolutionWhatsAppDriver`; testado com número real (`docs/STATUS.md` linha ~173) | Alta — caminho de entrada mais barato/rápido para laboratório pequeno |
| Anexo de mídia no atendimento | Sim | CONFIRMADO | `Attendance/index.tsx` (`sendAttachment`), tabela `message_media` | Média-alta — envio de pedido de exame, resultado, comprovante |
| Gravação/envio nativo de áudio | Não verificado como gravação de voz; existe upload de arquivo genérico | NÃO ENCONTRADO (gravação de mic específica) | `Attendance/index.tsx:220-225` só usa `<input type="file">` | Média — depende de necessidade real do laboratório |
| Macros / respostas rápidas ("/") | Sim | CONFIRMADO | `Composer.tsx`, `quick-reply.service.ts`, tabela `quick_replies` | Alta — agiliza respostas padronizadas (ex.: preparo de exame) |
| Transferência de conversa / fila | Sim | CONFIRMADO | `ConversationPanel.tsx` (`TransferMenu`), `conversation.service.ts` (resolução de corrida de atribuição) | Alta |
| Fixar conversa | Sim | CONFIRMADO | tabela `conversation_pins`, `Attendance/index.tsx:165-170` | Baixa-média (produtividade do atendente) |
| Criação de orçamento/proposta | Sim | CONFIRMADO | `Budget/New.tsx`, `proposal.service.ts` | Alta — núcleo comercial |
| Cálculo de total sempre no backend | Sim | CONFIRMADO | `calculateTotal`/`calculateSubtotal` em `shared/types/proposal.types.ts` | Alta — integridade financeira |
| Alçada de desconto por papel (15/30/100%) | Sim | CONFIRMADO | `DEFAULT_DISCOUNT_LIMIT` em `shared/types/auth.types.ts:8-13` | Alta — controle interno |
| Fluxo de aprovação de desconto acima da alçada | Sim | CONFIRMADO | `approval.service.ts`, rotas `PATCH /proposals/:id/approve|reject` | Alta |
| Pipeline comercial (Kanban/Lista, 6 estágios) | Sim | CONFIRMADO | `Proposals.tsx`, `ALLOWED_TRANSITIONS` em `proposal.types.ts` | Alta |
| Motivo obrigatório em "perdido" | Sim | CONFIRMADO | `proposal.service.ts` (`LOSS_REASON_REQUIRED`) | Média — inteligência de perda |
| Catálogo de exames | Sim | CONFIRMADO | `exam.routes.ts`, `exam-catalog.service.ts`, tabela `exam_catalog` | Alta — específico de laboratório |
| Códigos TUSS/AMB no exame | Sim (campo existe, nunca inventado se não confirmado) | CONFIRMADO | `exam.types.ts`, migração `005_insurances_and_catalog.sql`, decisão D-081 | Alta — padrão do setor de saúde suplementar |
| Convênios e preço por convênio | Sim | CONFIRMADO | `insurance.service.ts`, `exam_prices`, `insurance.types.ts` | Alta — típico de laboratório que atende convênio + particular |
| Ficha/cadastro de paciente | Sim (nasce do primeiro contato, sem cadastro manual via API) | CONFIRMADO | `patient.service.ts`, `patient.types.ts`, tabela `patients` | Alta |
| Exportação e anonimização de dados do paciente (LGPD) | Sim | CONFIRMADO | `patient.routes.ts` (`/export`, `/anonymize`), decisões D-062/D-063 | Alta — obrigação legal em saúde |
| Auditoria de ações | Sim (login/refresh/logout confirmados; proposta/aprovação/permissão citados na doc mas não lidos linha a linha nesta rodada) | CONFIRMADO (parcial) / DOC não verificado | `audit.service.ts`, `audit.repository.ts` | Alta — rastreabilidade |
| Dashboard de conversão/analytics | Sim | CONFIRMADO | `Analytics.tsx`, `analytics.service.ts` | Média-alta — gestão comercial |
| Chat interno da equipe | Sim | CONFIRMADO | `InternalChat/*`, `internal-chat.service.ts`, tabela `internal_channels` | Média — colaboração interna, não é diferencial exclusivo de laboratório |
| Personalização de tema visual por tenant | Sim | CONFIRMADO | `Settings/Theme.tsx`, `theme.service.ts` | Baixa (estético) |
| Console de plataforma multi-tenant (para o dono do SaaS) | Sim | CONFIRMADO | `Platform/Tenants.tsx`, `Platform/Billing.tsx`, `platform.service.ts` | Alta para o **operador do SaaS**, não para o laboratório-cliente |
| Cobrança/billing real (gateway de pagamento) | Não — só dashboard de uso/estimativa | NÃO ENCONTRADO (cobrança real) / CONFIRMADO (dashboard agregado) | `platform.service.ts` (`PLAN_CATALOG` hardcoded, sem Stripe/gateway) | Alta se a promessa for "SaaS com cobrança automática" — hoje não existe |
| Prospecção / captação ativa de leads | Não | NÃO ENCONTRADO | nenhuma rota/serviço de importação de lead, formulário externo, campanha ou integração com redes sociais | Média-alta para "gestão comercial completa" |
| Gestão de parceiros/indicação (programa de parceiros) | Não | NÃO ENCONTRADO | nenhuma entidade de "partner"/"referral" no schema ou nos tipos compartilhados | Depende do modelo de vendas escolhido |
| Pós-venda / relacionamento pós-entrega de resultado | Não modelado como etapa própria | NÃO ENCONTRADO | funil termina em `ganho`/`perdido`; não há entidade de "resultado de exame" nem follow-up pós-entrega | Média-alta — comum em laboratórios recorrentes |

## 6. Modelo de dados

`CONFIRMADO`: 23 tabelas de dados de laboratório + 1 tabela técnica (`schema_migrations`, sem `tenant_id`, sem RLS — apenas controle de versão de schema). Todas as tabelas de dados de laboratório têm `tenant_id NOT NULL` (exceto `tenants`, que é a raiz da hierarquia multitenant e usa RLS pela própria coluna `id`). Fonte: migrações `001` a `009` em `backend/migrations/`, cruzadas com `docs/database/SCHEMA.md`.

Entidades principais e relacionamentos:

- **`tenants`** — o laboratório-cliente do SaaS. Raiz de toda a hierarquia multitenant.
- **`users`** — usuários do tenant. `role` (`attendant|manager|admin|platform_operator`), `discount_limit_percent`. FK → `tenants`.
- **`patients`** — paciente do laboratório. Único por `(tenant_id, phone)`. Sem exclusão física — apenas `anonymized_at` (LGPD).
- **`conversations`** — conversa de atendimento. FK → `tenants`, `users` (atribuição, `SET NULL`), `patients` (`SET NULL`).
- **`messages`** — mensagens de uma conversa. FK → `conversations` (`CASCADE`), `users` (remetente, `SET NULL`).
- **`message_media`** — metadado de mídia anexada a uma mensagem. FK → `messages` (`CASCADE`, nullable).
- **`conversation_pins`** — conversas fixadas por usuário. PK composta `(user_id, conversation_id)`.
- **`exam_catalog`** — catálogo de exames do laboratório. Único por `(tenant_id, code)`. Campos incluem `tuss_code`, `amb_code`, `material`, `preparation`, `turnaround_hours`.
- **`exam_synonyms`** — sinônimos de nome de exame, para busca.
- **`insurances`** — convênios do laboratório. "Particular" não é uma linha da tabela — é a ausência de convênio (`insurance_id = NULL`).
- **`exam_prices`** — preço de um exame por convênio. Único por `(tenant_id, exam_id, insurance_id)`.
- **`proposals`** — orçamento/proposta comercial (entidade central do funil). FK → `conversations`, `users` (criador, aprovador), `insurances`. Campos: `status` (6 estágios), `approval_status`, `discount_percent`, `total_price` (sempre derivado, nunca enviado pelo cliente).
- **`proposal_items`** — itens de um orçamento, com snapshot de nome/preço do exame no momento da criação (o preço não muda retroativamente se o catálogo mudar depois).
- **`proposal_status_history`** — histórico de mudança de estágio de uma proposta.
- **`internal_channels`** / **`internal_messages`** — chat interno da equipe (inclui canais fixos `#geral` e `#aprovacoes`).
- **`channel_reads`** — controle de leitura de canal interno por usuário.
- **`tenant_channels`** — credenciais de canal de WhatsApp por tenant (cifradas em repouso, AES-256-GCM).
- **`tenant_settings`** — configurações gerais do tenant (distribuição de conversa, mensagens automáticas, horário de atendimento). Linha ausente = valores padrão.
- **`themes`** — tema visual por tenant (1:1).
- **`quick_replies`** — macros de atendimento.
- **`audit_logs`** — log de auditoria, append-only (exceção: anonimização LGPD apaga apenas os *valores*, preservando estrutura e metadados).
- **`refresh_tokens`** — tokens de refresh de sessão, hash armazenado (nunca em claro).

`NÃO ENCONTRADO` no schema: qualquer tabela de "resultado de exame" (laudo), "amostra"/coleta, "pedido médico", "unidade/posto de coleta", "convênio de faturamento TISS em lote", "parceiro/indicação", "campanha de marketing", "assinatura/cobrança real" (`subscriptions`), `feature_flags` — estas duas últimas são explicitamente negadas pela própria documentação (`docs/ARCHITECTURE.md`) como "nunca implementadas".

## 7. Fluxo atual do usuário

`CONFIRMADO`, a partir do roteamento real (`frontend/src/routes/route-config.ts`) e das telas:

1. **Login** (`/login`) — e-mail/senha, mensagem de erro deliberadamente genérica para não revelar se o e-mail existe.
2. **Redirecionamento por papel** (`/`): atendente → `/attendance`; gestor/admin → `/proposals`; operador de plataforma → `/platform/tenants`.
3. **Atendente**: opera principalmente a tela de **Atendimento** (`/attendance`) — fila de conversas (minhas/não atribuídas), responde, anexa mídia, usa macro, transfere quando necessário; a partir de uma conversa, pode iniciar um **Novo Orçamento** (`/budget/new?conversationId=...`), escolher exames do catálogo e convênio, aplicar desconto dentro da própria alçada (15% por padrão).
4. **Gestor/Admin**: acompanha o **Pipeline** (`/proposals`, Kanban ou Lista), abre uma proposta para ver detalhes, aprovar/rejeitar desconto acima da alçada do criador (via canal interno `#aprovações` e/ou tela de Decisões `/decisions`), mover estágio, marcar ganho/perdido (motivo obrigatório em perdido).
5. **Admin** adicionalmente configura: usuários e permissões (`/settings/users`), tema (`/settings/theme`), canais de WhatsApp incluindo conexão por QR (`/settings/channels`), convênios (`/settings/insurances`), operação (`/settings/operation`), consulta auditoria.
6. **Operador de plataforma** (fora do laboratório-cliente, é quem opera o SaaS): cria/gerencia laboratórios-clientes (`/platform/tenants`, onboarding atômico: tenant + tema + canais padrão + admin inicial em uma transação) e visualiza dashboard agregado de uso/faturamento estimado (`/platform/billing`) — sem acesso a conteúdo de conversa, dado de paciente ou valor de proposta individual (isolamento reforçado por design, `platform.service.ts`).

`INFERÊNCIA`: este fluxo é coerente com uma operação onde o atendente é o "primeiro contato" e o gestor controla exceções (desconto alto) — um modelo hierárquico simples, comum em pequenos negócios de saúde. Não há evidência de fluxos mais complexos (múltiplos aprovadores, aprovação em cadeia, SLA de resposta).

## 8. Aderência ao laboratório

| Necessidade do laboratório | Solução atual | Classificação | Evidência | O que falta |
|---|---|---|---|---|
| Atender paciente por WhatsApp | Inbox completo, 2 provedores | CONFIRMADO | `Attendance/*`, `whatsapp.service.ts` | Nada crítico — já funcional |
| Montar orçamento com preço por convênio | Sim | CONFIRMADO | `Budget/New.tsx`, `exam_prices` | Nada crítico |
| Controlar desconto dado por atendente | Sim, com aprovação | CONFIRMADO | `proposal.service.ts`, `approval.service.ts` | Nada crítico |
| Cadastro de exames com código TUSS/AMB | Sim | CONFIRMADO | `exam.types.ts` | Preenchimento real dos códigos é trabalho de configuração/conteúdo, não de desenvolvimento |
| Emitir/gerenciar laudo de exame | Não existe | NÃO ENCONTRADO | nenhuma tabela/serviço de "resultado" | Desenvolvimento — módulo de laudo/resultado não existe |
| Gerenciar coleta/agendamento (unidade, horário) | Não existe | NÃO ENCONTRADO | nenhuma entidade de agenda/coleta no schema | Desenvolvimento — se for prioridade, é módulo novo |
| Faturamento contra convênio (TISS em lote) | Não existe | NÃO ENCONTRADO | preço por convênio existe (comercial), mas não há geração de guia/lote TISS | Desenvolvimento (interface com sistema de faturamento em saúde) |
| Gestão de múltiplos atendentes com fila | Sim | CONFIRMADO | `conversation.service.ts` (atribuição, corrida resolvida no banco) | Nada crítico |
| Relatório de conversão comercial | Sim (funil, receita, motivos de perda, ranking) | CONFIRMADO | `Analytics.tsx`, `analytics.service.ts` | Nada crítico |
| Cobrança do laboratório pelo uso do SaaS | Só dashboard agregado, sem gateway de pagamento | CONFIRMADO (parcial) | `platform.service.ts` (`PLAN_CATALOG` hardcoded) | Desenvolvimento + decisão comercial: integração de pagamento real |
| Adequação a LGPD (dado sensível de saúde) | Exportação e anonimização existem | CONFIRMADO | `patient.routes.ts` (`/export`, `/anonymize`) | Revisão jurídica/compliance (fora do escopo técnico) — `DECISÃO NECESSÁRIA` |
| Nomenclatura "cliente"→"paciente" | Já usa "paciente" nativamente | CONFIRMADO | `patient.types.ts` (não é um `contact`/`lead` genérico renomeado) | Nada — já nasceu com nomenclatura de laboratório |
| Gestão de parceiros (médicos que indicam, convênios como canal) | Convênio existe como entidade comercial (preço), não como "parceiro relacional" | INFERÊNCIA (parcial) | `insurance.types.ts` | Depende de decisão de negócio sobre o que significa "gestão de parceiros" aqui |

## 9. ICP recomendado

`INFERÊNCIA`, baseada exclusivamente na capacidade real do sistema (não em pesquisa de mercado, que não existe no repositório): o produto, hoje, é mais compatível com **laboratórios de pequeno/médio porte que já concentram atendimento comercial via WhatsApp**, com equipe pequena de atendentes (o modelo de fila e alçada de 15%/30%/100% sugere times pequenos, não call centers grandes), e que precisam de controle simples de desconto/aprovação e visibilidade de funil — mas que **ainda não** precisam de emissão de laudo, agendamento de coleta ou faturamento TISS em lote dentro do mesmo sistema (porque essas funcionalidades não existem).

`DECISÃO NECESSÁRIA`: se o ICP-alvo do negócio exige essas funcionalidades ausentes (laboratórios maiores, com integração LIS, faturamento de convênio em lote), o produto atual não atende e isso precisa ser uma decisão consciente de escopo antes de qualquer investimento comercial.

Não trato isso como fato de mercado — é uma leitura de aderência técnica, não uma validação com laboratórios reais (que não existe no repositório).

## 10. Comprador e usuários

`INFERÊNCIA`: os papéis do sistema (`attendant`, `manager`, `admin`) sugerem que o **usuário do dia a dia** é o atendente/recepcionista do laboratório, o **usuário de controle** é o gestor comercial ou dono da operação, e o **comprador provável** é o admin/dono do laboratório (único papel com acesso a usuários, tema e configuração de canal). Essa inferência vem exclusivamente da estrutura de permissões do código (`shared/types/auth.types.ts`, `route-config.ts`), não de qualquer pesquisa com compradores reais.

`NÃO SEI RESPONDER`: quem de fato decide a compra de um sistema como esse dentro de um laboratório real (dono, gestor administrativo, gestor de TI, franqueadora) — isso não pode ser respondido pelo código.

`DECISÃO NECESSÁRIA`: validar com laboratórios reais quem efetivamente assina o contrato/decide a compra.

## 11. Dor real

`CONFIRMADO` que o produto consegue resolver hoje, tecnicamente:
- Centralizar o atendimento de WhatsApp de múltiplos atendentes em uma única fila, com histórico e transferência (evita perder contexto quando o paciente troca de atendente).
- Impedir que um desconto acima do combinado seja aplicado sem aprovação (controle de margem).
- Dar visibilidade de funil comercial (quantas propostas em cada estágio, motivo de perda) que uma planilha ou WhatsApp Business isolado não oferece.

`NÃO ENCONTRADO` / dores que o produto **ainda não resolve**, segundo o código:
- Emissão e entrega de laudo/resultado de exame.
- Agendamento de coleta e gestão de unidades físicas.
- Faturamento contra convênio em lote (TISS/XML).
- Prospecção ativa de novos pacientes/convênios (o sistema só reage a contatos que já chegam via WhatsApp).
- Cobrança automática do próprio laboratório-cliente pelo uso do SaaS (billing é só relatório).

## 12. Posicionamento

`DECISÃO NECESSÁRIA`: uma mensagem comercial definitiva é decisão de negócio, não de código. Com base apenas no que é tecnicamente comprovado:

- **Promessa possível**: "centralize o atendimento por WhatsApp e controle os orçamentos e descontos do seu laboratório em um só lugar, com aprovação de gestor quando necessário."
- **Promessa que NÃO pode ser feita hoje**: qualquer promessa envolvendo emissão/entrega de laudo, agendamento de coleta, faturamento de convênio em lote, cobrança automática do laboratório pelo SaaS, ou "gestão completa do ciclo do paciente" — nenhuma dessas etapas existe no código.
- **Diferenciais comprovados**: cálculo de total e alçada de desconto sempre validados no servidor (não manipuláveis pelo cliente), suporte a dois modos de WhatsApp (oficial Meta e QR self-hosted, mais barato), preço por convênio já modelado nativamente, LGPD (exportar/anonimizar paciente) já implementado.
- **Diferenciais ainda inexistentes** (não confirmados no código, portanto não podem ser anunciados como prontos): laudo digital, agenda de coleta, faturamento TISS, cobrança automatizada, integração com LIS (sistema de laboratório).

## 13. Canais de venda

`DECISÃO NECESSÁRIA` para todos os itens abaixo — o código não contém nenhuma informação sobre canal de venda, marketing ou aquisição de cliente. As avaliações a seguir são inferências de adequação de produto, não recomendações validadas:

- **Venda direta**: `INFERÊNCIA` — plausível, dado que o produto exige uma etapa de onboarding com decisões de configuração (canal de WhatsApp, catálogo, convênios) que provavelmente se beneficiam de um processo de venda consultiva/setup assistido, evidenciado pelo próprio fluxo de onboarding atômico do console de plataforma (`platform.service.ts`).
- **Indicação/parcerias**: `NÃO SEI RESPONDER` se faz sentido — não há no código nenhum mecanismo de referral, e o setor de laboratórios tem players de distribuição (ex.: fornecedores de reagentes, contadores especializados em saúde) que poderiam ser canal, mas isso é hipótese de mercado, não achado de código.
- **LinkedIn**: `NÃO SEI RESPONDER` — decisão de marketing, fora do escopo do código.
- **Instagram**: `NÃO SEI RESPONDER` — decisão de marketing, fora do escopo do código.
- **Blog/conteúdo**: `NÃO SEI RESPONDER` — decisão de marketing, fora do escopo do código.
- **Outros canais**: `NÃO SEI RESPONDER`.

Nenhuma dessas escolhas pode ser fundamentada em evidência de código — são perguntas de estratégia comercial que exigem decisão do negócio, não do produto.

## 14. Modelo de negócio

`NÃO SEI RESPONDER: faltam dados para definir preço.`

Dados que precisam ser obtidos antes de definir um modelo de negócio real:
- Custo de operação por tenant (infraestrutura, mensagens WhatsApp via Meta Cloud API vs. Evolution self-hosted).
- Disposição a pagar de laboratórios do porte-alvo.
- Se a cobrança será por mensagem, por usuário, por proposta, ou fixa por plano — hoje o código só tem uma estrutura **provisória e explicitamente marcada como não-oficial no próprio código-fonte** (`PLAN_CATALOG` em `platform.service.ts`, comentário do código a identifica como decisão técnica temporária, D-019, não como definição comercial).

`CONFIRMADO`: o mecanismo técnico para medir uso (mensagens/mês, propostas) já existe (`platform.service.ts`, `getBilling`), o que **facilita** — mas não decide — a criação futura de um modelo de cobrança baseado em uso.

## 15. Planos

`NÃO SEI RESPONDER: faltam dados para definir preço.` A tabela de planos com valores em R$ que existe hoje no código (`PLAN_CATALOG`) é uma estrutura técnica provisória para o dashboard de uso interno do console de plataforma — **não é uma decisão de precificação comercial validada** e não deve ser tratada como tal neste diagnóstico (regra de não inventar preço).

Separação exigida:
- **Funcionalidades atuais que poderiam compor um plano "base"**: atendimento WhatsApp (1 canal), pipeline de propostas, catálogo de exames, convênios, usuários com papéis, tema, auditoria — todas `CONFIRMADO` como já implementadas.
- **Funcionalidades que exigem desenvolvimento antes de virar item de plano superior**: cobrança automática real, múltiplos canais de WhatsApp por tenant, laudo digital, agendamento de coleta, faturamento TISS.
- **Decisões de preço ainda pendentes**: `DECISÃO NECESSÁRIA` — todo o desenho de planos e valores.

## 16. Adaptações para laboratórios

| Adaptação | Classificação |
|---|---|
| Nomenclatura "paciente" em vez de "contato" genérico | Já nativa no código — nenhuma adaptação necessária |
| Convênio como entidade de precificação | Já nativa — nenhuma adaptação necessária |
| Código TUSS/AMB no exame | Já nativo (campo existe) — adaptação de **conteúdo** (preencher os códigos reais) |
| Preparo do exame (`preparation`) exibido ao paciente | Campo existe no catálogo (`exam.types.ts`) — checar se já aparece na UI de atendimento; se não, é **desenvolvimento** pequeno/UX |
| Textos de macro/resposta rápida específicos de laboratório (ex.: instruções de jejum) | Estrutura existe (`quick_replies`) — preenchimento é **conteúdo**, não desenvolvimento |
| Horário de atendimento por dia da semana | Já existe em `tenant_settings`/`Settings/Channels.tsx` — **configuração** |
| Laudo/resultado de exame | Não existe — **desenvolvimento** |
| Agendamento de coleta | Não existe — **desenvolvimento** |
| Faturamento TISS em lote | Não existe — **desenvolvimento + integração** |
| Cobrança automática do SaaS | Não existe — **desenvolvimento + integração + decisão comercial** |
| Precificação de planos | Não definida — **decisão comercial** |

## 17. MVP

### P0 — necessário para validar
- Atendimento WhatsApp (já existe — `CONFIRMADO`).
- Orçamento com convênio, desconto com alçada e aprovação (já existe — `CONFIRMADO`).
- Catálogo de exames com preço por convênio, incluindo preenchimento real de TUSS/AMB para pelo menos um laboratório piloto (conteúdo, não desenvolvimento).
- Onboarding funcional de um tenant real via console de plataforma (já existe tecnicamente — `CONFIRMADO`; falta validar operacionalmente com um laboratório real).

### P1 — próximo após validação
- Exibir instrução de preparo de exame de forma proeminente no atendimento (verificar se já existe na UI; se não, é ajuste pequeno).
- Refinar relatórios de conversão para a realidade de laboratório (ex.: motivo de perda específico do setor).
- Decisão e implementação de um modelo de cobrança real do laboratório-cliente pelo SaaS (hoje só relatório de uso).

### P2 — futuro
- Laudo/resultado de exame integrado ao histórico do paciente.
- Agendamento de coleta.
- Faturamento TISS em lote.

### Fora do escopo inicial
- Programa de parceiros/indicação.
- Prospecção ativa/campanhas de marketing dentro do produto.
- Integração com LIS (sistema de gestão de laboratório) de terceiros.

`DECISÃO NECESSÁRIA` sobre a priorização acima: esta é uma proposta de organização técnica com base no que já existe vs. o que falta — a priorização real de negócio (o que o mercado paga primeiro) exige validação comercial que não está no código.

## 18. Riscos e limitações

- **Técnico**: `docs/STATUS.md` registra explicitamente pendências na Onda 8 (verificação Playwright e prova contra gateway WhatsApp real ainda não executadas; risco de a anonimização LGPD não cobrir mídia anexada) — risco real e documentado pelo próprio time, não inferido por mim.
- **Técnico**: parte da aprovação de desconto (botões Aprovar/Rejeitar) parece residir no chat interno (`InternalChat/ApprovalActions.tsx`), não dentro do modal de proposta — isso não foi verificado em profundidade nesta investigação; recomenda-se confirmação antes de qualquer demonstração comercial ao vivo.
- **Comercial**: não há absolutamente nenhuma validação com laboratório real — todo o "encaixe" descrito neste documento é inferência de modelagem de dados, não de uso real.
- **Comercial**: billing é apenas um relatório de uso — anunciar "cobrança automática" seria uma promessa falsa hoje.
- **Posicionamento**: o produto compete tecnicamente com CRMs genéricos de WhatsApp (existem vários no mercado) — o diferencial real está nos campos de domínio de laboratório (convênio, TUSS/AMB) e no controle de alçada/aprovação, não na tecnologia de chat em si (`INFERÊNCIA` — não há comparação de mercado no código).
- **Legal/LGPD**: dado de saúde é sensível; a existência de anonimização é um bom sinal técnico, mas não substitui uma revisão jurídica formal de compliance — `DECISÃO NECESSÁRIA`.

## 19. Perguntas sem resposta

- `NÃO ENCONTRADO`: evidência de cliente real, contrato assinado, CNPJ, faturamento, uso em produção.
- `NÃO ENCONTRADO`: onde e como o botão de Aprovar/Rejeitar desconto realmente aparece para o gestor fora do canal de chat interno (arquivo `ApprovalActions.tsx` não lido em profundidade).
- `NÃO ENCONTRADO`: qualquer módulo de laudo/resultado, agendamento de coleta ou faturamento TISS em lote.
- `NÃO SEI RESPONDER`: quem compra de fato dentro de um laboratório real, e por qual canal.
- `NÃO SEI RESPONDER`: preço, plano, modelo de cobrança comercial viável.
- `DECISÃO NECESSÁRIA`: priorização de MVP comercial (o que construir a seguir) deve ser validada com laboratórios reais, não decidida só pela lacuna técnica.
- `DECISÃO NECESSÁRIA`: se o ICP-alvo exige laudo/agenda/faturamento TISS, isso muda drasticamente o escopo de desenvolvimento necessário antes de vender.
- `DECISÃO NECESSÁRIA`: revisão jurídica formal de LGPD/compliance para dado de saúde, além do que já está tecnicamente implementado.

Não tentei responder essas perguntas inventando informação.

## 20. Plano de validação comercial

Proposta de próximos passos, sem qualquer garantia de resultado (o código não permite prever isso):

- **Entrevistas**: com 5-8 donos/gestores de laboratórios de pequeno/médio porte, focadas em: como fazem atendimento por WhatsApp hoje, como controlam desconto, como fecham convênio, se precisam de laudo/agenda no mesmo sistema.
- **Demonstrações**: mostrar especificamente o fluxo Atendimento → Orçamento → Aprovação → Pipeline, usando dados fictícios (nunca reais de terceiros), para validar se o vocabulário e o fluxo fazem sentido para o dia a dia deles.
- **Pilotos**: 1-2 laboratórios reais usando o console de plataforma para onboarding, com WhatsApp via QR (Evolution), medindo se o atendente realmente usa fila/transferência/macro no dia a dia.
- **Perguntas de validação específicas**: "Você precisaria emitir laudo por aqui, ou isso já é resolvido em outro sistema (LIS)?"; "Como você fatura contra convênio hoje?"; "Quanto você pagaria por mês por isso?"; "Quem decidiria comprar isso na sua operação?"
- **Evidências a coletar**: número de mensagens/dia real, número de propostas/mês, taxa de conversão real, motivos reais de perda, disposição a pagar declarada — nenhum desses dados existe hoje no repositório e não devem ser estimados sem coleta real.

## 21. Arquivos analisados

**Backend**: `backend/src/main.ts`, `app.ts`, `http/api-module.ts`, `http/modules.ts`, `http/middleware/auth.ts`, `http/middleware/rate-limit.ts` (parcial), todos os `controllers/*.routes.ts` (auth, theme, audit, analytics, user, channel-settings, exam, insurance, internal-chat, operation, patient, platform, proposal, quick-reply, media, conversation, webhook), todos os `services/*.service.ts` (auth, audit, theme, user, analytics, approval, exam-catalog, insurance, internal-chat, operation, patient, platform, proposal, channel-settings, conversation, message, quick-reply, media, whatsapp), `repositories/user.repository.ts`, `audit.repository.ts`, `db/pg-driver.ts`, `pglite-driver.ts`, `lib/evolution-client.ts`.

**Migrações**: `backend/migrations/001_initial_schema.sql` a `009_message_media.sql` (9 arquivos).

**Shared**: todos os arquivos em `shared/types/*.ts` (auth, proposal, patient, exam, insurance, audit, analytics, platform, conversation, quick-reply, media, settings, websocket, theme).

**Frontend**: `frontend/src/App.tsx`, `routes/index.tsx`, `routes/route-config.ts`, `routes/guards.tsx`, `components/layout/AppShell.tsx`, `Sidebar.tsx`, `PageHeader.tsx`, `hooks/useSession.ts`, `stores/auth.store.ts`, `pages/Login.tsx`, `pages/Attendance/*`, `components/conversation/*`, `pages/Proposals.tsx`, `components/proposal/*`, `pages/Budget/New.tsx`, `pages/Catalog.tsx`, `pages/Analytics.tsx`, `components/analytics/*`, `pages/InternalChat/*`, `pages/Settings/Theme.tsx`, `Users.tsx`, `Channels.tsx`, `pages/Platform/Tenants.tsx`, `Billing.tsx`.

**Documentação**: `docs/README.md`, `QUICK_START.md`, `ARCHITECTURE.md`, `DECISIONS.md` (parcial), `STATUS.md`, `AGENTS.md`, `domain/BUSINESS_RULES.md`, `domain/WORKFLOWS.md`, `api/API_CONTRACTS.md`, `api/API_ERRORS.md`, `database/SCHEMA.md`, `frontend/PAGES.md`, `superpowers/plans/*.md`, `superpowers/specs/*.md`.

**Outros**: `git log` (histórico completo, 60 commits), `e2e/` (17 specs Playwright), `package.json` (nome do projeto: `crm-lab`).

## 22. Conclusão

1. **Podemos vender o produto para laboratórios hoje?** `INFERÊNCIA`: tecnicamente, existe um produto funcional cobrindo atendimento WhatsApp + funil comercial + catálogo/convênio, suficiente para uma conversa comercial e um piloto — mas sem nenhuma validação real com laboratório. Vender uma promessa maior que isso (laudo, agenda, faturamento TISS, cobrança automática) seria vender algo que não existe.
2. **Para qual perfil de laboratório?** `INFERÊNCIA`: laboratório pequeno/médio, atendimento concentrado em WhatsApp, equipe pequena, que ainda não precisa de laudo/agenda/faturamento integrados no mesmo sistema.
3. **Qual promessa podemos fazer?** Centralizar atendimento WhatsApp e controlar orçamento/desconto/aprovação em um único lugar, com preço por convênio já nativo.
4. **O que já está pronto?** Autenticação e multitenancy, atendimento WhatsApp (2 modos), pipeline de propostas com alçada e aprovação, catálogo de exames com convênio/TUSS, LGPD (export/anonimização), auditoria, dashboard de conversão, console de plataforma para o operador do SaaS.
5. **O que precisa ser adaptado?** Preenchimento de conteúdo real (códigos TUSS/AMB, macros, textos de preparo de exame por laboratório), configuração de canal/horário por cliente.
6. **O que precisa ser construído?** Cobrança automática real (gateway de pagamento), e — se o ICP exigir — laudo/resultado de exame, agendamento de coleta, faturamento TISS em lote.
7. **Qual é o próximo passo mais seguro?** Validar com 1-2 laboratórios reais via piloto controlado (dados fictícios/de teste primeiro), antes de qualquer promessa comercial mais ampla, para confirmar se o escopo atual (sem laudo/agenda/faturamento) já é suficiente para uma primeira venda.

---

### Três principais descobertas
1. O produto já tem uma modelagem de dados e regras de negócio **genuinamente específicas de laboratório** (convênio, TUSS/AMB, preço por convênio, LGPD para dado de paciente), não é um CRM genérico com nomes trocados — isso é `CONFIRMADO` no código, não inferido.
2. A integração de WhatsApp é real e dupla (API oficial da Meta + gateway Evolution via QR), com testes contra número real segundo `docs/STATUS.md` — reduz risco técnico de um dos pilares centrais do produto.
3. Não existe nenhuma evidência de negócio real (cliente, contrato, preço, faturamento) em lugar nenhum do repositório — o produto está em estágio de MVP técnico, não de validação comercial.

### Três maiores incertezas
1. Se o ICP real de laboratórios exige laudo/agenda/faturamento TISS — isso muda completamente o escopo de desenvolvimento necessário antes de vender, e não pode ser respondido pelo código.
2. Quem decide a compra dentro de um laboratório real e por qual canal de aquisição — pergunta de mercado, não de produto.
3. Qual modelo de cobrança e preço fazem sentido — o único dado hoje (`PLAN_CATALOG`) é uma estrutura técnica provisória, não uma decisão comercial validada.

---

**Confirmação**: este arquivo foi criado em `docs/diagnostico-crm-para-laboratorios.md`, nenhum arquivo de código do produto foi alterado, e o documento foi lido por inteiro após a criação para checagem de consistência interna.
