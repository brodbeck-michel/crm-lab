/**
 * Fluxo 11: badge de nao lidas do Chat Interno — D-068 (supera D-044).
 *
 * Esta e a pendencia **D5 da Onda 5**: `Channel.unreadCount` subia e NUNCA
 * descia, porque nao havia estado de leitura — o backend servia `0` fixo e a
 * tela nao tinha como zerar nada. A Onda 6 criou `channel_reads` e
 * `POST /internal-chat/channels/:id/read`.
 *
 * O seed monta o cenario de proposito (`E2E_CHANNEL_UNREAD.managerAprovacoes`):
 * o GESTOR nao tem linha de leitura em `#aprovacoes` e o post de sistema do
 * pedido de aprovacao conta — entao o canal abre com **1**. Em `#geral` ele ja
 * leu (`E2E_CHANNEL_READS`), entao abre **zerado**. Os dois lados importam: sem
 * o canal zerado ao lado, "o badge sumiu" nao distinguiria "zerou" de "a lista
 * nao renderizou badge nenhum".
 *
 * SEQUENCIA: 1 nasce em 1 · 2 ler historico nao zera · 3 o CLIQUE no canal zera
 * (so para quem clicou) · 4 repetir e idempotente · 5 mensagem nova faz subir
 * de novo — a prova de que o zero nao e um valor fixo. Cada teste monta a
 * propria pre-condicao: nenhum depende do estado deixado pelo anterior, para
 * que `--grep` e retry deem o mesmo resultado que a suite inteira.
 *
 * ── QUEM ZERA E O CLIQUE, NAO O TESTE ─────────────────────────────────────
 * O cabecalho deste arquivo registrava uma divergencia ("a TELA ainda nao chama
 * `POST .../read`") que nao existe mais: `frontend/src/api/internal-chat.ts`
 * expoe `markRead`, `queries.ts` a embrulha em `useMarkChannelRead` e
 * `InternalChat/index.tsx` a dispara no `handleSelect` do canal. Enquanto o
 * spec clicava no canal E chamava a API logo depois, ele nao conseguia
 * distinguir qual dos dois havia zerado o badge — o clique ja tinha zerado.
 * Agora o passo 3 so CLICA: se a tela parar de chamar `POST .../read`, o badge
 * nao desce e o teste fica vermelho.
 */
import { test, expect, type Page } from '@playwright/test';
import type { InternalMessage, ListInternalMessagesResponse } from '@crm-lab/shared';
import {
  API_URL,
  E2E_CHANNEL_UNREAD,
  E2E_CHANNELS,
  E2E_USERS,
  apiLogin,
  authHeaders,
  channelButton,
  channelUnreadBadge,
  fetchChannelByKey,
  loginAs,
  markChannelRead,
} from './helpers.js';

const CHAT_PATH = '/internal-chat';
const APROVACOES = E2E_CHANNELS.aprovacoes.name;
const GERAL = E2E_CHANNELS.geral.name;

/** Espera a coluna de canais renderizar — a tela nao tem `<h1>`. */
async function openChat(page: Page): Promise<void> {
  await page.goto(CHAT_PATH);
  await expect(channelButton(page, APROVACOES)).toBeVisible();
  await expect(channelButton(page, GERAL)).toBeVisible();
}

