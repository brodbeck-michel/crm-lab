# Migração do Laboratório Santé

Passo a passo das cargas de dados do Santé para o CRM Lab. Cada seção é uma carga
independente; rode sempre **primeiro em homologação e com `--dry-run`**, confira a paridade e
só depois grave. **Produção só com confirmação explícita do Michel.**

> Referências: spec da fusão (`docs/superpowers/specs/2026-09-08-fusao-crm-fluxolab-design.md`,
> Onda 11), `docs/database/SCHEMA.md` §24/§27, `docs/guides/ENVIRONMENTS.md` (qual diretório é
> qual ambiente). O que **já foi executado** (datas, cargas, incidentes, treinamento, virada em
> 22/10/2026) está em [`IMPLANTACAO_SANTE.md`](IMPLANTACAO_SANTE.md). Slug do tenant em prod: **`lab-sante`**.

---

## 1. Vendas (`public.vendas`) dos dois Supabases — CRMLAB-45

As vendas avulsas (exames e check-ups) existem em **dois** projetos Supabase: o do **FluxoLab**
(Vercel) e o do **app original** (Lovable). Parte delas está nas duas bases. O script
`import:sales-supabase` junta as duas e grava em `sales` do tenant do Santé.

Regras (detalhe em `docs/DECISIONS.md` **D-179** e **D-180**):

- União **por `id`** (o UUID da venda é preservado). Mesmo `id` com conteúdo diferente →
  vence o `updated_at` mais recente (empate → FluxoLab) e o `id` aparece em **conflitos**.
- `atendente` (texto) → atendente do tenant casado por nome **sem acento/caixa/espaços extras**;
  se não existir, é **criado**.
- `tipo`: `exames` → `exams`, `checkup` → `checkup`.
- `valor <= 0`, UUID/data/número inválido → **rejeitada com motivo** (nunca some em silêncio).
- `created_by` só é mantido se houver usuário do Santé com o mesmo `id`; senão fica vazio.
- `created_at`/`updated_at` preservados (gravados em UTC).
- **Idempotente:** rodar de novo com os mesmos CSVs não insere nem altera nada. Venda já gravada
  só é regravada se o `updated_at` da origem for mais novo que o gravado.
- **Nada é escrito nos Supabases** — o script só lê os CSVs.

### 1.1 Exportar `public.vendas` de cada projeto

Repita para **cada** projeto (FluxoLab e app original):

1. Painel do Supabase → selecione o projeto → **Table Editor** → schema `public` → tabela
   `vendas`.
2. Garanta que nenhum filtro está aplicado e que a visão mostra **todas** as linhas.
3. Botão **Export** (ou menu "…" da tabela) → **Export to CSV**. Alternativa equivalente:
   **SQL Editor** → `select * from public.vendas;` → **Download CSV**.
4. Salve com nome que diga a origem: `vendas-fluxolab.csv` e `vendas-lovable.csv`.

O CSV precisa ter cabeçalho com estas colunas (ordem livre; BOM aceito):

| Coluna | Obrigatória | Vira |
|---|---|---|
| `id` | sim (UUID) | `sales.id` |
| `atendente` | sim (até 255 caracteres) | `sales.attendant_id` (por nome) |
| `data_venda` | sim (`AAAA-MM-DD`) | `sales.sold_on` |
| `valor` | sim (> 0, até 2 casas, ponto decimal) | `sales.value` |
| `tipo` | sim (`exames` \| `checkup`) | `sales.kind` (`exams` \| `checkup`) |
| `created_at`, `updated_at` | sim | preservados |
| `codigo` | não (até 50 caracteres) | `sales.code` |
| `exames` | não | `sales.exams` |
| `created_by` | não (UUID) | `sales.created_by` |

Os CSVs contêm dados de pacientes/vendas: **não** commite, **não** mande por chat; copie direto
para a VPS e apague depois da carga.

### 1.2 Copiar para a VPS

```bash
# da sua máquina (alias do ~/.ssh/config)
ssh crm-vps 'mkdir -p /opt/crm-lab-homolog/import'
scp vendas-fluxolab.csv vendas-lovable.csv crm-vps:/opt/crm-lab-homolog/import/
```

### 1.3 Ensaio em homologação (`--dry-run`)

`--dry-run` executa a carga inteira e **desfaz no fim**: o relatório (inclusive atendentes que
seriam criados e a paridade) é o mesmo da gravação real, mas nada fica gravado.

```bash
cd /opt/crm-lab-homolog
docker compose -p crm-lab-homolog -f docker-compose.prod.yml run --rm --no-deps \
  -v /opt/crm-lab-homolog/import:/import:ro \
  backend node dist/backend/src/db/cli/import-sales-supabase.js \
    --tenant lab-sante \
    --fluxolab /import/vendas-fluxolab.csv \
    --lovable  /import/vendas-lovable.csv \
    --dry-run
```

`--tenant` aceita o **slug** ou o **UUID** do tenant; tenant inexistente → o script recusa e
sai com erro sem tocar em nada.

Em ambiente de desenvolvimento, o mesmo comando é
`npm run import:sales-supabase -- --tenant <slug> --fluxolab <csv> --lovable <csv> --dry-run`
(exige `DATABASE_URL` apontando para o Postgres — sem ela o backend usa PGlite em memória, o
tenant não existe e o script recusa).

Leia o relatório:

- **Lidas** por base, **em comum**, **só em uma** — confira com a contagem de linhas de cada
  CSV.
- **Conflitos** — cada `id` com as duas versões; confira se a versão vencedora faz sentido.
- **Atendentes criados** — nome novo aqui costuma ser erro de digitação na origem; se for,
  cadastre/renomeie o atendente em `/attendants` **antes** e rode o ensaio de novo.
