# Migração do Laboratório Santé

Passo a passo das cargas de dados do Santé para o CRM Lab. Cada seção é uma carga
independente; rode sempre **primeiro em homologação e com `--dry-run`**, confira a paridade e
só depois grave. **Produção só com confirmação explícita do Michel.**

> Referências: spec da fusão (`docs/superpowers/specs/2026-09-08-fusao-crm-fluxolab-design.md`,
> Onda 11), `docs/database/SCHEMA.md` §24/§27, `docs/guides/ENVIRONMENTS.md` (qual diretório é
> qual ambiente).

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
    --tenant sante \
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

### 4.1 Pré-requisitos (todos antes de marcar a data)

| # | Item | Como conferir |
|---|------|---------------|
| 1 | Restrição de 04/11/2026 encerrada e número estável há alguns dias | Celular sem aviso de restrição; nenhum alerta de sessão no Telegram |
| 2 | Conta empresarial (Business Manager) do Santé **verificada** | Central de Segurança do Business Manager |
| 3 | Conta do WhatsApp Business (WABA) criada e **forma de pagamento em BRL** no Billing Hub | Gerenciador do WhatsApp › Faturamento |
| 4 | **Modelos aprovados**: no mínimo um de retomada de atendimento e o lembrete de coleta (UTILITY) | Gerenciador do WhatsApp › Modelos (status "Aprovado") |
| 5 | App na Meta com o produto WhatsApp, **usuário do sistema** com token permanente (`whatsapp_business_messaging` e `whatsapp_business_management`) | Business Manager › Usuários do sistema |
| 6 | Produção numa versão com CRMLAB-135..141 e 140 (anexos, ffmpeg na imagem) | `GET /api/v1/version` e `docker exec … ffmpeg -version` |
| 7 | `.env` de **prod** com `WHATSAPP_API_URL=https://graph.facebook.com/v<versão>`, `WHATSAPP_WEBHOOK_SECRET=<App Secret>`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN=<valor aleatório>`. **Nunca** `WHATSAPP_CLOUD_API_MOCK` em prod | `deploy.sh` com as envs; DEPLOYMENT "Cloud API" |
| 8 | Ensaio completo em **homologação** (4.3) feito e anotado | Este guia, 4.3 |
| 9 | Quem está com o celular do número (Thaisy ou Tainá) avisada da janela | — |

### 4.2 Coexistência × migração completa

| | Coexistência | Migração completa |
|---|---|---|
| O que é | O número continua no **app WhatsApp Business** do celular **e** passa a falar pela API oficial; mensagens sincronizadas **(conferir na Meta)** | O número sai do app e fica **só** na API oficial |
| Exige | Número no app **WhatsApp Business** (não o WhatsApp comum); cadastro pelo *Embedded Signup* de um parceiro/Tech Provider **(conferir na Meta)** | Apagar a conta do WhatsApp no celular antes de registrar o número na API |
| Celular | Continua útil (ver e responder pelo app); precisa abrir o app periodicamente **(conferir na Meta)** | Não serve mais para esse número |
| Limites | Vazão menor que a API pura e recursos do app que deixam de funcionar (listas de transmissão, por exemplo) **(conferir na Meta)** | Nenhum além dos da API |
| Histórico no celular | Fica | **Some do celular** (no CRM fica tudo) |
| Voltar para o QR | Rápido: trocar o modo no CRM e reparear | Lento: tirar o número da API (`deregister`) e registrar de novo no app, com nova verificação por SMS — horas |
| Risco | Configuração depende de parceiro | Sem volta rápida |

**Recomendação para decidir no dia:** se o número já está no app WhatsApp Business e houver
parceiro para o *Embedded Signup*, coexistência dá volta rápida e mantém o celular. Sem isso,
migração completa. Registrar a escolha em DECISIONS (D-NNN) antes de executar.

### 4.3 Ensaio em homologação (antes de qualquer coisa em prod)

Usa o **número de teste** que a Meta dá no app (não o do Santé) e o tenant `Laboratorio Teste`.

1. `.env` da hml: `WHATSAPP_API_URL`, `WHATSAPP_WEBHOOK_SECRET` (App Secret), `WHATSAPP_WEBHOOK_VERIFY_TOKEN`;
   **tirar** `WHATSAPP_CLOUD_API_MOCK=true` só durante o ensaio (com ele, o envio não chega). Deploy
   pelo `deploy.sh` da hml.
2. Painel do app Meta › WhatsApp › Configuração: callback
   `https://<domínio-hml>/api/v1/webhooks/whatsapp/<slug-do-teste>`, token = `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
   (a Meta faz o `GET` e precisa receber 200), assinar o campo **messages**.