test.describe('Fluxo 11: badge de nao lidas (D5 da Onda 5)', () => {
  test('o badge do gestor nasce em 1 em #aprovacoes e zerado em #geral', async ({
    page,
    request,
  }) => {
    const token = await apiLogin(request, E2E_USERS.alfaManager);

    const aprovacoes = await fetchChannelByKey(request, token, E2E_CHANNEL_UNREAD.managerAprovacoes.channelKey);
    expect(aprovacoes.unreadCount).toBe(E2E_CHANNEL_UNREAD.managerAprovacoes.expected);
    // Gestor nunca abriu este canal: sem linha em `channel_reads`.
    expect(aprovacoes.lastReadAt).toBeNull();

    const geral = await fetchChannelByKey(request, token, E2E_CHANNEL_UNREAD.managerGeral.channelKey);
    expect(geral.unreadCount).toBe(E2E_CHANNEL_UNREAD.managerGeral.expected);
    expect(geral.lastReadAt).not.toBeNull();

    await loginAs(page, E2E_USERS.alfaManager);
    await openChat(page);

    await expect(channelUnreadBadge(page, APROVACOES)).toHaveText(
      String(E2E_CHANNEL_UNREAD.managerAprovacoes.expected),
    );
    // Controle ao lado: o canal ja lido nao renderiza badge nenhum.
    await expect(channelUnreadBadge(page, GERAL)).toHaveCount(0);
  });

  test('ler o historico do canal NAO marca como lido (D-068)', async ({ request }) => {
    const token = await apiLogin(request, E2E_USERS.alfaManager);
    const antes = await fetchChannelByKey(request, token, 'aprovacoes');
    expect(antes.unreadCount).toBe(1);

    const historico = await request.get(
      `${API_URL}/internal-chat/channels/${antes.id}/messages?limit=100`,
      { headers: authHeaders(token) },
    );
    expect(historico.status()).toBe(200);
    const mensagens = ((await historico.json()) as ListInternalMessagesResponse).messages;
    expect(mensagens.length).toBeGreaterThan(0);

    // Ler pagina de historico nao e ter visto a mensagem nova: o badge fica.
    const depois = await fetchChannelByKey(request, token, 'aprovacoes');
    expect(depois.unreadCount).toBe(1);
    expect(depois.lastReadAt).toBeNull();
  });

  test('ABRIR o canal na tela ZERA o badge — e so para quem clicou', async ({
    page,
    request,
  }) => {
    const gestor = await apiLogin(request, E2E_USERS.alfaManager);
    const admin = await apiLogin(request, E2E_USERS.alfaAdmin);

    const canal = await fetchChannelByKey(request, gestor, 'aprovacoes');
    expect(canal.unreadCount).toBe(1);
    expect(canal.lastReadAt).toBeNull();

    await loginAs(page, E2E_USERS.alfaManager);
    await openChat(page);
    await expect(channelUnreadBadge(page, APROVACOES)).toHaveText('1');

    /*
     * O UNICO gatilho do teste e o clique. Nao ha chamada de API aqui: se a
     * tela nao disparar `POST .../read`, nada zera e as assercoes abaixo caem.
     */
    await channelButton(page, APROVACOES).click();
    await expect(channelButton(page, APROVACOES)).toHaveAttribute('aria-current', 'true');

    // O badge some SEM recarregar: a mutation invalida a lista de canais.
    await expect(channelUnreadBadge(page, APROVACOES)).toHaveCount(0);
    // Controle positivo: o canal continua na lista — sumiu o badge, nao a linha.
    await expect(channelButton(page, APROVACOES)).toBeVisible();

    // E o estado ficou GRAVADO, nao so escondido na tela.
    await expect
      .poll(async () => (await fetchChannelByKey(request, gestor, 'aprovacoes')).unreadCount)
      .toBe(0);
    expect((await fetchChannelByKey(request, gestor, 'aprovacoes')).lastReadAt).not.toBeNull();

    // O estado de leitura e POR USUARIO: o admin nao foi arrastado junto.
    const doAdmin = await fetchChannelByKey(request, admin, 'aprovacoes');
    expect(doAdmin.unreadCount).toBe(E2E_CHANNEL_UNREAD.adminAprovacoes.expected);

    // Sobrevive ao F5: nao era so estado de memoria do cliente.
    await page.reload();
    await expect(channelButton(page, APROVACOES)).toBeVisible();
    await expect(channelUnreadBadge(page, APROVACOES)).toHaveCount(0);
  });

  test('marcar como lido de novo e idempotente', async ({ request }) => {
    const token = await apiLogin(request, E2E_USERS.alfaManager);
    const canal = await fetchChannelByKey(request, token, 'aprovacoes');

    await markChannelRead(request, token, canal.id);
    await markChannelRead(request, token, canal.id);

    expect((await fetchChannelByKey(request, token, 'aprovacoes')).unreadCount).toBe(0);
  });

  test('mensagem nova de outra pessoa faz o badge SUBIR de novo', async ({ page, request }) => {
    const gestor = await apiLogin(request, E2E_USERS.alfaManager);
    const admin = await apiLogin(request, E2E_USERS.alfaAdmin);
    const canal = await fetchChannelByKey(request, gestor, 'aprovacoes');

    /*
     * Pre-condicao MONTADA aqui, nao herdada do teste anterior: assim este
     * teste da o mesmo resultado sozinho (`--grep`), em retry, ou na suite
     * inteira. `POST .../read` e idempotente, entao rodar de novo nao custa.
     */
    await markChannelRead(request, gestor, canal.id);
    expect((await fetchChannelByKey(request, gestor, 'aprovacoes')).unreadCount).toBe(0);

    const enviada = await request.post(
      `${API_URL}/internal-chat/channels/${canal.id}/messages`,
      {
        headers: authHeaders(admin),
        data: { content: `Aviso do E2E ${Date.now()}` },
      },
    );
    expect(enviada.status()).toBe(201);
    const mensagem = (await enviada.json()) as InternalMessage;
    expect(mensagem.senderId).toBe(E2E_USERS.alfaAdmin.id);

    // Para quem RECEBEU, sobe. Para quem ESCREVEU, mensagem propria nao conta.
    expect((await fetchChannelByKey(request, gestor, 'aprovacoes')).unreadCount).toBe(1);
    expect((await fetchChannelByKey(request, admin, 'aprovacoes')).unreadCount).toBe(
      E2E_CHANNEL_UNREAD.adminAprovacoes.expected,
    );

    await loginAs(page, E2E_USERS.alfaManager);
    await openChat(page);
    await expect(channelUnreadBadge(page, APROVACOES)).toHaveText('1');

    // Deixa o canal lido de novo — o proximo arquivo nao herda um badge solto.
    await markChannelRead(request, gestor, canal.id);
    expect((await fetchChannelByKey(request, gestor, 'aprovacoes')).unreadCount).toBe(0);
  });
});
