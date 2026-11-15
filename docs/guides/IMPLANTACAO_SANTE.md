# Registro da implantação do Laboratório Santé

O que **foi feito** para colocar o Santé em produção: datas, cargas, ajustes e problemas. O
**como fazer** de cada carga está em [`MIGRACAO_SANTE.md`](MIGRACAO_SANTE.md); este arquivo é o
histórico de execução, que até 13/11/2026 só existia nas anotações das sessões de trabalho.

> Base: mapeamento da implantação feito em 11/11/2026 e anotações das sessões de 16/09 a 13/11/2026.
> Tenant de produção: **`lab-sante`**. Sem dados de paciente, senhas ou tokens neste arquivo.

---

## 1. Linha do tempo

| Data | Marco |
|---|---|
| 08/09 | Spec da fusão com o FluxoLab (`docs/superpowers/specs/2026-09-08-fusao-crm-fluxolab-design.md`) |
| 12/09 | Ondas 9 e 10 (LIS) validadas com a planilha real do Bitlab (D-124, D-125) |
| 16/09 | Produção no ar na VPS (`vitrocrm.cloud`, Caddy + TLS); backup diário do Postgres |
| 18/09 | Homologação na mesma VPS; sandbox do Bitlab avaliada |
| 19/09 | Operador da plataforma criado em hml e prod (`scripts/cria-operador-plataforma.sh`) |
| 25/09 | API de Orçamentos em prod (v1.22.0). No mesmo dia a sincronização foi **desligada**: a carga incremental sobrescrevia o valor pago |
| 28/09 | Bitlab responde: estorno + campos novos por pagamento (D-188/D-189) |
| 30/09 | Sincronização **religada** (releitura de 90 dias feita), modo "só gestão" (D-246), 1ª carga de vendas e catálogo |
| 05/10 · 13/10 | 2ª e 3ª cargas incrementais de vendas |
| 09/10 | Regras da gestora aplicadas por SQL para agilizar (§3 do guia); CRMLAB-94..98 em prod (v1.36.0) |
| 13/10 | **Data planejada da virada** — não aconteceu |
| 18/10 | 2ª rodada de usuários; 4ª e última carga de vendas; monitor de saúde com alerta (CRMLAB-99, v1.36.1) |
| 19/10 | Ambiente de treinamento preparado na hml |
| **22/10** | **Virada (D0):** Santé operando em produção, WhatsApp pareado por QR |
| 04/11 | Número restringido pelo WhatsApp por ~24 h; CRMLAB-134 (v1.43.0) |
| 06/11 | Decisão de migrar para a API oficial da Meta |
| 12/11 | Empresa verificada na Meta; ensaio real da Cloud API em prod (tenant `teste`) — `MIGRACAO_SANTE.md` §4.3.2 |
| 13/11 | Conta de teste da Meta vira a de produção; os 3 modelos aprovados. Falta só o cartão do laboratório (passo a passo enviado à Milena); a data da troca é marcada depois da confirmação |

**Duração:** cerca de 6 semanas da spec (08/09) à virada (22/10), com **9 dias de atraso** sobre a
data planejada (13/10). O atraso foi por questões operacionais do laboratório, que preferiu mudar a
data. A virada foi **direta**, sem operação em paralelo com o app antigo. Esforço de implantação
**além do desenvolvimento: cerca de 8 h**.

---

## 2. Cargas de vendas avulsas (`import:sales-supabase`)

Origem real: o app usado pelas atendentes gravava no Supabase **do Lovable**. O CSV do FluxoLab
veio só com cabeçalho em todas as cargas.

| Data | Inseridas | Total no CRM | Observação |
|---|---|---|---|
| 30/09 | 980 | 980 · R$ 69.011,42 | Junto, 175 exames com 192 sinônimos por **SQL direto** (o CSV do catálogo não aceita sinônimos) |
| 05/10 | +53 | 1.033 · R$ 72.749,66 | Atendente nova cadastrada antes da carga |
| 13/10 | +65 | 1.098 · R$ 76.951,78 | Nome da atendente trocado à mão no CSV (ver §4) |
| 18/10 | +38 | 1.135 · R$ 79.404,60 | Última, véspera do D0 planejado. Uma venda apagada no app depois da carga de 05/10 foi apagada também no CRM (o importador não apaga) |

Em todas: backup antes, dry-run, gravação e reexecução com **0 inseridas**. O export do painel do
Supabase sai separado por `;` e precisou ser convertido para vírgula.

---

## 3. Usuários e vínculo com o Bitlab

- **09/10:** atendentes ativas com alçada de 20%, aplicadas por script com audit log.
- **18/10:** segunda rodada, com o documento reenviado pela gestora em 15/10: e-mails migrados para
  o domínio `@laboratoriosante.com`, duas usuárias novas (uma gestora com alçada de 30% e uma
  atendente) e cinco ex-atendentes inativadas, com 125 orçamentos religados.
- O vínculo orçamento ↔ atendente usa o **login do Bitlab**, por nome exato (acento conta). Os
  nomes que a gestora escreve "como no Bitlab" **não** são o login: é preciso conferir o login de
  cada atendente antes de cadastrar.

---

## 4. Retrabalho e incidentes

- **Atendente com nome diferente do login.** Uma atendente usa outro login no Bitlab; foi
  renomeada no CRM e 124 orçamentos foram religados (09/10). Efeito colateral: na carga de 13/10 o
  importador de vendas, que casa pelo nome, criaria uma atendente nova — o CSV teve de ser editado.
- **Valor pago sobrescrito pela sincronização** (25–30/09): sync desligada, pedido ao Bitlab,
  correção e releitura de 90 dias.
- **Homologação com credenciais de produção (09/10):** o `homolog-sincroniza-dados.sh` falhou antes
  da etapa de contenção e a hml ficou ~3 min com o canal ativo e a chave do Bitlab. Corrigido no
  script; depois de sincronizar, conferir sempre `tenant_channels` e `lis_sync_settings` na hml.
- **Lacunas de produto descobertas na fase de regras** (mensagem fora do horário que nunca era
  enviada, alerta só em horas etc.): viraram os CRMLAB-94..98 às pressas.
- **Restrição do WhatsApp (04/11):** canal não oficial + ≈400–650 mensagens/dia útil. A mensagem
  fora do horário foi desligada em prod e 13 mensagens ficaram para reenvio.

---

## 5. Treinamento (19/10, hml)

Tenant **Laboratorio Teste** da hml preparado para a equipe:

- logins de treino de atendente e de gestor (credenciais fora do repositório);
- catálogo do Santé (175 exames e 192 sinônimos) com **preços fictícios** — no Santé o preço é 0,
  porque o orçamento vem pronto do Bitlab;
- vendas, médicos e visitas fictícios;
- canal em `cloud_api` sem `WHATSAPP_API_URL`, que cai no driver de mock: a mensagem fica "sent"
  sem sair da VPS. Um script na VPS simula a mensagem de paciente chegando;
- horário comercial curto (07:00–08:00), para a resposta de "fora do horário" disparar.

Reaproveitável em novos treinamentos sem repetir as cargas.

---

## 6. Perguntas respondidas (15/11/2026) e o que segue em aberto

Respondidas pelo Michel:

| Pergunta | Resposta |
|---|---|
| Como o tenant `lab-sante` foi criado | Por **SQL**, para agilizar. O tenant **Laboratorio Teste** da hml foi criado pela tela da plataforma |
| Houve operação em paralelo e paridade assinada | **Não.** Virada direta em 22/10; os números foram validados por duas gestoras do laboratório |
| Por que a virada atrasou (13/10 → 22/10) | Questões operacionais do laboratório, que preferiu mudar a data |
| O app antigo (Lovable/FluxoLab) foi desligado | **Não.** Segue ativo, mas sem uso |
| A chave do Bitlab é por laboratório | **Sim.** Para o Santé o Bitlab liberou a API sem custo |
| Os percentuais de comissão | O CRM tem três: **orçamentos, exames e check-up** (`commissionBudgetPct`, `commissionExamsPct`, `commissionCheckupPct` em `shared/types/lis.types.ts`) |
| Coexistência ou migração completa na Meta | **Migração completa**: a coexistência exige um provedor parceiro e aumenta o custo (`MIGRACAO_SANTE.md` §4.2) |
| O treinamento foi suficiente | Sim. Apareceram poucas dúvidas, na semana seguinte à virada |
| Esforço de implantação além do desenvolvimento | Cerca de **8 h** |

Ainda em aberto:

1. Retenção do `patient_name` vindo do LIS (dado pessoal sem `patient_id`).
2. Quando desligar o app antigo, que segue ativo: o plano da spec era somente leitura → pausa em
   30 dias → exclusão em 90.
3. Se o Bitlab cobra a API de outros laboratórios.
4. O percentual de comissão de orçamentos do Santé, que não está na tabela da §3.1 do
   `MIGRACAO_SANTE.md`.

---

## 7. O que levar para o próximo laboratório

- Começar pelo que depende de terceiros: chave do LIS (presa ao IP da VPS) e, se for usar a API
  oficial do WhatsApp, a **verificação da empresa na Meta**.
- Conferir os **logins do LIS** de cada atendente antes de cadastrar usuários.
- Regras e usuários do Santé foram aplicados por SQL **só para agilizar** (confirmado em
  15/11/2026): as telas de Configurações cobrem esses campos, então no próximo laboratório dá para
  fazer tudo por elas. O único item que ainda só entra por SQL são os **sinônimos do catálogo**,
  porque o CSV de importação não tem coluna para eles.
- Registrar a virada **neste formato** no mesmo dia, em vez de reconstruir depois.
