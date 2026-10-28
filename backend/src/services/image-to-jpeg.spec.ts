/**
 * `convertImageToJpeg` (CRMLAB-128, D-290). Unidade pura: imagens reais
 * geradas pelo proprio sharp, sem banco nem disco.
 */
import sharp, { type Color, type Sharp } from 'sharp';
import { describe, expect, it } from 'vitest';
import { convertImageToJpeg, jpegFileName, MAX_INPUT_PIXELS } from './image-to-jpeg.js';

const JPEG_SOI = Buffer.from([0xff, 0xd8, 0xff]);

function solid(width: number, height: number, background: Color): Sharp {
  return sharp({ create: { width, height, channels: 4, background } });
}

async function frames(): Promise<Buffer[]> {
  return [await solid(8, 8, 'red').png().toBuffer(), await solid(8, 8, 'blue').png().toBuffer()];
}

describe('convertImageToJpeg', () => {
  it('PNG com transparência vira JPEG com fundo branco e nome .jpg', async () => {
    const png = await solid(20, 10, { r: 0, g: 0, b: 0, alpha: 0 }).png().toBuffer();
    const out = await convertImageToJpeg({ buffer: png, mimeType: 'image/png', fileName: 'print.png' });

    expect(out.mimeType).toBe('image/jpeg');
    expect(out.fileName).toBe('print.jpg');
    expect(out.buffer.subarray(0, 3)).toEqual(JPEG_SOI);
    const { data, info } = await sharp(out.buffer).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(3);
    // Pixel transparente virou branco, nao preto.
    expect(data[0]).toBeGreaterThan(245);
  });

  it('WebP estático (não figurinha) vira JPEG', async () => {
    const webp = await solid(16, 16, 'green').webp().toBuffer();
    const out = await convertImageToJpeg({ buffer: webp, mimeType: 'image/webp', fileName: 'foto.webp' });
    expect(out.mimeType).toBe('image/jpeg');
    expect(out.fileName).toBe('foto.jpg');
    expect((await sharp(out.buffer).metadata()).format).toBe('jpeg');
  });

  it('foto girada pelo EXIF sai em pé e sem EXIF/GPS', async () => {
    // 40x20 com orientação 6 (girar 90°) e GPS: quem abre deve ver 20x40.
    const jpeg = await sharp({ create: { width: 40, height: 20, channels: 3, background: 'red' } })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .withExif({ IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '28/1 28/1 0/1' } })
      .toBuffer();
    const before = await sharp(jpeg).metadata();
    expect(before.orientation).toBe(6);
    expect(before.exif).toBeDefined();

    const out = await convertImageToJpeg({ buffer: jpeg, mimeType: 'image/jpeg', fileName: 'IMG_1.jpeg' });
    const after = await sharp(out.buffer).metadata();
    expect(out.mimeType).toBe('image/jpeg');
    expect(out.fileName).toBe('IMG_1.jpg');
    expect(after.width).toBe(20);
    expect(after.height).toBe(40);
    expect(after.exif).toBeUndefined();
    expect(after.orientation).toBeUndefined();
  });

  it('JPEG com GPS e sem orientação também é reencodado (GPS sai)', async () => {
    const jpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } })
      .jpeg()
      .withExif({ IFD3: { GPSLatitudeRef: 'S', GPSLatitude: '28/1 28/1 0/1' } })
      .toBuffer();
    const out = await convertImageToJpeg({ buffer: jpeg, mimeType: 'image/jpeg', fileName: 'a.jpg' });
    expect(out.buffer.equals(jpeg)).toBe(false);
    expect((await sharp(out.buffer).metadata()).exif).toBeUndefined();
  });

  it('JPEG sem orientação nem GPS fica byte a byte (caminho comum, sem custo)', async () => {
    const jpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } })
      .jpeg()
      .toBuffer();
    const input = { buffer: jpeg, mimeType: 'image/jpeg', fileName: 'foto.jpeg' };
    const out = await convertImageToJpeg(input);
    expect(out.buffer).toBe(jpeg);
    expect(out.fileName).toBe('foto.jpeg');
  });

  it('conteúdo JPEG declarado como PNG: bytes intactos, mas MIME e nome viram JPEG', async () => {
    const jpeg = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'red' } })
      .jpeg()
      .toBuffer();
    const out = await convertImageToJpeg({ buffer: jpeg, mimeType: 'image/png', fileName: 'print.png' });
    expect(out.buffer).toBe(jpeg);
    expect(out.mimeType).toBe('image/jpeg');
    expect(out.fileName).toBe('print.jpg');
  });

  it('GIF animado e WebP animado ficam no formato original', async () => {
    const gif = await sharp(await frames(), { join: { animated: true } }).gif({ delay: [100, 100] }).toBuffer();
    const webp = await sharp(await frames(), { join: { animated: true } }).webp({ delay: [100, 100] }).toBuffer();

    const outGif = await convertImageToJpeg({ buffer: gif, mimeType: 'image/gif', fileName: 'a.gif' });
    const outWebp = await convertImageToJpeg({ buffer: webp, mimeType: 'image/webp', fileName: 'a.webp' });
    expect(outGif).toEqual({ buffer: gif, mimeType: 'image/gif', fileName: 'a.gif' });
    expect(outWebp).toEqual({ buffer: webp, mimeType: 'image/webp', fileName: 'a.webp' });
  });

  it('GIF estático vira JPEG', async () => {
    const gif = await solid(8, 8, 'red').gif().toBuffer();
    const out = await convertImageToJpeg({ buffer: gif, mimeType: 'image/gif', fileName: 'a.gif' });
    expect(out.mimeType).toBe('image/jpeg');
  });

  it('keepOriginal (figurinha) não converte', async () => {
    const webp = await solid(16, 16, 'green').webp().toBuffer();
    const input = { buffer: webp, mimeType: 'image/webp', fileName: 'sticker.webp' };
    expect(await convertImageToJpeg(input, { keepOriginal: true })).toBe(input);
  });

  it('não-imagem passa direto', async () => {
    const input = { buffer: Buffer.from('%PDF-1.4'), mimeType: 'application/pdf', fileName: 'a.pdf' };
    expect(await convertImageToJpeg(input)).toBe(input);
  });

  it('imagem corrompida devolve o original, sem lançar', async () => {
    const png = await solid(20, 20, 'red').png().toBuffer();
    const truncated = png.subarray(0, 40);
    const input = { buffer: truncated, mimeType: 'image/png', fileName: 'quebrada.png' };
    await expect(convertImageToJpeg(input)).resolves.toBe(input);
    const lixo = { buffer: Buffer.from('nao e imagem'), mimeType: 'image/png', fileName: 'x.png' };
    await expect(convertImageToJpeg(lixo)).resolves.toBe(lixo);
  });

  it('HEIC que o sharp pré-compilado não decodifica fica no original', async () => {
    // Cabeçalho `ftyp heic` (o que o file-type reconhece). O libheif do sharp
    // pré-compilado só tem AV1 (AVIF), sem decoder HEVC — ver D-290.
    const heic = Buffer.concat([
      Buffer.from([0, 0, 0, 0x18]),
      Buffer.from('ftypheic'),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from('mif1heic'),
      Buffer.alloc(64),
    ]);
    const input = { buffer: heic, mimeType: 'image/heic', fileName: 'IMG_0001.HEIC' };
    await expect(convertImageToJpeg(input)).resolves.toBe(input);
    expect(sharp.format.heif.input.fileSuffix).not.toContain('.heic');
  });

  it('acima do limite de pixels fica no original', async () => {
    // PNG de 1 cor comprime a quase nada: 8000x8000 = 64 MP > MAX_INPUT_PIXELS.
    const side = Math.ceil(Math.sqrt(MAX_INPUT_PIXELS)) + 100;
    const huge = await sharp({ create: { width: side, height: side, channels: 3, background: 'white' } })
      .png({ compressionLevel: 9 })
      .toBuffer();
    const input = { buffer: huge, mimeType: 'image/png', fileName: 'enorme.png' };
    await expect(convertImageToJpeg(input)).resolves.toBe(input);
  }, 30_000);
});

describe('jpegFileName', () => {
  it('troca a extensão; sem nome vira imagem.jpg', () => {
    expect(jpegFileName('pedido.PNG')).toBe('pedido.jpg');
    expect(jpegFileName('sem-extensao')).toBe('sem-extensao.jpg');
    expect(jpegFileName('foto.tar.webp')).toBe('foto.tar.jpg');
    expect(jpegFileName('.png')).toBe('imagem.jpg');
  });
});
