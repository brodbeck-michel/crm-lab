/**
 * Armazenamento de mídia em disco (Onda 8 §4.1) — volume local, sem MinIO/S3
 * nesta onda (decisao do lead, 2026-09-05). Trocar por S3 depois e substituir
 * SO ESTE ARQUIVO: nada mais no dominio conhece o caminho em disco.
 *
 * O arquivo tem o nome do `id` da linha de `message_media` — NUNCA o nome que
 * o usuario mandou (`fileName`), que e travessia de diretorio pronta
 * (`../../etc/passwd`). `path.join` + um id de UUID valido (gerado pelo
 * proprio Postgres, nunca aceito de fora) fecha essa porta na origem.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';

export function mediaFilePath(id: string): string {
  return path.join(env.MEDIA_DIR, id);
}

export async function writeMediaFile(id: string, buffer: Buffer): Promise<void> {
  await mkdir(env.MEDIA_DIR, { recursive: true });
  await writeFile(mediaFilePath(id), buffer);
}

export async function readMediaFile(id: string): Promise<Buffer> {
  return readFile(mediaFilePath(id));
}
