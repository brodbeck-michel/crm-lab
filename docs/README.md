# 📋 CRM SaaS para Laboratórios - Documentação Técnica

## Visão Geral

Este é o repositório de documentação técnica para o **CRM SaaS para Laboratórios**, um sistema de gestão de relacionamento com clientes projetado especificamente para laboratórios de análises clínicas.

**Versão:** 1.0  
**Status:** Em desenvolvimento (Fase 1 - MVP)  
**Data de início:** Agosto 2024

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
│   ├── DEPLOYMENT.md            # Pipeline de CI, imagens, rollback
│   └── TESTING.md               # Estratégia de testes + isolamento multitenant
│
├── domain/
│   ├── BUSINESS_RULES.md        # ⭐ 10 regras de negócio críticas (todos leem)
│   └── WORKFLOWS.md             # 10 fluxos de trabalho + matriz de integração
│
└── contracts/
    └── FRONTEND_BACKEND.md      # Regras do contrato de integração front↔back
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

### Frontend
- **Framework:** React 18+
- **Linguagem:** TypeScript
- **Estilo:** Tailwind CSS + CSS Variables
- **Estado:** TanStack Query + Zustand
- **Bundler:** Vite
- **Componentes:** shadcn/ui (customizado)

### Backend
- **Runtime:** Node.js 18+
- **Framework:** Express.js ou NestJS
- **Banco:** PostgreSQL 14+
- **Cache:** Redis
- **Fila:** Bull (Redis-backed)
- **Autenticação:** JWT + OAuth2

### Infraestrutura
- **Containerização:** Docker
- **Orquestração:** Docker Compose (dev), Kubernetes (prod)
- **CI/CD:** GitHub Actions
- **Hosting:** AWS (recomendado) ou similar

---

## 📊 Perfis de Usuário

| Perfil | Permissões | Limite Desconto | Acesso |
|--------|-----------|-----------------|--------|
| **Atendente** | Chat, Orçamento, Leitura | 10-15% | Própria fila |
| **Gestor** | Supervisão, Aprovação | 30% | Equipe toda |
| **Admin** | Completo | Ilimitado | Laboratório |
| **Operador** | Plataforma | N/A | Console isolado |

---

## 🚀 Fases de Desenvolvimento

### Fase 1: MVP (8-10 semanas)
- Autenticação multitenant
- 12 telas principais
- Sistema de tema
- Pipeline de propostas (6 estágios)

### Fase 2: Integrações (6-8 semanas)
- WhatsApp Business API
- Chat interno
- Painel de conversão
- Auditoria

### Fase 3: Plataforma (6-8 semanas)
- Console de plataforma
- Gestão de assinaturas
- API pública

---

## 📋 Checklist de Setup

Para começar a trabalhar com este projeto:

- [ ] Clonar repositório
- [ ] Instalar dependências (frontend e backend)
- [ ] Copiar `.env.example` para `.env` com variáveis locais
- [ ] Rodar migrações do banco de dados
- [ ] Seeding de dados iniciais
- [ ] Rodar testes para validar setup
- [ ] Revisar documentação de desenvolvimento

---

## 🔗 Links Importantes

- **Design System:** `docs/design/DESIGN_TOKENS.md`
- **Arquitetura:** `docs/architecture/SYSTEM_DESIGN.md`
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

- **Lead Técnico:** gestao.dados@unimedtubarao.com.br
- **Issues:** GitHub Issues
- **Documentação desatualizada?** Atualize e abra PR

---

**Última atualização:** Agosto 23, 2024  
**Versão:** 1.0.0