- **Rejeitadas** — cada uma com o motivo. Corrija na origem ou aceite a perda **por escrito**.
- **Paridade** — contagem e soma (ao centavo) nas 3 janelas (mês anterior, mês corrente,
  tudo) e por atendente: **origem** (união das linhas aceitas) × **gravado** no tenant.
  Divergência esperada só se o tenant já tiver vendas lançadas direto no CRM.

Para guardar o relatório em JSON, acrescente `--report /import/relatorio.json` e monte o
diretório **sem** `:ro` (o usuário do container precisa poder escrever nele).

### 1.4 Gravar em homologação

Mesmo comando **sem** `--dry-run`. Depois:

- Rode **de novo** o mesmo comando: o relatório tem que mostrar `inseridas 0`,
  `atualizadas 0` (tudo **inalterado**). Se não mostrar, pare e investigue.
- Abra `/sales` e `/results` em `https://homolog.vitrocrm.cloud` no tenant do Santé e confira
  os totais do mês com a paridade.

### 1.5 Produção

**Só com confirmação do Michel**, com os CSVs **finais** exportados na hora:

1. Backup antes: `./scripts/backup-postgres.sh` em `/opt/crm-lab`.
2. Copie os CSVs para `/opt/crm-lab/import/`.
3. Mesmo comando da §1.3 trocando `crm-lab-homolog` por `crm-lab-prod` e o diretório por
   `/opt/crm-lab` — **primeiro com `--dry-run`**, conferir, depois sem.
4. Reexecute para provar a idempotência e confira `/sales` em `https://vitrocrm.cloud`.
5. Apague os CSVs da VPS: `rm -r /opt/crm-lab/import /opt/crm-lab-homolog/import`.

---

## 2. Ligar a integração só para a gestão (sem Propostas) — CRMLAB-76

Use quando a gestora for usar Resultados e Busca Ativa antes de as atendentes começarem no
funil (D-246).

1. **Regras → Origem das propostas:** desligue **"Nascer do orçamento do Bitlab"** e deixe
   **"Criar proposta manualmente no CRM"** ligada. Salve.
2. **Configurações → Integração LIS:** informe a chave e ligue a sincronia.
3. Depois de 1 ou 2 ciclos (1–2 min), confira:
   - Resultados e Busca Ativa com dados do LIS;
   - Propostas sem cartão novo;
   - resumo da última sincronia com **0 propostas criadas**.
4. **Quando as atendentes forem começar:** religue "Nascer do orçamento do Bitlab". Só entram
   orçamentos emitidos a partir desse dia. Se a regra já tiver rodado ligada antes nesse
   tenant, confira `tenant_settings.bitlab_proposals_since` e ajuste a data antes de religar.

---

## 3. Regras respondidas pela gestora — virada de outubro/2026

Fonte: Google Doc "CRM Lab — Funcionalidades e Regras do Lab Santé", respondido pela gestora
até 09/10/2026. Aplicado em **produção** (`lab-sante`) em 09/10/2026, com backup antes, em
transação SQL e com audit log (`user_agent = 'script: regras do Santé (doc da gestora, 09/10/2026)'`).
Prod ainda sem uso; a virada é na semana de 12/10.

### 3.1 Respostas e o que ficou configurado

| # | Pergunta | Resposta da gestora | No CRM (prod) |
|---|---|---|---|
| 1.1 / 1.3 | Orçamento do Bitlab vira cartão; a partir de quando | Sim; dia da virada | **Desligado até a virada** (§2 item 4). `bitlab_proposals_since` está NULL: a data grava sozinha no 1º ciclo |
| 1.2 | Criar orçamento no CRM | Sim | Ligado (já estava) |
| 2.1 / 2.2 | Requisição → Negociação; pagamento → Ganho | Sim | Ligados (padrão) |
| 2.3 / 2.4 | Enviado → Follow-up; Negociação → Follow-up | 3 / 7 dias | Padrão |
| 2.5 | Follow-up → Perdido sozinho | Sim, 15 dias | **Ligado, 15 dias** |
| 2.6 | Alerta de orçamento novo parado | **15 min** | **1 hora**: a regra só aceita horas (1..720). Ver §3.2 |
| 2.7 | Contagem dos prazos | Corridos | Padrão |
| 3.1 | Reabrir Ganho/Perdido | Todas | **Ligado para atendente e gestora** (admin sempre pode) |
| 3.2 / 3.3 / 3.5 | Pular etapas; motivo obrigatório; gestora move card alheio | Sim | Padrão |
| 3.4 | Motivo de perda novo | "Horário de atendimento" | Enum fixo. Ver §3.2 |
| 4.1 | Mensagem do orçamento | Duas: "a prazo" e "AV" | Modelo "a prazo" com `{valor}`, `{numero_orcamento}` e `___` no prazo e nas parcelas; a atendente completa no painel de envio (a mensagem é editável). Ver §3.2 |
| 4.2 | 1º lembrete | Sim, 5 h, texto dela | **Ligado, 5 h, texto dela**, sem o "(nome)": o reingajamento não aceita variáveis. Ver §3.2 |
| 4.3 | 2º lembrete | Não | Desligado |
| 5.1 | Horário | Seg–sex 7h–17h30; sáb/dom fechado | **Gravado** em `business_hours`. O texto dela virou a **mensagem fora do horário** (ligada), mas hoje nada envia essa mensagem. Ver §3.2 |
| 5.2 | Feriados municipais | Nenhum além dos nacionais | Só os nacionais (automáticos) |
| 5.3 | Conversa em vermelho | 15 min | **Ligado, 15 min** |
| 6.1 | Alçada da atendente | **20%** | **20%** nas 8 atendentes ativas |
| 6.2 | Alçada da gestora | 30% | Não há usuária `manager`; a gestora é admin |
| 6.3 / 6.4 | Comissão exames / check-up | **2%** / 1,5% | 2,00 / 1,50 |
| 7.1 / 7.2 / 7.3 | Número; quem lê o QR; QR ou API Meta | Informados no doc; **QR Code** | Conectar no dia |
| 8.1 / 8.2 | Vendas só no CRM; conferência | Dia da virada; gestora | Carga final na véspera (D0) |
| 10.1 / 10.2 | Visitação médica | Não usa; não definido | Nada a fazer |
| Usuários | Tabela | Nomes e perfis | Os 9 já existem em prod, com o vínculo de atendente do Bitlab feito |