3. CRM hml › Configurações › Canais › WhatsApp: ID do número de teste, WABA e token do usuário do
   sistema; **Modo do WhatsApp › API oficial**.
4. Roteiro (anotar o resultado de cada um):
   - do celular de teste, mandar "oi" → chega no CRM, conversa aberta, janela de 24 h aberta;
   - responder texto → chega; tiques enviado/entregue/lido mudam;
   - mandar foto e PDF do celular → aparecem como anexo na conversa;
   - enviar foto, PDF e **recado de voz** pelo CRM → chegam (o recado como áudio);
   - enviar CSV pelo CRM → recusado com o aviso de formato;
   - conversa sem fala do paciente → texto livre bloqueado, **modelo** sai;
   - Configurações › Canais › "Uso e custo do WhatsApp" mostra as mensagens do dia.
5. Voltar a hml como estava: `WHATSAPP_CLOUD_API_MOCK=true`, modo do Laboratorio Teste conforme o
   treinamento.

### 4.4 Dia da troca em produção (fora do horário de atendimento)

Confirmação explícita do Michel antes de começar (produção). Anotar horário de cada passo.

1. **Aviso** à equipe: atendimento pelo CRM parado por ~30 min; conversas em andamento seguem no CRM.
2. Conferir no CRM se há mensagens `failed` pendentes e reenviar **antes** (pelo QR).
3. **Desligar o QR:** Configurações › Canais › WhatsApp › "Desconectar" (não desativa o canal).
4. **Número na Meta** conforme 4.2:
   - *coexistência*: fluxo do parceiro, lendo o QR do app WhatsApp Business **(conferir na Meta)**;
   - *migração completa*: no celular, WhatsApp › Configurações › Conta › Apagar conta; depois, no
     Gerenciador do WhatsApp, adicionar o número, verificar por SMS/ligação, criar o PIN de duas
     etapas e registrar (`POST /{phone_number_id}/register` com o PIN) **(conferir na Meta)**.
5. **Webhook na Meta:** callback `https://vitrocrm.cloud/api/v1/webhooks/whatsapp/<slug-do-santé>`,
   verify token = `WHATSAPP_WEBHOOK_VERIFY_TOKEN` de prod, campo **messages** assinado. Com mais de um
   laboratório no mesmo app: callback por WABA (DEPLOYMENT).
6. **CRM prod** › Canais › WhatsApp: ID do número (`phone_number_id`), WABA e token permanente; salvar;
   **Modo do WhatsApp › API oficial** (confirmar o aviso).
7. **Teste com um celular da equipe** (não de paciente): mandar mensagem → chega; responder → chega
   com os tiques; mandar e receber uma foto; enviar um modelo.
8. **Logs** por 15 min: `whatsapp.webhook_processed` aparecendo; nenhum
   `whatsapp.webhook_no_phone_number`, `whatsapp.webhook_phone_number_mismatch` ou
   `whatsapp.inbound_media_fallback` em série.
9. Liberar a equipe. Lembrar: na API oficial **não há** reengajamento automático, saudação/fora do
   horário nem teto de primeiro contato (D-214, D-264, D-306 são só do QR); fora das 24 h, só modelo.

### 4.5 Depois da troca

- **Monitor de sessão (CRMLAB-99):** ele só vigia canal `qr`; na API oficial não há sessão para cair,
  então o alerta "WhatsApp desconectado" deixa de existir para o Santé. A saúde passa a ser o webhook
  chegando (logs do item 8) e a fatura/qualidade no Gerenciador do WhatsApp.
- **Custo:** conferir no fim do mês "Uso e custo do WhatsApp" contra a fatura da Meta (é estimativa).
- **Instância do Evolution do Santé:** manter parada (não apagar) até decidir que não há volta.
- Atualizar a memória/STATUS com a data da troca e o caminho escolhido.

### 4.6 Plano de volta para o QR

O histórico do CRM fica intacto nos dois sentidos (D-308).

- **Coexistência:** CRM › Canais › Modo do WhatsApp › **Voltar para QR**; se a sessão do Evolution
  tiver caído, "Conectar WhatsApp" e ler o QR no celular. Minutos.
- **Migração completa:** tirar o número da API (`POST /{phone_number_id}/deregister` ou pelo
  Gerenciador), reinstalar o WhatsApp no celular e verificar o número por SMS; então "Voltar para QR"
  e reparear. **Horas** — por isso a migração completa só depois do ensaio da 4.3 sem pendência.
- Nos dois casos: tirar o callback do app Meta (ou deixar — sem o modo `cloud_api`, aviso da Meta
  continua sendo aceito e gravado; preferir tirar para não misturar), e conferir mensagens `failed`.
