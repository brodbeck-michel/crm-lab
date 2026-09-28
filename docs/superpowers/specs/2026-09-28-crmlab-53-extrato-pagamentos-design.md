# CRMLAB-53 — Extrato de pagamentos do LIS (design)

Data: 28/09/2026. Decisões: **D-188** (extrato e recebido) e **D-189** (releitura diária e planilha
como plano B). Contexto e números: descrição e comentários da CRMLAB-53 no Jira.

## Problema

A API de Orçamentos devolve **uma linha por pagamento**, e o CRM guarda um só `paid_value` por
orçamento. Hoje a última linha que chega sobrescreve o pago (pode zerar orçamento pago), e dentro
da rodada fica a maior linha (ignora parcela). O Bitlab explicou que linha zerada, valor repetido e
soma acima da requisição são **estornos**, e passou a mandar `ID_PAGAMENTO` e `SITUACAO_PAGAMENTO`.
O estorno **não** volta na consulta incremental.

## Solução em uma frase

Guardar cada pagamento num extrato chaveado pelo `ID_PAGAMENTO`, calcular o recebido como a soma
dos ativos (com teto na requisição) e reler os últimos 90 dias uma vez por dia para pegar estornos.
A planilha fica como reserva, ligada por uma regra.

## Modelo (migração `032_lis_budget_payments.sql`)

```sql
CREATE TABLE lis_budget_payments (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  budget_number      TEXT NOT NULL,
  requisition_number TEXT,
  payment_key        TEXT NOT NULL,          -- ID_PAGAMENTO, ou 'planilha:<paid_at>:<valor>'
  source             TEXT NOT NULL CHECK (source IN ('api', 'planilha')),
  paid_at            TIMESTAMP,              -- sem fuso, relógio de Brasília (D-187)
  paid_value         NUMERIC(12,2) NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('ativo', 'estornado')),
  reversed_at        TIMESTAMP,
  payment_method     TEXT,
  card_brand         TEXT,
  import_id          UUID REFERENCES lis_imports(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, budget_number, payment_key)
);
-- RLS igual às outras tabelas do tenant; índice (tenant_id, budget_number).
ALTER TABLE lis_sync_settings ADD COLUMN last_full_scan_on DATE;
```

O `purge` apaga também o extrato do tenant.

## Fluxo de gravação (`ingestRows`, mesmo caminho para planilha e API)

1. `toLisRow` (API) passa a trazer `payment`: `{ key, paidAt, value, status, reversedAt, method,
   brand }`, ou `null` quando a linha não tem `ID_PAGAMENTO`. O parser da planilha monta
   `payment` com `source: 'planilha'` quando `Valor_Pago` vem preenchido, e passa a ler a **hora**
   do `Data_Pagamento`.
2. `consolidateLisRows` consolida só o orçamento (maior total vence) e junta os `payment` de todas
   as linhas do mesmo número numa lista.
3. Por chunk, na transação do chunk:
   - `upsertBudget`, **sem** `paid_value`/`paid_on`;
   - `upsertPayments` (`ON CONFLICT (tenant_id, budget_number, payment_key) DO UPDATE` de
     `status`, `reversed_at`, `payment_method`, `card_brand`, `import_id`, `updated_at`);
   - `recomputePaidValues(numbers)`: um `UPDATE ... FROM (SELECT ...)` com a regra da D-188 item 4;
   - `createBitlabProposals` e `reconcileBudgets`, como hoje (a conciliação lê o valor já recalculado).

## Sincronização (D-189)

- `runForTenant(tenantId, mode)` com `mode: 'incremental' | 'full'`.
- No tique: `full` quando `last_full_scan_on < hoje (Brasília)` e já passou das 03:00. Em
  `full`, `dataInicio` = hoje − `LIS_SYNC_INITIAL_DAYS`, 00:00:00.
- Fim da rodada: marca = `max(marca atual, marca recebida)`; em `full` com sucesso, grava
  `last_full_scan_on = hoje`.
- "Sincronizar agora" fica `incremental`. A tela de integração mostra a data da última releitura.

## Regras (seção nova)

- `FunnelRules.lisSource.spreadsheetImport.enabled`, padrão `false`.
- Página Regras: seção "Carga do LIS" com o texto "A carga principal é a API do Bitlab. Ligue a
  importação por planilha só se a API estiver fora do ar."
- Desligada: `POST /lis-imports` → 409 `SPREADSHEET_IMPORT_DISABLED`; em Resultados o botão
  "Importar planilha" some.

## Testes

Unitários (`bitlab-client`, `lis-spreadsheet`):
- linha com `ID_PAGAMENTO` vira `payment` com situação e estorno; linha sem pagamento → `null`;
- a hora do pagamento é preservada (API e planilha).

Integração (banco real, `lis-import`/`lis-sync`):
1. Parcela em rodadas separadas (maior primeiro, depois menor) → **soma**.
2. Pagamento `ATIVO` numa rodada, a mesma `ID_PAGAMENTO` `ESTORNADO` noutra → sai da soma.
3. Caso 66760 (0 e 528,26 estornados; 100 + 428,26 ativos) → 528,26.
4. Caso 68905 (854,17 estornado; 783,55 ativo) → 783,55.
5. Linha ativa de 0 (68281) não zera o pago.
6. Mesma rodada duas vezes → nada muda.
7. Planilha e depois API para o mesmo orçamento → vale só a API.
8. Só planilha, valor repetido → teto na requisição.
9. Orçamento pago sem extrato (carga antiga) não é tocado.
10. Estorno depois de `ganho`: a proposta continua `ganho`, `lis_paid_value` atualiza.
11. Releitura: roda uma vez por dia depois das 03:00, não recua a marca, não grava
    `last_full_scan_on` se falhar.
12. Flag desligada → `SPREADSHEET_IMPORT_DISABLED`; ligada → importa.

Front: Regras (toggle salva), Resultados (botão some e aparece).

## Implantação

1. hml: deploy, zerar `watermark` e `last_full_scan_on` do Santé, rodar a sincronização (carga
   de 90 dias) e conferir os casos 66760, 68905, 68785, 66210 e 68281 no banco e em Resultados.
2. Validar Resultados e comissão com o gestor do laboratório (antes/depois).
3. prod (com confirmação e bump de versão): deploy, zerar a marca, **religar a sincronização**,
   conferir os mesmos casos.

## Fora do escopo

- Mostrar forma de pagamento ou estorno na tela (fica guardado para um card futuro).
- Estorno com mais de 90 dias.
