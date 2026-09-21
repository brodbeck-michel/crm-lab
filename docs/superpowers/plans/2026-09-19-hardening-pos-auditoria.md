# Plano de execução — Hardening pós-auditoria (epic CRMLAB-27)

> **Contrato entre agentes.** Quem for implementar qualquer card do epic CRMLAB-27 lê este
> arquivo ANTES de `docs/AGENTS.md` do seu domínio. O que está aqui prevalece sobre o hábito:
> em especial o alvo do PR (branch da onda, não `main`) e o ritual de deploy por onda.

Origem: auditoria de 19/09/2026 (stack, código, VPS, capacidade). Nenhum achado crítico.
Score de partida: segurança 7,5/10, estabilidade 7,0/10.

---

## 1. Estratégia: ondas, não cards soltos

Doze cards, três ondas. **Cada onda tem uma branch de integração**, sobe em homologação de uma
vez só, é validada em bloco e só então vai para produção com bump de versão + tag.

Por que não um deploy por card:

- O build ocupa os 2 vCPU da VPS por ~10 min e deixa produção lenta (`ENVIRONMENTS.md` §7).
  Doze builds de hml + doze de prod é tempo de atendimento degradado sem necessidade.
- Uma tag por onda dá rollback limpo: `IMAGE_TAG=<sha-anterior>` volta a onda inteira.
- Validação em bloco é mais barata para o Michel do que doze rodadas de "olha se quebrou".

Por que não tudo numa onda só: se algo quebrar, ninguém sabe qual dos doze cards foi.

| Onda | Branch | Versão alvo | Tema | Cards |
|---|---|---|---|---|
| A | `hardening/onda-a` | v1.10.0 | Estanca o sangramento | CRMLAB-20, 28, 29, 30, 37 |
| B | `hardening/onda-b` | v1.11.0 | Sessão e borda | CRMLAB-31, 32, 34, 36 |
| C | `hardening/onda-c` | v1.12.0 | Fecha o ciclo | CRMLAB-33, 35, 38 |

### Por que esta ordem

- **CRMLAB-37 (dependências) abre a Onda A** de propósito: ele mexe no `package-lock.json`, que
  conflita com qualquer card que adicione dependência depois. Indo primeiro, as ondas B e C já
  partem do lock novo.
- **CRMLAB-33 (WebSocket) espera a Onda B**: com o refresh em cookie `httpOnly` (CRMLAB-32) no ar,
  o handshake do WS já leva a credencial sozinho e o card encolhe pela metade.
- **CRMLAB-35 (senha) espera a Onda B**: mexe no mesmo fluxo de auth que o 32. Em paralelo seria
  conflito garantido em `auth.service.ts`.
- **CRMLAB-31 (mídia) depende de CRMLAB-20**: sem o `client_max_body_size` corrigido, não dá para
  testar upload grande de verdade.

---

## 2. Um agente por card

Cada card recebe um agente próprio, em **git worktree isolado**, com branch
`feature/CRMLAB-<n>-<slug>` criada **a partir da branch da onda**.

O ownership de pastas de `docs/AGENTS.md` continua valendo. O sufixo do agente indica o recorte,
não cria domínio novo.

### Onda A

| Card | Agente | Pastas que pode tocar |
|---|---|---|
| CRMLAB-20 | `Agent-Infra-20` | `nginx/` |
| CRMLAB-28 | `Agent-Infra-28` | `scripts/`, `docs/guides/DEPLOYMENT.md` |
| CRMLAB-29 | `Agent-Kernel-29` | `backend/src/app.ts`, `backend/src/lib/`, `scripts/`, `nginx/` (bloco de health) |
| CRMLAB-30 | `Agent-Kernel-30` | `backend/src/db/`, `backend/src/lib/`, `backend/src/main.ts`, `whatsapp.service.ts` |
| CRMLAB-37 | `Agent-Deps-37` | `package.json` dos workspaces, `package-lock.json`, `.github/` |