### 3.2 O que dependeu de desenvolvimento

1. Alerta de orçamento parado em **minutos** (2.6).
2. Motivo de perda **"Horário de atendimento"** (3.4).
3. **Duas mensagens de orçamento** ("a prazo" e "à vista") com prazo de entrega e parcelas (4.1).
4. **Nome do paciente** no lembrete (4.2).
5. **Envio da mensagem fora do horário** (5.1): configurável em Configurações → Canais desde a
   migração 003, mas nenhum serviço a envia.

### 3.3 Checklist do dia da virada

1. Última carga das vendas do app antigo (§1) e conferência com a gestora.
2. Regras → ligar **"Nascer do orçamento do Bitlab"** (§2 item 4).
3. Conectar o WhatsApp pelo QR Code com quem estiver com o celular (doc, 7.2).
4. Conferir em Regras e Canais o que os cards da §3.2 trouxeram (unidade do alerta, as duas
   mensagens, o nome no lembrete) e ajustar ao que a gestora pediu.

---

## 4. WhatsApp: do QR (Evolution) para a API oficial da Meta — CRMLAB-142

Número do Santé: **55 48 9188-9030**. Hoje em `qr` (Evolution). Destino: `cloud_api` (D-308..D-314),
**sem apagar nada do CRM** — trocar de modo não toca em mensagem nenhuma (D-308), e a volta para o
QR existe. A escolha entre **coexistência** e **migração completa** (4.2) fica registrada no dia de
executar; os dois caminhos estão aqui.

> Itens marcados **(conferir na Meta)** dependem de regra da Meta que muda com frequência: confirmar
> na documentação oficial e no Gerenciador do WhatsApp no dia, antes de executar.

### 4.0 Alinhamento com as gestoras — reunião de 06/11/2026

Depois da restrição de 04/11/2026 (uso de API não oficial, Evolution), ficou alinhado em reunião
com as gestoras do Santé em **06/11/2026**:

- o Santé **contrata a API oficial do WhatsApp Business direto com a Meta**, em nome do
  laboratório (conta empresarial, número e cartão do lab);
- o **CRM Lab** segue como sistema de atendimento, ligado a essa API, com mensalidade de
  **R$ 450,00** (antes R$ 150,00), **sem taxa de implantação**; o custo por mensagem da Meta é à
  parte, pago pelo lab direto à Meta;
- aprovada a proposta pela direção, **duas semanas de testes/POC**; a mensalidade nova é cobrada
  a partir de **25/11/2026**;
- enquanto isso, o CRM é preparado para a API oficial (CRMLAB-135..142).

