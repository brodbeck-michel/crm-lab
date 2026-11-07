import { describe, expect, it } from 'vitest';
import { cloudApiAttachmentMessage } from './cloud-api-media';

describe('cloudApiAttachmentMessage (CRMLAB-140, D-314)', () => {
  it('formato recusado: nome do arquivo + formatos aceitos', () => {
    expect(cloudApiAttachmentMessage('lista.csv', { reason: 'cloud_api_media_type' })).toMatch(
      /^"lista\.csv" não pode ser enviado: Formato não aceito pela API oficial do WhatsApp\. Aceitos: foto JPG ou PNG/,
    );
  });

  it('foto grande: limite de 5 MB', () => {
    expect(cloudApiAttachmentMessage('foto.jpg', { reason: 'cloud_api_image_limit', max: 5242880 })).toBe(
      '"foto.jpg" passa de 5 MB, o limite de foto da API oficial do WhatsApp.',
    );
  });

  it('outros erros: null (tratamento comum)', () => {
    expect(cloudApiAttachmentMessage('a.pdf', undefined)).toBeNull();
    expect(cloudApiAttachmentMessage('a.pdf', { byteSize: 1, max: 2 })).toBeNull();
  });
});