**Colisão conhecida da Onda A:** CRMLAB-29 e CRMLAB-20 tocam `nginx/frontend.conf` em blocos
diferentes (health × `location /api/`), e CRMLAB-29 e CRMLAB-30 tocam `backend/src/lib/`
em arquivos diferentes. Rebase na hora do merge resolve; o revisor confere.

### Onda B

| Card | Agente | Observação |
|---|---|---|
| CRMLAB-32 | `Agent-API-32` + `Agent-UI-32` | Dois agentes, um card. O contrato em `docs/api/API_CONTRACTS.md` é atualizado PRIMEIRO, e é o que sincroniza os dois. |
| CRMLAB-34 | `Agent-Kernel-34` | Decisão fail-open × fail-closed vira D-0xx em `DECISIONS.md`, confirmada pelo Michel antes de implementar. |
| CRMLAB-31 | `Agent-API-31` + `Agent-UI-31` | |
| CRMLAB-36 | `Agent-Infra-36` | Só o código (compose, CI, deploy.sh). A execução na VPS é do orquestrador, com janela combinada. |

### Onda C

| Card | Agente |
|---|---|
| CRMLAB-33 | `Agent-Kernel-33` + `Agent-UI-33` |
| CRMLAB-35 | `Agent-API-35` + `Agent-UI-35` |
| CRMLAB-38 | `Agent-DB-38` + `Agent-Kernel-38` |

---

## 3. Protocolo de cada agente

### Ao começar

1. Ler este plano, `docs/AGENTS.md`, o doc do seu domínio e a descrição completa do card no Jira.
2. Mover o card para **Em Desenvolvimento** (transição `2`) com um comentário dizendo: branch,
   worktree, e o recorte que vai fazer.
3. Reivindicar a tarefa em `docs/STATUS.md`.

### Durante

- Commits pequenos com prefixo de domínio: `[infra]`, `[kernel]`, `[api]`, `[ui]`, `[db]`, `[qa]`.
- **Nunca** editar arquivo fora do ownership. Precisou: registra em "Pedidos entre Agentes" no
  `docs/STATUS.md` e segue com o resto.
- **Dúvida de regra de negócio ou decisão que muda produto: PARA.** Comenta a pergunta no card,
  move para **Discussão** (transição `21`) e avisa o orquestrador. Não adivinha.
- Descobriu que o contrato documentado está errado: atualiza o doc e registra em `DECISIONS.md`
  no mesmo commit.

### Ao terminar

1. `npm run typecheck` (4 workspaces) e os testes do domínio — **verdes, com a saída vista**.
   Nunca declarar pronto sem isso.
2. `docs/STATUS.md` com a tarefa ✅ e a data; doc do domínio atualizado se divergiu.
3. Push da branch e **PR para a branch da onda** (`hardening/onda-<x>`), nunca para `main`.
   Título `CRMLAB-<n>: <resumo>`.
4. Comentar no card: arquivos alterados, decisões tomadas, **o que testar em homologação**,
   e o que ficou pendente (honestamente).
5. Mover para **Pronto p/ Validação** (transição `4`).

### Revisão

Cada PR passa por um agente revisor independente (`/code-review`) antes do merge na branch da
onda. Achados voltam para o agente do card, que corrige e move o status de novo.

---

## 4. Mapa de status do Jira (verificado em 19/09/2026)

| Fase | Status | transition id |
|---|---|---|
| Ideia registrada | Backlog | `11` |
| Discutindo escopo / dúvida travando o dev | Discussão | `21` |
| Escopo fechado, pode implementar | Aprovado p/ Dev | `31` |
| Codando | Em Desenvolvimento | `2` |
| Código pronto, aguardando validação | Pronto p/ Validação | `4` |
| Michel validou em homologação | Aprovado | `5` |
| PR aberto / mergeado | PR aberto / Merge | `6` |
| No ar em produção | Finalizado / em produção | `3` |

> **Correção do skill `crm-jira`:** a transição `3` está documentada lá como
> "Dúvida/Revisão de Regras", mas o status foi renomeado e hoje leva a
> **"Finalizado / em produção"**. Para travar por dúvida, use `21` (Discussão).
> Toda transição vem acompanhada de comentário explicando o porquê.

---