Documentos entregues em 06/11/2026: proposta comercial para a direção
(https://claude.ai/artifact/Jb9ATmZJj7jtpwwtXBuvCF) e passo a passo de contratação da API da Meta
para as gestoras (https://claude.ai/artifact/JR4cHeWruKMyNQGd7igK8m).

### 4.1 Pré-requisitos (todos antes de marcar a data)

| # | Item | Como conferir |
|---|------|---------------|
| 1 | Restrição de 04/11/2026 encerrada e número estável há alguns dias | Celular sem aviso de restrição; nenhum alerta de sessão no Telegram |
| 2 | Conta empresarial (Business Manager) do Santé **verificada** — **é o item que trava tudo**: sem ela a Meta aceita o envio (devolve `wamid`) e depois marca `failed` **131031**, **inclusive resposta dentro das 24 h**. O número recebe, mas não responde. Leva de dias a ~2 semanas e pede documentos do CNPJ: **começar por ele** (ensaio de 10/11, 4.3.1) | `GET /{waba_id}?fields=business_verification_status` = `verified` (a fonte que vale). **Cuidado:** "Verificação bem-sucedida" em Autorizações e verificações › *verificação individual ou de organização* é a de **anunciante** e **não** libera o WhatsApp (12/11/2026). A certa fica em Central de Segurança › card **"Verificação da empresa"** › Iniciar verificação (ver 4.3.2). ✅ **Verificada em 12/11/2026** (aprovada no mesmo dia; `health_status` BUSINESS e APP `AVAILABLE`) |
| 2a | **Informações da empresa completas**: nome legal (razão social), endereço com país **Brasil** e **site**. Faltando, a Meta recusa o envio com **131000** | Configurações do negócio › Informações da empresa |
| 3 | Conta do WhatsApp Business (WABA) criada e **forma de pagamento** no Billing Hub: moeda **BRL** (não muda depois), **CNPJ** do lab, "fins comerciais" = **Sim**, cartão do lab. Sem ela: **141006**. A Meta pode segurar uma pré-autorização no cartão por até 24 h | Configurações › **Contas de mensagens** › a conta › Summary: endereço, **moeda BRL**, fuso **America/Sao_Paulo** (vem America/Los_Angeles) e forma de pagamento. É isso que gera o aviso "WhatsApp needs more information" em Informações da empresa. **Decisão de 13/11/2026: a "Test Messaging Account" (`3732004406965190`) vira a conta de produção** — o "Criar conta do WhatsApp" do Business Manager exige número e verificação, então não dá para criar uma WABA vazia antes da virada. Já feito em 13/11: nome **Laboratório Santé**, fuso **America/Sao_Paulo**, moeda **BRL** (conferido pela API) e, em Cobrança e pagamentos › Informações da empresa, Brasil/BRL, CNPJ e "fins comerciais" = Sim (a Meta puxou razão social e endereço do CNPJ). **Falta só o cartão** (Milena: Configurações de pagamento › Adicionar forma de pagamento). Nome do portfólio "Laboratório Sante" (sem acento): **não mexer**, está verificado |
| 4 | **Nome de exibição** do número aprovado **(conferir na Meta)**. Ele é pedido **quando o número real é adicionado** — na migração completa isso só acontece no dia (4.4 passo 4), então não dá para adiantar | Gerenciador do WhatsApp › Números de telefone |
| 5 | **Modelos aprovados**: os três de 4.1.1 (`retomar_atendimento`, `retorno_orcamento`, `lembrete_coleta`), todos UTILITY | Gerenciador do WhatsApp › Modelos (status "Aprovado"); no CRM, aparecem no "Enviar modelo" em até 5 min. **Modelo pertence à WABA**: os criados em 12/11/2026 estão na WABA **de teste** ("Test Messaging Account"); como essa WABA vira a de produção (item 3), **não precisa recriar**. Em 13/11 seguiam **PENDING** (talvez esperando a forma de pagamento) |
| 6 | App na Meta com o produto WhatsApp e **usuário do sistema** com token **que nunca expira** (`whatsapp_business_messaging` e `whatsapp_business_management`) | Business Manager › Usuários do sistema |
| 7 | **App inscrito na WABA do Santé** (`POST /{waba_id}/subscribed_apps`) — sem isso a Meta não entrega nada ao CRM. No ensaio de 10/11 a WABA de teste **não** veio inscrita (só tinha o app da própria Meta) e foi preciso fazer o `POST` — no Santé, conferir sempre | `GET /{waba_id}/subscribed_apps` lista o app do CRM |
| 7a | Campo **messages** assinado no webhook do app (Painel do app › WhatsApp › Configuração) | Aparece "Assinado" na linha *messages* |
| 8 | **PIN de duas etapas** do número definido e guardado no cofre (é pedido para registrar e para voltar) | Anotado fora do celular |
| 9 | Limite de conversas iniciadas pela empresa para número novo conhecido (afeta o lembrete de coleta) **(conferir na Meta)** | Gerenciador do WhatsApp › Insights/limites |
| 10 | Produção numa versão com CRMLAB-135..141 e 140 (anexos, ffmpeg na imagem) **e com o CRMLAB-147** (recado de voz do CRM não tocava no iPhone — 4.3.2). Sem o 147, **não virar** | Versão no rodapé da barra lateral do CRM e a tag da imagem em execução (`docker inspect`; o `IMAGE_TAG` do `.env` de prod pode estar velho); `docker exec <backend> ffmpeg -version` |
| 11 | `.env` de **prod** com `WHATSAPP_API_URL=https://graph.facebook.com/v<versão>`, `WHATSAPP_WEBHOOK_SECRET=<App Secret>`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN=<valor aleatório>`. **Nunca** `WHATSAPP_CLOUD_API_MOCK` em prod | ✅ **Aplicado em 12/11/2026** (4.3.2). Conferir: `docker exec <backend> sh -c 'echo $WHATSAPP_API_URL'` |
| 12 | **Segredo do webhook do Santé** na tela de Canais: o código usa o segredo do laboratório quando existe (e `''` = revogado, D-073) e só cai no `WHATSAPP_WEBHOOK_SECRET` quando a tela diz "Não configurado". Deixar "Não configurado" **ou** gravar o App Secret ali | Configurações › Canais › WhatsApp › "Segredo do webhook" |
| 13 | Ensaio completo feito e anotado — ✅ **feito em PRODUÇÃO no tenant `teste` em 12/11/2026** (4.3.2), no lugar da hml. Faltam só modelo, CSV e painel de custo | Este guia, 4.3.2 |
| 14 | Quem está com o celular do número (Thaisy ou Tainá) avisada da janela | — |
| 15 | **Conversas do celular exportadas** (as que importam, principalmente as de depois de 04/11/2026, que não estão no CRM): ⋮ › Mais › Exportar conversa › Incluir mídia › e-mail do lab. Na migração completa elas **somem do celular** | Gestora confirma por escrito |
| 16 | **Sinal verde da Meta (go/no-go)**: `GET /{waba_id}?fields=health_status` com `can_send_message` = `AVAILABLE` para o negócio, a WABA e o app (depois de adicionar o número, também para o número). `LIMITED`/`BLOCKED` = **não apagar a conta do celular** | Michel consulta com o token permanente na véspera e de novo no dia, antes do passo 4 da 4.4 |

### 4.1.1 Modelos para submeter à Meta (definidos em 07/11/2026)

O CRM não guarda modelos: lê os aprovados da WABA do laboratório (CRMLAB-136, D-309). Por isso o
cadastro é feito pelas gestoras no **Gerenciador do WhatsApp › Modelos de mensagem › Criar modelo**,
com estas regras (senão o CRM não lista o modelo):

- **Categoria:** Utilidade · **Idioma:** Português (BR) · nome exatamente como abaixo.
- **Só o "Corpo"**: sem cabeçalho, rodapé nem botões (o CRM aceita um único `BODY` de texto).
- Variáveis posicionais `{{1}}..{{n}}` com os exemplos indicados (a Meta exige amostra).
- Não mexer no texto para "fugir" de Marketing: nenhuma variável no início/fim nem colada em outra,
  sem oferta ou desconto — é o que mantém a aprovação como Utilidade.

| Nome | Uso | Corpo | Exemplos |
|------|-----|-------|----------|
| `retomar_atendimento` | Paciente parou de responder e a janela de 24 h fechou | Olá, {{1}}! Aqui é do Laboratório Santé. Estamos dando continuidade ao seu atendimento. Você pode responder a esta mensagem para seguirmos de onde paramos. | {{1}} = Maria |
| `retorno_orcamento` | Primeiro contato depois de um orçamento pedido pelo paciente | Olá, {{1}}! Aqui é do Laboratório Santé. Estamos entrando em contato sobre o orçamento nº {{2}} que você solicitou. Para receber os detalhes ou tirar dúvidas sobre os exames, é só responder a esta mensagem. | {{1}} = Maria · {{2}} = 48213 |
| `lembrete_coleta` | Lembrete de coleta agendada | Olá, {{1}}! Aqui é do Laboratório Santé. Lembramos que a sua coleta está agendada para {{2}}, às {{3}}. Caso precise remarcar ou tenha dúvidas sobre o preparo, responda a esta mensagem. | {{1}} = Maria · {{2}} = 12/11/2026 · {{3}} = 07:30 |

- `retorno_orcamento` é o único com risco de a Meta **reclassificar como Marketing** (hoje ela
  reclassifica em vez de recusar). Funciona igual, só fica mais caro por envio; o CRMLAB-141 já
  registra a categoria que a Meta devolve.
- Aprovação: de minutos a 24 h. Recusado → ler o motivo no Gerenciador e trazer para ajuste aqui.
- Página entregue às gestoras em 07/11/2026: https://claude.ai/artifact/JfoVmjq1pbs6HHW1TfrhLV

### 4.2 Coexistência × migração completa

| | Coexistência | Migração completa |
|---|---|---|
| O que é | O número continua no **app WhatsApp Business** do celular **e** passa a falar pela API oficial; mensagens sincronizadas **(conferir na Meta)** | O número sai do app e fica **só** na API oficial |
| Exige | Número no app **WhatsApp Business** (não o WhatsApp comum); cadastro pelo *Embedded Signup* de um parceiro/Tech Provider **(conferir na Meta)** | Apagar a conta do WhatsApp no celular antes de registrar o número na API **(conferir na Meta)** |
| Celular | Continua útil (ver e responder pelo app); precisa abrir o app periodicamente **(conferir na Meta)** | Não serve mais para esse número |
| Aparelho conectado (WhatsApp Web, que é como o Evolution funciona) | Conferir se a coexistência mantém aparelhos conectados **(conferir na Meta)** — decide se a volta para o QR é possível sem sair da coexistência | Não se aplica |
| Limites | Vazão menor que a API pura e recursos do app que deixam de funcionar (listas de transmissão, por exemplo) **(conferir na Meta)** | Nenhum além dos da API |
| Histórico no celular | Fica | **Some do celular** (no CRM fica tudo) |
| Voltar para o QR | Rápido, **tirando o callback** da Meta (4.6) | Lento: tirar o número da API e registrar de novo no app, com nova verificação — horas **(conferir na Meta)** |
| Risco | Configuração depende de parceiro | Sem volta rápida |

**Recomendação para decidir no dia:** se o número já está no app WhatsApp Business e houver
parceiro para o *Embedded Signup*, coexistência dá volta rápida e mantém o celular. Sem isso,
migração completa. Registrar a escolha em DECISIONS (D-NNN) antes de executar.

### 4.3 Ensaio em homologação (antes de qualquer coisa em prod)

Usa o **número de teste** que a Meta dá no app (não o do Santé) e o tenant `Laboratorio Teste`. O
número de teste só manda para destinatários cadastrados no app (poucos) e, em geral, só com o modelo
`hello_world` **(conferir na Meta)**: cadastrar antes os celulares da equipe que vão testar.

1. Anotar como a hml está hoje (para o passo 5): `.env` (`WHATSAPP_API_URL`, `WHATSAPP_CLOUD_API_MOCK`)
   e, no Laboratorio Teste, ID do número, WABA, token, segredo do webhook e modo.
2. `.env` da hml: **preencher `WHATSAPP_API_URL`** (é ela que liga a Meta — com ela preenchida,
   `WHATSAPP_CLOUD_API_MOCK` não tem efeito), `WHATSAPP_WEBHOOK_SECRET` (App Secret),
   `WHATSAPP_WEBHOOK_VERIFY_TOKEN`. Deploy pelo `deploy.sh` da hml e `ffmpeg -version` no container.
3. Painel do app Meta › WhatsApp › Configuração: callback
   `https://<domínio-hml>/api/v1/webhooks/whatsapp/<slug-do-teste>`, token = `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
   (a Meta faz o `GET` e precisa receber 200), assinar o campo **messages**.
4. CRM hml › Configurações › Canais › WhatsApp: ID do número de teste, WABA, token do usuário do
   sistema e "Segredo do webhook" = App Secret (ou "Não configurado"); depois **"Trocar para API
   oficial"** no cartão "Modo do WhatsApp".
5. Roteiro (anotar o resultado de cada um):
   - do celular de teste, mandar "oi" → chega no CRM, conversa aberta, janela de 24 h aberta;
   - responder texto → chega; tiques enviado/entregue/lido mudam;
   - mandar do celular foto, PDF, **recado de voz** e **figurinha** → aparecem como anexo, sem
     `whatsapp.inbound_media_fallback` no log;
   - enviar foto, PDF e **recado de voz** pelo CRM → chegam (o recado como áudio; conferir se aparece
     como recado de voz ou como arquivo de áudio **(conferir na Meta)**);
   - enviar CSV pelo CRM → recusado com o aviso de formato;
   - conversa sem fala do paciente → texto livre bloqueado, **modelo** sai;
   - Configurações › Canais › "Uso e custo do WhatsApp (API oficial)" mostra as mensagens do dia.
6. **Voltar a hml como estava** (o treinamento usa o mock e o `~/treino-mensagem.sh` manda webhook
   no formato plano, que só é aceito no mock): **esvaziar `WHATSAPP_API_URL`**, voltar
   `WHATSAPP_CLOUD_API_MOCK=true`, deploy; restaurar no Laboratorio Teste o que foi anotado no passo 1;
   **tirar o callback da hml do app Meta** (senão os avisos de prod irão para a hml no dia da troca).

### 4.3.1 Resultado do ensaio de 10/11/2026

App Meta de teste do Michel ("CRM teste lab"), número de teste da Meta (+1 555…), tenant
`Laboratorio Teste` (slug **`teste`**), token temporário de 24 h.

| Item | Resultado |
|------|-----------|
| Verificação do callback (`GET hub.challenge`) | ✅ 200 |
| Assinatura HMAC com o App Secret | ✅ aceita |
| Mensagem do celular → conversa no CRM (`whatsapp.webhook_processed messages:1`) | ✅ |
| Envio pelo CRM → Meta aceita (`wamid`) | ✅ |
| Status `failed` aparece na conversa com "Tentar de novo" | ✅ |
| **Entrega no celular, tiques, anexos (ida e volta), modelo, painel de custo** | ⛔ **não validado** — a Meta devolveu **131031** até em envio direto pela API, sem o CRM: empresa de teste sem verificação (pessoa física, sem CNPJ). Fica para o teste do passo 7 da 4.4 |

Bloqueios da Meta encontrados, na ordem em que apareceram (todos são do **lado da conta**, nenhum do CRM):
app não inscrito na WABA → `POST subscribed_apps`; **131000** perfil sem nome legal/país/site →
preenchido; **141006** sem pagamento → cartão cadastrado; **141010/131031** empresa não verificada →
sem solução no teste. Viraram os itens 2, 2a, 3, 7 e 16 da 4.1.

Lições de operação (para o próximo ensaio na hml):
- A hml fica atrás da **porta de cookie do Caddy** (ENVIRONMENTS §5): a Meta toma 403. Precisa de uma
  exceção temporária só para `/api/v1/webhooks/whatsapp/*` em `/etc/caddy/homolog.caddyfile` (backup antes,
  `caddy validate`, reload) — e tirar depois.
- O GET de verificação só passa com o canal **ligado** (`channel_disabled`) e o slug certo
  (`unknown_tenant`). Não exige o modo `cloud_api`, então o callback de prod pode ser cadastrado com o
  Santé ainda em QR.
- Recriar só o backend exige `restart` do frontend (o nginx guarda o IP antigo).
- O `IMAGE_TAG` do `.env` da hml (e o de prod) pode estar velho: exportar a tag em execução ao usar compose na mão.
- Segredos (token, App Secret) passam só por arquivo `chmod 600` (`read -rsp`), nunca pelo chat.
- A Meta normaliza celular antigo sem o nono dígito (`5548988…` → `wa_id 554888…`). O contato
  que já existe no CRM desde a época do QR precisa cair **na mesma conversa**. Conferir no passo 7 da 4.4.
- Situação de envio da conta, sem mandar mensagem: `GET /{waba_id}?fields=health_status`.

### 4.3.2 Ensaio em PRODUÇÃO no portfólio do Santé — 12/11/2026 ✅

Desta vez com o **portfólio real do Santé** ("Laboratório Sante", ID 1784519782770617), num app novo e
**em produção**, no tenant **`teste`** (o Santé seguiu em `qr`, sem ser tocado). O passo a passo para
repetir está na skill `.claude/skills/cloud-api-meta/SKILL.md`.

**O que ficou montado (e serve para a troca do Santé):**

| Peça | Valor |
|------|-------|
| App Meta | **CRM Lab - Santé**, ID `40949966027927681`, no portfólio do Santé, não publicado (não precisa) |
| Usuário do sistema | **CRMLabSante** (Admin), token **sem expiração**, só `whatsapp_business_messaging` + `whatsapp_business_management`; ativos: o app + a WABA + a conta de mensagens vinculada, todos com acesso total |
| WABA de teste | "Test Messaging Account", ID `3732004406965190` (o ID que o painel chama de "conta de mensagens" serve como `waba_id`) |
| Número de teste | +1 555 151-8021, `phone_number_id` `1508225332363199` (manda para até 5 celulares cadastrados no app) |
| App inscrito na WABA | ✅ `POST /3732004406965190/subscribed_apps` |
| Webhook do app | ✅ cadastrado pela API: `POST /40949966027927681/subscriptions` (token do app `APP_ID\|APP_SECRET`), callback `https://vitrocrm.cloud/api/v1/webhooks/whatsapp/teste`, campo `messages` |
| `.env` de prod | ✅ `WHATSAPP_API_URL=https://graph.facebook.com/v25.0`, `WHATSAPP_WEBHOOK_SECRET` = App Secret, `WHATSAPP_WEBHOOK_VERIFY_TOKEN` gerado. Backup antes: `/home/deploy/crm-lab-env-backups/prod.env.bak-20261112-181020-pre-cloud-api-teste` |
| Segredos | só na máquina do Michel, `~/.config/crm-lab-meta-sante/{token,app_secret,verify_token}` (600) |
| Modelos | os 3 da 4.1.1 submetidos na WABA de teste (Utilidade, pt_BR) — em análise no fim do dia |

**Resultado (celular iPhone do Michel ↔ CRM prod, tenant `teste`):**

| Teste | Resultado |
|-------|-----------|
| Verificação do callback pela Meta | ✅ |
| "oi" do celular → CRM | ✅ `whatsapp.webhook_processed`, caiu na **conversa que já existia** (nono dígito ok: a Meta manda `wa_id 554888…`, casou com `5548988…`) |
| Resposta de texto pelo CRM → celular | ✅ entregue, tiques até **lido**; o "sent" atrasado depois do "read" é ignorado (`whatsapp.status_ignored`) |
| Foto, PDF e recado de voz do celular → CRM | ✅ anexos baixados da Meta, sem `inbound_media_fallback` |
| Foto e PDF do CRM → celular | ✅ (cobrança `service`, dentro das 24 h) |
| **Recado de voz do CRM → iPhone** | ⛔ chega, mas **não toca**. Causa isolada: o OGG do ffmpeg com ~49 pacotes por página. Com `-page_duration 20000` (1 pacote por página) + `voice: true`, toca. Correção: **CRMLAB-147** — pré-requisito da troca (4.1 item 10) |
| Modelo pelo CRM, CSV recusado, painel "Uso e custo" | ⏳ pendente (modelos ainda em análise) |

**Pegadinhas que custaram tempo (já estão na skill):**
- **A verificação de anunciante não é a da empresa.** "Verificação bem-sucedida" em Autorizações e
  verificações enganou; a API dizia `business_verification_status: not_verified` e
  `health_status` BUSINESS `LIMITED 141010`. O número de **teste** entrega mesmo assim — entrega com o
  número de teste **não prova** nada sobre a verificação.
- **Conversa `direct` engole a mensagem do WhatsApp.** A conversa do Michel no `teste` era `direct`
  (16/09); a mensagem da Meta entrou nela e a resposta ficou `sent` sem `wamid` (não sai para canal
  `direct`). Corrigido à mão só nessa conversa (`channel` → `whatsapp`). Card **CRMLAB-148**. O Santé não
  tem conversa `direct` (428, todas `whatsapp`).
- **Tela de Canais tem dois blocos que salvam separado:** "Trocar para API oficial" grava modo + número +
  WABA + token; o bloco de cima (nome, número exibido, **Canal ativo**) só grava no **Salvar** dele. O
  canal do `teste` estava desativado e o GET de verificação só passa com ele ativo.
- **Nome do usuário do sistema** não aceita hífen (`crm-lab` foi recusado; `CRMLabSante` passou).
- **Segredo pelo `!` do Claude Code:** `read -rsp` não funciona (sem terminal). O que funcionou:
  `powershell.exe -NoProfile -Command Get-Clipboard | tr -d '\r\n ' > arquivo` (copiar o valor **depois**
  de copiar o comando) e, para devolver ao navegador, `clip.exe < arquivo`.
- **Aplicar `.env` sem trocar versão:** `origin/main` estava num commit só de docs, sem tag, e o
  `deploy.sh` de prod exige tag. Foi recriado só o backend com a mesma imagem
  (`IMAGE_TAG=3a8ff5b docker compose -p crm-lab-prod -f docker-compose.prod.yml up -d --no-deps backend` +
  `restart frontend`). Exceção pontual: o caminho normal continua sendo o `deploy.sh` (na próxima versão
  ele já sobe com essas envs, que ficam no `.env`).
- **Um callback por app:** hoje o app aponta para `/teste`. No dia da troca, trocar para `/lab-sante`
  (mesmo `POST /{app_id}/subscriptions`) — ou callback por WABA (DEPLOYMENT, "mais de um laboratório").

### 4.4.0 Véspera e kit do dia

**Véspera (D-1), com o Santé ainda em QR. Nada aqui muda o atendimento:**
1. Pré-requisitos da 4.1 todos ✅, inclusive o 16 (`health_status`) com o token permanente.
2. **Token permanente** gerado com a gestora em chamada: Business Manager › Usuários do sistema ›
   criar (Admin) › atribuir o **app** e a **WABA do Santé** (controle total) › Gerar token › app do CRM ›
   validade **Nunca** › `whatsapp_business_messaging` + `whatsapp_business_management`. Guardar em
   arquivo `600` na máquina do Michel; conferir com `GET /{waba_id}` (200).
3. Anotar os IDs: **WABA id**, **App id**, **App Secret** (arquivo `600`) e o slug do Santé em prod.
4. `.env` de prod (4.1 item 11) aplicado com deploy (perguntar antes, com versão/tag), e conferir
   `ffmpeg -version` no backend.
5. Callback de prod no app Meta (4.4 passo 3) já cadastrado e **verificado** (a Meta precisa receber 200).
   Pode ficar na véspera: sem número na API, nada chega.
6. Backup do Postgres de prod do dia confirmado.
7. Mensagem para a equipe com o horário da janela e o "como atender depois" (4.5).

**Kit na mão na hora:**

| O quê | Com quem |
|-------|----------|
| Celular com o **chip do 48 9188-9030** (recebe o SMS/ligação de verificação **depois** de apagar a conta) | Gestora |
| **PIN de 6 dígitos** (4.1 item 8) | Gestora |
| Login de **admin** do Business Manager e do Gerenciador do WhatsApp | Gestora |
| Token permanente, App Secret, verify token, WABA id, slug | Michel (arquivos `600`) |
| Terminal na VPS de prod (logs) e o CRM prod aberto em Configurações › Canais | Michel |
| Celular da equipe **que já tem conversa no CRM**, para o teste do passo 7 | Equipe |
| Confirmação de que as conversas importantes foram exportadas (4.1 item 15) | Gestora |
| Chamada de vídeo aberta entre Michel e a gestora durante toda a janela | — |

**Critério de parada:** se em qualquer ponto **antes** de apagar a conta do celular algo falhar
(health_status diferente de `AVAILABLE`, callback sem 200, número sem `phone_number_id`), **parar e
remarcar**. Até ali nada é irreversível.

### 4.4 Dia da troca em produção (fora do horário de atendimento)

Confirmação explícita do Michel antes de começar (produção). Anotar horário de cada passo.
**Princípio:** tudo que recebe (callback e cadastro no CRM) fica pronto **antes** de o número
começar a falar pela Meta — aviso que chega sem destino é descartado com 200 e a Meta não reentrega.

1. **Aviso** à equipe: atendimento pelo CRM parado por ~30 min; conversas em andamento seguem no CRM.
2. Conferir no CRM se há mensagens `failed` pendentes e reenviar **antes** (pelo QR).
3. **Callback de prod no app Meta** (antes de mexer no número): callback
   `https://vitrocrm.cloud/api/v1/webhooks/whatsapp/<slug-do-santé>`, verify token =
   `WHATSAPP_WEBHOOK_VERIFY_TOKEN` de prod, campo **messages** assinado. Conferir que **não** aponta
   para a hml. Com mais de um laboratório no mesmo app: callback por WABA (DEPLOYMENT).
3a. **Go/no-go:** `health_status` de novo (4.1 item 16). Diferente de `AVAILABLE` → parar aqui.
4. **Número na Meta e no CRM, nesta ordem:**
   - *migração completa*: no Gerenciador do WhatsApp, **adicionar o número** (isso já cria o
     `phone_number_id`) **(conferir na Meta)** → no CRM prod › Canais › WhatsApp gravar
     `phone_number_id`, WABA, token permanente e conferir o "Segredo do webhook" (4.1 item 12),
     **sem trocar o modo ainda** → no celular, WhatsApp › Configurações › Conta › Apagar conta → no
     Gerenciador, verificar o número por SMS/ligação e registrar com o PIN
     (`POST /{phone_number_id}/register`) **(conferir na Meta)**;
   - *coexistência*: fluxo do parceiro, lendo o QR do app WhatsApp Business **(conferir na Meta)**;
     **imediatamente** depois, gravar no CRM `phone_number_id`, WABA, token e conferir o segredo.
     Entre o fim do fluxo e o cadastro no CRM há uma janela curta em que aviso da Meta é descartado:
     fazer os dois em sequência, com a tela do CRM já aberta.
5. **Desligar o QR:** Configurações › Canais › WhatsApp › "Desconectar" (não desativa o canal).
   Sai **um** alerta "WhatsApp desconectado — Santé" no Telegram depois de 2 min: é esperado (o
   "restabelecido" não vem, porque o canal deixa de ser QR no passo 6).
6. **Trocar o modo por último:** cartão "Modo do WhatsApp" › **"Trocar para API oficial"** (confirmar
   o aviso).
7. **Teste com um celular da equipe** (não de paciente). É aqui que se valida o que o ensaio de 10/11 não
   conseguiu (4.3.1):
   - mandar "oi" → chega no CRM **na conversa que já existia** desse contato (não cria outra; nono dígito);
   - responder texto → chega no celular, tiques enviado → entregue → lido. `failed` **131031** = conta
     não liberada (voltar à 4.1 item 2);
   - mandar do celular foto, PDF e recado de voz → aparecem no CRM;
   - enviar foto e PDF pelo CRM → chegam;
   - enviar um **modelo** (`retomar_atendimento`) → chega;
   - "Uso e custo do WhatsApp (API oficial)" mostra as mensagens.
8. **Logs** por 15 min:
   - esperado: `whatsapp.webhook_processed`;
   - **não** pode aparecer em série: `whatsapp.webhook_invalid_signature` (segredo errado, 4.1 item
     12), `whatsapp.webhook_unknown_tenant` (slug errado no callback), `whatsapp.webhook_verify_refused`,
     `whatsapp.webhook_no_phone_number`, `whatsapp.webhook_phone_number_mismatch`,
     `whatsapp.inbound_media_fallback`, `whatsapp.retry_failed`, `whatsapp.media_upload_refused`.
9. Liberar a equipe. Lembrar: na API oficial **não há** reengajamento automático, saudação/fora do
   horário nem teto de primeiro contato (D-214, D-264, D-306 são só do QR); fora das 24 h, só modelo.

### 4.5 Depois da troca

- **Monitor de sessão (CRMLAB-99):** ele só vigia canal `qr`; na API oficial não há sessão para cair,
  então o alerta "WhatsApp desconectado" deixa de existir para o Santé — e **não há alerta nenhum
  para a API oficial** (token expirado, webhook parado). Até existir um monitor próprio (abrir card:
  ausência de `whatsapp.webhook_processed` por X horas no horário comercial, ou `failed` em série),
  conferir os logs no começo de cada dia útil da primeira semana.
- **Custo:** conferir no fim do mês "Uso e custo do WhatsApp" contra a fatura da Meta (é estimativa).
- **Instância do Evolution do Santé:** manter parada (não apagar) até decidir que não há volta.
- Atualizar a memória/STATUS com a data da troca e o caminho escolhido.
- Na primeira semana, mensagem `failed` em série com **131031/131000/141006** = problema na conta Meta
  (verificação, perfil, pagamento), não no CRM. Conferir `health_status` e o banner do Gerenciador.
- **Cartão do lab** sem limite ou vencido → a Meta para de cobrar e pode bloquear o envio. A gestora acompanha
  pelo Billing Hub.

### 4.6 Plano de volta para o QR

O histórico do CRM fica intacto nos dois sentidos (D-308). **Atenção:** o webhook da Meta não
olha o modo do canal — enquanto o callback existir e o número estiver na API, os avisos da Meta
continuam sendo gravados no CRM, mesmo com o canal em `qr`.

- **Coexistência:** **tirar o callback do app Meta é obrigatório** (ou tirar o número da
  coexistência **(conferir na Meta)**); sem isso, cada fala do paciente entra duas vezes (pelo
  Evolution e pela Meta). Depois, cartão "Modo do WhatsApp" › **"Voltar para QR"**; se a sessão do
  Evolution tiver caído, "Conectar WhatsApp" e ler o QR no celular — só se a coexistência permitir
  aparelho conectado (4.2). Minutos.
- **Migração completa:** tirar o número da API (`POST /{phone_number_id}/deregister` ou pelo
  Gerenciador, talvez removendo o número da WABA) **(conferir na Meta)**, reinstalar o WhatsApp no
  celular e verificar o número por SMS **(conferir na Meta)**; tirar o callback; então "Voltar para
  QR" e reparear. **Horas** — por isso a migração completa só depois do ensaio da 4.3 sem pendência.
- Nos dois casos: conferir mensagens `failed` e reenviar pelo QR.
