-- =============================================================================
-- 071_doctor_profile_backfill.sql
-- CRMLAB-188 (D-328): dados do cadastro ampliado. SCHEMA.md §51. So DML,
-- IDEMPOTENTE (a segunda execucao nao muda nada) — roda como dono das tabelas,
-- fora do RLS, como as demais migracoes de dados (060).
--
-- Normalizacao de nome = a de `normalizeLookupName` (shared): sem acento
-- (`crm_unaccent`, 043), minuscula, espacos colapsados, aparado.
--
--  1. Semeia as especialidades mais comuns do CFM em todo laboratorio
--     (lista = `DEFAULT_DOCTOR_SPECIALTIES`; laboratorio criado depois e
--     semeado pelo service na primeira leitura).
--  2. Texto de `doctors.specialty` que nao casa com a lista vira especialidade
--     nova do laboratorio (grafia: a menor, em ordem de texto, entre as que
--     dobram para o mesmo nome).
--  3. `doctors.specialty_id` pelo nome normalizado.
--  4. `doctors.secretary_name` <- `contact_name`.
--  5. `proposals.doctor_id` pelo nome normalizado EXATO do medico solicitante,
--     so quando ha UM medico com esse nome no laboratorio (ativo ou inativo);
--     ambiguo nao vincula.
--
-- Conferencia depois (deve dar 0 nas duas):
--   SELECT count(*) FROM doctors WHERE NULLIF(btrim(specialty), '') IS NOT NULL AND specialty_id IS NULL;
--   SELECT count(*) FROM doctors WHERE NULLIF(btrim(contact_name), '') IS NOT NULL AND secretary_name IS NULL;
-- =============================================================================

-- 1. Lista padrao em todo laboratorio.
INSERT INTO doctor_specialties (tenant_id, name, normalized_name)
SELECT t.id, s.name, lower(btrim(regexp_replace(crm_unaccent(s.name), '\s+', ' ', 'g')))
  FROM tenants t
 CROSS JOIN (VALUES
   ('Acupuntura'), ('Alergia e Imunologia'), ('Anestesiologia'), ('Angiologia'), ('Cardiologia'),
   ('Cirurgia do Aparelho Digestivo'), ('Cirurgia Geral'), ('Cirurgia Pediátrica'),
   ('Cirurgia Plástica'), ('Cirurgia Vascular'), ('Clínica Médica'), ('Coloproctologia'),
   ('Dermatologia'), ('Endocrinologia e Metabologia'), ('Gastroenterologia'), ('Genética Médica'),
   ('Geriatria'), ('Ginecologia e Obstetrícia'), ('Hematologia e Hemoterapia'), ('Homeopatia'),
   ('Infectologia'), ('Mastologia'), ('Medicina de Família e Comunidade'), ('Medicina do Trabalho'),
   ('Medicina Esportiva'), ('Medicina Intensiva'), ('Nefrologia'), ('Neurocirurgia'), ('Neurologia'),
   ('Nutrologia'), ('Oftalmologia'), ('Oncologia Clínica'), ('Ortopedia e Traumatologia'),
   ('Otorrinolaringologia'), ('Patologia Clínica/Medicina Laboratorial'), ('Pediatria'),
   ('Pneumologia'), ('Psiquiatria'), ('Radiologia e Diagnóstico por Imagem'), ('Reumatologia'),
   ('Urologia')
 ) AS s(name)
ON CONFLICT (tenant_id, normalized_name) DO NOTHING;

-- 2. Texto antigo que nao casou vira especialidade do laboratorio.
INSERT INTO doctor_specialties (tenant_id, name, normalized_name)
SELECT d.tenant_id,
       min(btrim(regexp_replace(d.specialty, '\s+', ' ', 'g'))),
       lower(btrim(regexp_replace(crm_unaccent(d.specialty), '\s+', ' ', 'g')))
  FROM doctors d
 WHERE NULLIF(btrim(d.specialty), '') IS NOT NULL
 GROUP BY d.tenant_id, lower(btrim(regexp_replace(crm_unaccent(d.specialty), '\s+', ' ', 'g')))
ON CONFLICT (tenant_id, normalized_name) DO NOTHING;

-- 3. Medico -> especialidade da lista.
UPDATE doctors d
   SET specialty_id = s.id
  FROM doctor_specialties s
 WHERE s.tenant_id = d.tenant_id
   AND d.specialty_id IS NULL
   AND NULLIF(btrim(d.specialty), '') IS NOT NULL
   AND s.normalized_name = lower(btrim(regexp_replace(crm_unaccent(d.specialty), '\s+', ' ', 'g')));

-- 4. Secretaria: o contato antigo vira o nome.
UPDATE doctors
   SET secretary_name = btrim(contact_name)
 WHERE secretary_name IS NULL
   AND NULLIF(btrim(contact_name), '') IS NOT NULL;

-- 5. Proposta -> medico, so com nome normalizado exato e sem homonimo.
UPDATE proposals p
   SET doctor_id = m.doctor_id
  FROM (
    SELECT tenant_id,
           lower(btrim(regexp_replace(crm_unaccent(name), '\s+', ' ', 'g'))) AS normalized_name,
           (array_agg(id))[1] AS doctor_id
      FROM doctors
     GROUP BY tenant_id, lower(btrim(regexp_replace(crm_unaccent(name), '\s+', ' ', 'g')))
    HAVING count(*) = 1
  ) m
 WHERE p.doctor_id IS NULL
   AND p.tenant_id = m.tenant_id
   AND NULLIF(btrim(p.requesting_doctor), '') IS NOT NULL
   AND lower(btrim(regexp_replace(crm_unaccent(p.requesting_doctor), '\s+', ' ', 'g'))) = m.normalized_name;
