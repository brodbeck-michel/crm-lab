-- =============================================================================
-- 022_refresh_tokens_absolute_expiry.sql
-- CRMLAB-35 (D-154): teto absoluto de 30 dias por FAMÍLIA de refresh, independente
-- da rotação a cada uso. Sem isso, um refresh rotativo mantém a mesma sessão viva
-- para sempre (dispositivo perdido continua logado enquanto alguém abrir o app).
--
-- TIMESTAMPTZ, e não TIMESTAMP como as colunas vizinhas (D-154). Esta é a
-- PRIMEIRA coluna de data da tabela que faz round-trip: é lida do banco e
-- gravada de volta a cada rotação (o teto é carregado adiante). Num TIMESTAMP
-- naive, o driver devolve um `Date` interpretando o valor como hora LOCAL,
-- enquanto a escrita manda `toISOString()` em UTC — o teto andava para frente o
-- equivalente ao fuso a CADA rotação (3 h em UTC-3), e "absoluto" deixava de
-- ser absoluto. Coberto por teste em `tests/auth/session-lifecycle.spec.ts`.
--
-- Backfill: linhas existentes ganham created_at + 30 dias — não é o valor exato
-- que o login teria gravado (não sabemos a data de login de cada família), mas é
-- uma aproximação segura: nenhuma sessão ativa hoje passa a expirar no passado.
-- =============================================================================
ALTER TABLE refresh_tokens ADD COLUMN absolute_expires_at TIMESTAMPTZ;

UPDATE refresh_tokens
   SET absolute_expires_at = created_at + INTERVAL '30 days'
 WHERE absolute_expires_at IS NULL;

-- DEFAULT antes do NOT NULL (revisao do PR #49): sem ele, a migracao e o codigo
-- ficam co-dependentes nos DOIS sentidos. Processo ANTIGO ainda atendendo depois
-- da migracao faz `INSERT` sem a coluna e viola o NOT NULL — todo login 500. Com
-- o DEFAULT, o processo antigo continua logando gente normalmente durante a
-- janela do deploy. (O outro lado — codigo novo antes da migracao — nao tem como
-- ser coberto aqui: o `migrate` roda antes do `up`, ver DEPLOYMENT.md.)
ALTER TABLE refresh_tokens
  ALTER COLUMN absolute_expires_at SET DEFAULT NOW() + INTERVAL '30 days';
ALTER TABLE refresh_tokens ALTER COLUMN absolute_expires_at SET NOT NULL;

-- Indice de `absolute_expires_at` NAO criado de proposito (revisao do PR #49): a
-- checagem do teto e leitura de UMA linha por hash, e a limpeza filtra
-- `expires_at`/`revoked_at`. Um indice que ninguem le so custa escrita.


-- ---------------------------------------------------------------------------
-- Motivo da revogação (D-154): separa "rotacionado" de "derrubado por ação de
-- segurança". A detecção de reuso (D-015) trata QUALQUER token revogado que
-- reapareça como roubo e derruba a família inteira. Com a troca de senha
-- revogando as outras sessões em massa, o próximo refresh de um outro
-- navegador — comportamento normal, não ataque — derrubaria também a sessão
-- que acabou de trocar a senha, tornando o "exceto a atual" inútil na prática.
-- NULL = revogado antes desta migração: tratado como 'rotated', que é o
-- comportamento que valia até aqui.
-- ---------------------------------------------------------------------------
ALTER TABLE refresh_tokens ADD COLUMN revoked_reason TEXT;
