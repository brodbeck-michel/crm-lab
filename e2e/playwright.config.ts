import { defineConfig, devices } from '@playwright/test';

/**
 * Configuração do Playwright — CRM SaaS Laboratório.
 *
 * Pré-requisitos (a suíte NÃO sobe nada sozinha):
 *   npm run seed:e2e --workspace backend   # dataset fixo de e2e-fixtures.ts
 *   npm run dev:backend                    # API em :3000
 *   npm run dev:frontend                   # UI em :5173
 *   npx playwright install --with-deps chromium
 *
 * **Semeie ANTES de cada execução.** A suíte cria propostas, exames e usuários
 * (de propósito: estágio é caminho sem volta, e reusar linha semeada faria a
 * segunda execução falhar). Sem re-seed, o banco acumula e as telas que só
 * carregam a primeira página passam a esconder o dado semeado.
 *
 * **`RATE_LIMIT_PER_MINUTE=2000` no ambiente de E2E** — e o motivo mudou.
 *
 * O texto antigo aqui dizia que `req.ctx` é sempre `undefined` no limiter e que
 * por isso TODO o tráfego, autenticado ou não, caía num único balde por IP.
 * Isso **não vale mais**: D-054 corrigiu `rateLimitKey`, que agora verifica a
 * assinatura do próprio Bearer token e usa o `userId` de dentro dele. Requisição
 * autenticada tem balde próprio por usuário; os 100/min padrão sobram para ela.
 *
 * O que sobrou de real é menor e não tem correção possível no backend:
 * `POST /auth/login` é **anônimo por definição** — não há token para chavear —
 * então cai no balde por IP, e a suíte inteira sai de um IP só. São ~34 logins
 * de UI (`loginAs`, sempre bate na API) mais os `apiLogin` que não acharem token
 * no cache do worker, e `retries: 2` pode triplicar o custo de um teste instável.
 * Some a isso o polling anônimo de `/health` que o job de CI faz enquanto espera
 * a API subir. O pico fica na casa das centenas dentro da janela de 60s — acima
 * dos 100 padrão, bem abaixo de 2000.
 *
 * 2000 e não 100000: o limite continua **montado e funcional** (um loop
 * descontrolado ainda é barrado), só deixa de ser um falso-vermelho da suíte.
 * Desligar o limitador no ambiente que deveria exercitá-lo seria mascarar.
 *
 * O lockout de login (5 tentativas/15min) não é risco aqui: ele só conta
 * tentativa que FALHA, e a suíte loga com credenciais válidas do seed.
 *
 * O número não depende de como `clientIp` resolve `X-Forwarded-For`: no runner
 * a suíte, a API e a UI estão todas em localhost, então o balde anônimo é um só
 * qualquer que seja a origem escolhida para o IP.
 *
 * `workers: 1` de propósito, em CI **e** local: os specs compartilham UM banco
 * semeado. Dois arquivos em paralelo trocariam o tema do mesmo tenant, ou
 * criariam exame/usuário enquanto o outro conta linhas — falha intermitente
 * que não é bug do produto. Determinismo vale mais que os segundos poupados.
 *
 * `fullyParallel: false` mantém a ordem dentro de cada arquivo, que é o que os
 * fluxos multi-passo assumem.
 */
export default defineConfig({
  testDir: './workflows',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,

  /** Rede/render podem ser lentos em CI; a asserção espera, não dorme. */
  expect: { timeout: 10_000 },
  timeout: 60_000,

  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',

  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    /** pt-BR: os specs conferem `R$ 1.234,56` e datas no formato brasileiro. */
    locale: 'pt-BR',
    timezoneId: 'America/Sao_Paulo',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: undefined, // iniciado manualmente: npm run dev
});
