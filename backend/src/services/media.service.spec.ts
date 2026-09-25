/**
 * `resolveStoredMimeType` — allow-list + sniff de magic bytes (CRMLAB-31).
 *
 * Unidade pura (sem PGlite): a função não toca repositório nem disco.
 */
import { describe, expect, it } from 'vitest';
import { BusinessError } from '../http/errors.js';
import { assertOutboundMimeAllowed, resolveStoredMimeType } from './media.service.js';

// `file-type` lê além da assinatura (cabeçalho do primeiro chunk/segmento) —
// buffer curto demais lança `EndOfStreamError` em vez de "não reconheci".
// 32 bytes de padding cobrem folgado o que cada formato precisa ler.
const PAD = Buffer.alloc(32);
const PNG_MAGIC = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), PAD]);
const JPEG_MAGIC = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
  PAD,
]);
const PDF_MAGIC = Buffer.concat([Buffer.from('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n', 'latin1'), PAD]);
const HTML_BYTES = Buffer.from('<script>alert(document.cookie)</script>');
const PLAIN_TEXT = Buffer.from('foto do pedido medico');
const TINY_TRUNCATED = Buffer.from([0x89, 0x50]);

describe('resolveStoredMimeType', () => {
  it('MIME fora da allow-list vira application/octet-stream, mesmo sem tentar sniff', async () => {
    await expect(resolveStoredMimeType('text/html', HTML_BYTES)).resolves.toBe(
      'application/octet-stream',
    );
    await expect(resolveStoredMimeType('image/svg+xml', HTML_BYTES)).resolves.toBe(
      'application/octet-stream',
    );
  });

  it('MIME na allow-list sem assinatura verificável (texto puro/áudio não coberto) é mantido', async () => {
    await expect(resolveStoredMimeType('text/plain', PLAIN_TEXT)).resolves.toBe('text/plain');
    await expect(resolveStoredMimeType('audio/amr', PLAIN_TEXT)).resolves.toBe('audio/amr');
  });

  it('imagem/PDF com magic bytes batendo com o declarado passa direto', async () => {
    await expect(resolveStoredMimeType('image/png', PNG_MAGIC)).resolves.toBe('image/png');
    await expect(resolveStoredMimeType('image/jpeg', JPEG_MAGIC)).resolves.toBe('image/jpeg');
    await expect(resolveStoredMimeType('application/pdf', PDF_MAGIC)).resolves.toBe(
      'application/pdf',
    );
  });

  it('magic bytes reais divergem do MIME declarado -> application/octet-stream', async () => {
    // PDF de verdade declarado como imagem: sniff prova a divergência.
    await expect(resolveStoredMimeType('image/jpeg', PDF_MAGIC)).resolves.toBe(
      'application/octet-stream',
    );
    // PNG de verdade declarado como PDF.
    await expect(resolveStoredMimeType('application/pdf', PNG_MAGIC)).resolves.toBe(
      'application/octet-stream',
    );
  });

  it('formato sem assinatura reconhecível (ex.: texto puro) não prova divergência — mantém o declarado', async () => {
    // `file-type` não reconhece nada num buffer de texto puro: sem detecção
    // POSITIVA, não há divergência PROVADA, então o MIME declarado (já na
    // allow-list) fica. Cobre o mesmo cenário do teste de integração de
    // attachments.spec.ts (JPEG "fake" feito de texto).
    await expect(resolveStoredMimeType('image/jpeg', PLAIN_TEXT)).resolves.toBe('image/jpeg');
  });

  it('normaliza espaço/maiúsculas antes de checar a allow-list', async () => {
    await expect(resolveStoredMimeType('  IMAGE/PNG  ', PNG_MAGIC)).resolves.toBe('image/png');
  });

  it('buffer curto demais para o sniff (EndOfStreamError) não derruba a promessa de nunca lançar', async () => {
    // `storeInbound` (§4.2) promete NUNCA lançar — um arquivo minúsculo/
    // truncado não pode virar unhandled rejection no meio do webhook.
    await expect(resolveStoredMimeType('image/png', TINY_TRUNCATED)).resolves.toBe('image/png');
  });

  /**
   * Revisao do PR #43 — os dois achados HIGH. `audio/ogg; codecs=opus` e o
   * mimetype PADRAO do recado de voz do WhatsApp (o Evolution repassa
   * literalmente). A comparacao de string inteira contra `audio/ogg` rebaixava
   * TODO audio recebido para `application/octet-stream`: o player sumia e a
   * bolha mostrava "Baixar anexo (doc)".
   */
  it('MIME com parâmetro (`audio/ogg; codecs=opus`, recado de voz) passa pela allow-list', async () => {
    await expect(resolveStoredMimeType('audio/ogg; codecs=opus', PLAIN_TEXT)).resolves.toBe('audio/ogg');
  });

  it('sinônimo do file-type na MESMA categoria não é divergência (M4A, APNG)', async () => {
    // `file-type` rotula M4A como `audio/x-m4a`; o declarado e `audio/mp4`.
    // Mesma categoria (audio) => nao e HTML disfarcado, e o declarado fica.
    const m4a = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x1c]),
      Buffer.from('ftypM4A '),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from('M4A mp42isom'),
    ]);
    await expect(resolveStoredMimeType('audio/mp4', m4a)).resolves.toBe('audio/mp4');
  });

  /**
   * CRMLAB-24 (D-182): o `MediaRecorder` do Chrome grava WebM e o do Safari,
   * MP4 com brand `mp42`/`isom` — e o `file-type` rotula os dois como VIDEO.
   * Mesmo contêiner não é troca de categoria: sem isto o recado de voz virava
   * `application/octet-stream`, ia como documento e perdia o player.
   */
  it('recado gravado no navegador: WebM/MP4 detectado como vídeo mantém o áudio declarado', async () => {
    const webm = Buffer.concat([
      Buffer.from(
        '1a45dfa39f4286810142f7810142f2810442f381084282847765626d42878104428581021853806701ffffffffffffff',
        'hex',
      ),
      Buffer.alloc(64),
    ]);
    const mp4 = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x00, 0x18]),
      Buffer.from('ftypmp42'),
      Buffer.from([0x00, 0x00, 0x00, 0x00]),
      Buffer.from('mp42isom'),
      Buffer.alloc(64),
    ]);
    await expect(resolveStoredMimeType('audio/webm;codecs=opus', webm)).resolves.toBe('audio/webm');
    await expect(resolveStoredMimeType('audio/mp4', mp4)).resolves.toBe('audio/mp4');
    await expect(resolveStoredMimeType('audio/aac', mp4)).resolves.toBe('audio/aac');
    // Contêiner diferente do declarado continua sendo divergência provada.
    await expect(resolveStoredMimeType('audio/ogg', webm)).resolves.toBe('application/octet-stream');
    await expect(resolveStoredMimeType('audio/webm', mp4)).resolves.toBe('application/octet-stream');
  });

  it('divergência de CATEGORIA continua derrubando (PDF disfarçado de áudio)', async () => {
    await expect(resolveStoredMimeType('audio/ogg', PDF_MAGIC)).resolves.toBe(
      'application/octet-stream',
    );
  });
});

describe('assertOutboundMimeAllowed', () => {
  it('anexo do atendente fora da allow-list é VALIDATION_ERROR, não rebaixamento mudo', () => {
    const erro = (() => {
      try {
        assertOutboundMimeAllowed('text/html');
        return null;
      } catch (e) {
        return e as BusinessError;
      }
    })();
    expect(erro).toBeInstanceOf(BusinessError);
    expect(erro?.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(erro?.details)).toMatch(/mimeType/);
    expect(() => assertOutboundMimeAllowed('image/svg+xml')).toThrowError(BusinessError);
    expect(() => assertOutboundMimeAllowed('audio/ogg; codecs=opus')).not.toThrow();
    expect(() => assertOutboundMimeAllowed('image/heic')).not.toThrow();
    expect(() => assertOutboundMimeAllowed('text/csv')).not.toThrow();
  });
});
