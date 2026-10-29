/**
 * `fileNameWithExtension` (CRMLAB-131): o nome que vai para o download e para
 * o Evolution — que deduz o mimetype pelo nome e gravava `'false'` para `.jfif`.
 */
import { describe, expect, it } from 'vitest';
import { fileNameWithExtension } from '@crm-lab/shared';

describe('fileNameWithExtension', () => {
  it.each([
    ['imagem', 'image/jpeg', 'imagem.jpg'],
    ['doc..jfif', 'image/jpeg', 'doc..jpg'],
    ['imagem (13).JFIF', 'image/jpeg', 'imagem (13).jpg'],
    ['foto.jpe', 'image/jpeg', 'foto.jpg'],
    ['foto.png', 'image/jpeg', 'foto.jpg'],
    ['foto.JPEG', 'image/jpeg', 'foto.JPEG'],
    ['pedido.jpg', 'image/jpeg', 'pedido.jpg'],
    ['print.png', 'image/png', 'print.png'],
    ['documento', 'application/pdf', 'documento.pdf'],
    ['pedido.v2', 'application/pdf', 'pedido.v2.pdf'],
    ['Dr. Silva', 'application/pdf', 'Dr. Silva.pdf'],
    ['audio', 'audio/ogg; codecs=opus', 'audio.ogg'],
    ['.jfif', 'image/jpeg', 'arquivo.jpg'],
  ])('%s (%s) → %s', (fileName, mimeType, expected) => {
    expect(fileNameWithExtension(fileName, mimeType)).toBe(expected);
  });

  it('MIME fora da allow-list devolve o nome como veio', () => {
    expect(fileNameWithExtension('laudo.html', 'application/octet-stream')).toBe('laudo.html');
  });
});
