# 📋 CRM SaaS para Laboratórios - Documentação Técnica

## Visão Geral

Documentação técnica do **CRM SaaS para Laboratórios**, um sistema de atendimento por WhatsApp,
orçamentos e pipeline de propostas para laboratórios de análises clínicas.

**Status:** em produção (laboratório Santé) — versão atual no `package.json` da raiz e nas tags `vX.Y.Z`  
**Início:** agosto de 2026  
**Primeiro contato com o projeto?** Comece por `QUICK_START.md`.

---

## 📁 Estrutura de Documentação

```
docs/
├── README.md                    # Este arquivo (índice)
├── AGENTS.md                    # ⭐ Protocolo de coordenação multi-agente — LEIA PRIMEIRO
├── STATUS.md                    # Estado vivo das tarefas por onda (todos atualizam)
├── DECISIONS.md                 # Registro de decisões técnicas (ADR leve)
├── QUICK_START.md               # Início rápido para novos desenvolvedores
├── ARCHITECTURE.md              # Visão geral da arquitetura do sistema
│
├── architecture/
│   └── SECURITY.md              # Segurança + isolamento multitenant (3 camadas)
│
├── api/
│   ├── API_CONTRACTS.md         # Contratos de API (todos os endpoints + shapes)
│   └── API_ERRORS.md            # Catálogo de códigos de erro padronizados
│
├── database/
│   └── SCHEMA.md                # Schema completo: tabelas, índices, RLS
│
├── frontend/
│   ├── COMPONENTS.md            # Inventário de componentes reutilizáveis
│   └── PAGES.md                 # Telas: rotas, layouts, dados, permissões
│
├── backend/
│   └── SERVICES.md              # Interfaces de todos os serviços + dependências
│
├── design/
│   └── DESIGN_TOKENS.md         # Tokens: cores, temas, tipografia, estados
│
├── guides/
│   ├── DEVELOPMENT.md           # Setup e ciclo de trabalho diário
│   ├── CONVENTIONS.md           # Convenções de código e git
│   ├── ENVIRONMENTS.md          # ⭐ prod × hml: o que é cada um, como subir
│   ├── DEPLOYMENT.md            # Pipeline de CI, imagens, rollback, backup
│   ├── MONITORING.md            # Logs, sondas de saúde, alertas
│   ├── TESTING.md               # Estratégia de testes + isolamento multitenant
│   ├── IMPLANTACAO_SANTE.md     # Implantação do laboratório Santé
│   └── MIGRACAO_SANTE.md        # Migração do Santé para a Cloud API da Meta
│
│
├── domain/
│   ├── BUSINESS_RULES.md        # ⭐ 10 regras de negócio críticas (todos leem)
│   └── WORKFLOWS.md             # 10 fluxos de trabalho + matriz de integração
│
├── contracts/
│   └── FRONTEND_BACKEND.md      # Regras do contrato de integração front↔back
│
└── superpowers/                 # Specs e planos de implementação por onda/card (histórico)
```

> Referência visual complementar: `../Design System CRM.dc.html` (protótipo do design system).

---

## 🎯 Princípios do Projeto

1. **Conversação é o produto:** Todas as telas existem para encurtar o caminho entre a primeira mensagem e a coleta agendada
2. **Tema é dado, não código:** Configurações de cor, raio e font são por tenant
3. **Um número, uma origem:** Valores derivam dos mesmos dados (sem duplicação)
4. **Multitenant primeiro:** Sistema projetado para múltiplos laboratórios com isolamento total
5. **Type-safe:** TypeScript obrigatório em toda a aplicação

---

## 🛠️ Stack Tecnológico

Decidida e registrada em `DECISIONS.md` — não renegociar sem nova decisão.

- **Monorepo:** npm workspaces — `shared/` · `backend/` · `frontend/` · `e2e/`
- **Frontend:** React 18 + Vite + TypeScript + Tailwind 3 (cores via CSS vars) + TanStack Query + Zustand
- **Backend:** Node.js + Express 4 + TypeScript ESM (D-007), camadas controller → service → repository
- **Banco:** PostgreSQL 16 com RLS; testes em PGlite (D-008)
- **Cache/rate limit:** Redis 7 (memória quando `REDIS_URL` não existe); fila in-process
- **WhatsApp:** Cloud API oficial da Meta ou gateway Evolution (QR); MOCK em dev
- **Testes:** Vitest (back e front) + Playwright (e2e)
- **Infra:** Docker Compose numa VPS (prod e hml isoladas por projeto Compose), CI no GitHub Actions

---

## 📊 Perfis de Usuário

| Perfil | Permissões | Limite Desconto | Acesso |
|--------|-----------|-----------------|--------|
| **Atendente** | Chat, Orçamento, Leitura | 15% | Própria fila |
| **Gestor** | Supervisão, Aprovação | 30% | Equipe toda |
| **Admin** | Completo | 100% | Laboratório |
| **Operador** | Plataforma | N/A | Console isolado |

---

## 🚀 Andamento

O trabalho foi feito em ondas (Onda 1 → 8) e hoje segue por cards do Jira (projeto CRMLAB).
Estado vivo de cada tarefa: `STATUS.md`. Setup local: `QUICK_START.md`.

---

## 🔗 Links Importantes

- **Design System:** `docs/design/DESIGN_TOKENS.md`
- **Arquitetura:** `docs/ARCHITECTURE.md` + `docs/architecture/SECURITY.md`
- **Ambientes (prod × hml):** `docs/guides/ENVIRONMENTS.md`
- **API Reference:** `docs/api/API_CONTRACTS.md`
- **Database Schema:** `docs/database/SCHEMA.md`
- **Desenvolvimento:** `docs/guides/DEVELOPMENT.md`

---

## 👥 Como Contribuir

1. **Leia** `docs/AGENTS.md` — protocolo de coordenação (obrigatório para agentes)
2. **Siga** `docs/guides/CONVENTIONS.md` para padrões de código, branches e commits
3. **Valide** com testes em `docs/guides/TESTING.md`
4. **Atualize** `docs/STATUS.md` ao reivindicar e concluir tarefas

---

## 📞 Contato e Dúvidas

- **Lead técnico:** Michel (`brodbeck-michel` no GitHub)
- **Tarefas:** Jira, projeto CRMLAB
- **Documentação desatualizada?** Atualize e abra PR

---

**Última atualização:** 2026-11-20