## 5. Ciclo da onda: do código à produção

1. Orquestrador cria `hardening/onda-<x>` a partir de `main` e move os cards da onda para
   **Aprovado p/ Dev** (`31`).
2. Agentes trabalham em paralelo. PRs entram na branch da onda depois de revisor + CI verdes.
3. Onda completa: deploy em homologação, **fora do horário de atendimento do laboratório**.
   ```bash
   ssh crm-vps && cd /opt/crm-lab-homolog
   ./scripts/deploy.sh --ref origin/hardening/onda-<x>
   ```
4. Orquestrador comenta em cada card o que validar e o link de hml. **Michel valida.**
   Card ok → **Aprovado** (`5`). Card com problema → volta para Em Desenvolvimento, mesmo agente.
5. Onda validada: PR `hardening/onda-<x>` → `main`. Cards para **PR aberto / Merge** (`6`).
   **O merge exige "sim" explícito do Michel.**
6. Bump do `version` no `package.json` da **raiz** → commit → tag `vX.Y.0` → push `--follow-tags`.
   A versão da tela é build-time: sem bump antes do build, a tela mente.
7. **Deploy de produção exige "sim" explícito do Michel**, a cada vez, mesmo com o merge aprovado.
   ```bash
   cd /opt/crm-lab && ./scripts/deploy.sh    # pede digitar PRODUCAO
   ```
8. Healthcheck + smoke test. Cards para **Finalizado / em produção** (`3`).
   `docs/STATUS.md` fecha a onda.

### Rollback

```bash
cd /opt/crm-lab
IMAGE_TAG=<sha-anterior> docker compose -p crm-lab-prod -f docker-compose.prod.yml up -d backend frontend
```

---

## 6. Nunca, nesta execução

- PR de card direto para `main`. Sempre para a branch da onda.
- Deploy de produção sem bump de versão + tag, e sem confirmação explícita do Michel na conversa.
- `docker compose down`, qualquer `-v`, `volume rm`, `system prune` — nem em homologação.
- Build de homologação em horário de atendimento do laboratório.
- Ligar `EVOLUTION_API_KEY` de produção em homologação.
- Agente editando arquivo de domínio alheio sem registrar pedido em `docs/STATUS.md`.
- Declarar card pronto sem ter visto a saída verde do typecheck e dos testes.

---

## 7. Achados da auditoria que mudaram um card

Registrados aqui porque foram descobertos **depois** da abertura dos cards, verificados na VPS
em 19/09/2026.

### O healthcheck do deploy é cego (afeta CRMLAB-29)

- `GET /healthz` é um `return 200 "ok"` **do próprio nginx** (`nginx/frontend.conf`, bloco
  `location = /healthz`). Nunca toca o backend.
- `GET /health` pela internet cai no `try_files` da SPA e devolve **o HTML do index**, com 200.
  O health real do backend não está exposto.
- O backend responde `{"status":"ok","driver":"pg","uptime":...}` em `/health` **só dentro da
  rede do Compose**, e mesmo assim sem testar Postgres nem Redis.

Consequência: o `deploy.sh` declara "no ar" com o backend morto, e qualquer monitor externo
apontado para `/healthz` mede só o nginx. CRMLAB-29 passa a incluir: expor um health real pela
borda, fazê-lo checar as dependências, e apontar o `deploy.sh` para ele.

### Backup em repositório privado do GitHub pede duas coisas (afeta CRMLAB-28)

Destino escolhido pelo Michel em 19/09. Duas consequências que o card original não previa:

1. **Git nunca esquece.** Commit diário de ~5 MB (dumps + tar da mídia) cresce para sempre.
   Usar **GitHub Releases** como repositório de artefato (`gh release create` por dia, assets
   anexados): apagar release velha libera espaço de verdade, sem inchar o histórico.
2. **Dado de saúde sai da VPS.** Dump com paciente, conversa e mídia indo para um terceiro exige
   **cifragem antes do upload** (`age` ou `gpg` simétrico), com a chave fora do repositório e
   guardada pelo Michel. Chave perdida = backup inútil: isso entra na documentação de restore.
