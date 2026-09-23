/**
 * Envio de e-mail — provedor Resend (CRMLAB-39, D-172).
 *
 * `RESEND_API_KEY`/`RESEND_FROM_EMAIL` ausentes (dev/teste sem as chaves) =
 * driver MOCK que so loga o conteudo, mesmo padrao do `WHATSAPP_API_URL` vazio
 * (`SERVICES.md`) — nunca lanca, nunca bloqueia o fluxo que chamou.
 *
 * Chamado SEMPRE fire-and-forget pelo `AuthService` (nunca `await`ado no
 * caminho de resposta de `/auth/forgot-password`): o tempo de resposta da rota
 * nao pode variar conforme o e-mail existir ou nao (SECURITY.md — "nao ser
 * oraculo"), e uma chamada de rede ao Resend seria exatamente essa variacao.
 */
import { Resend } from 'resend';
import { env } from '../config/env.js';
import { logger } from './logger.js';

export interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
}

export interface EmailService {
  send(input: SendEmailInput): Promise<void>;
}

let client: Resend | null = null;
function resendClient(): Resend {
  client ??= new Resend(env.RESEND_API_KEY);
  return client;
}

export function createEmailService(): EmailService {
  const send = async (input: SendEmailInput): Promise<void> => {
    if (!env.RESEND_API_KEY || !env.RESEND_FROM_EMAIL) {
      logger.warn('email.mock_send', { to: input.to, subject: input.subject });
      return;
    }
    try {
      const result = await resendClient().emails.send({
        from: env.RESEND_FROM_EMAIL,
        to: input.to,
        subject: input.subject,
        html: input.html,
      });
      if (result.error) {
        logger.error('email.send_failed', { to: input.to, reason: result.error.message });
      }
    } catch (err) {
      // Nunca propaga: quem chama (AuthService.forgotPassword) ja respondeu
      // 200 ao cliente antes desta promise resolver.
      logger.error('email.send_failed', {
        to: input.to,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  };

  return { send };
}
