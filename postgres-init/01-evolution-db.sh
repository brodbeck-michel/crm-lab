#!/usr/bin/env bash
# Roda uma unica vez, no primeiro init do volume `postgres-data` (mecanismo
# padrao da imagem oficial `postgres`: todo `.sh`/`.sql` em
# /docker-entrypoint-initdb.d so executa quando o data dir esta vazio).
#
# O compose so cria o banco de POSTGRES_DB (`crm_lab`, ver docker-compose.yml
# / docker-compose.prod.yml). O gateway Evolution API (D-083) precisa do
# proprio banco — nunca dividir schema com o CRM — entao este script cria
# `evolution` no mesmo Postgres, de posse do mesmo usuario que ja e dono de
# `crm_lab`. Em .sh (ao contrario de .sql) a imagem oficial injeta
# $POSTGRES_USER de verdade, o que funciona tanto no `crm` fixo do dev quanto
# no usuario variavel do prod.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
    SELECT 'CREATE DATABASE evolution OWNER ' || quote_ident('$POSTGRES_USER')
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'evolution')\gexec
EOSQL
