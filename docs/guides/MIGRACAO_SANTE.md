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
