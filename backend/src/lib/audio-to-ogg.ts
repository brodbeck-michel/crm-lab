/**
 * Recado de voz do navegador (WebM) -> OGG/Opus para a API oficial da Meta
 * (CRMLAB-140, D-314 item 3). A Meta nao aceita `audio/webm`; o gateway do QR
 * converte sozinho (D-182), a Meta nao.
 *
 * Usa o binario `ffmpeg` da imagem (`apk add ffmpeg`, backend/Dockerfile) por
 * `child_process`, com entrada e saida em pipe: nada vai para o disco. Falha
 * (sem ffmpeg, arquivo invalido, timeout) LANCA — quem chama trata como falha
 * de envio (mensagem `failed`, "tentar de novo").
 */
import { spawn } from 'node:child_process';

export type AudioConverter = (input: Buffer) => Promise<Buffer>;

/** Recado de voz de minutos converte em menos de 1 s; 15 s cabe no orcamento de 60 s do envio. */
const TIMEOUT_MS = 15_000;

/**
 * Argumentos do ffmpeg (CRMLAB-147, D-319). O OGG padrao do muxer poe ~49
 * pacotes por pagina e o WhatsApp do iPhone nao toca ("erro ao reproduzir"); o
 * proprio WhatsApp grava ~10. Com `-page_duration 20000` (20 ms = 1 pacote
 * Opus por pagina), mono 48 kHz, perfil `voip` e sem metadados, toca no iPhone
 * e no Android — isolado por envio direto na API em 12/11/2026.
 */
export const FFMPEG_OGG_ARGS: readonly string[] = [
  '-hide_banner', '-loglevel', 'error',
  '-i', 'pipe:0',
  '-vn', '-map_metadata', '-1', '-fflags', '+bitexact',
  '-ac', '1', '-ar', '48000',
  '-c:a', 'libopus', '-b:a', '32k', '-application', 'voip',
  '-page_duration', '20000',
  '-f', 'ogg', 'pipe:1',
];

export const convertAudioToOgg: AudioConverter = (input) =>
  new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      [...FFMPEG_OGG_ARGS],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const chunks: Buffer[] = [];
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('ffmpeg: tempo esgotado na conversao do audio'));
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      // So o comeco: a mensagem do ffmpeg explica o erro sem encher o log.
      if (stderr.length < 500) stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`ffmpeg indisponivel: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks);
      if (code === 0 && output.byteLength > 0) resolve(output);
      else reject(new Error(`ffmpeg falhou (codigo ${String(code)}): ${stderr.trim().slice(0, 200)}`));
    });
    // Entrada fechada pelo ffmpeg antes do fim (arquivo invalido) nao derruba o processo.
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });
