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

const TIMEOUT_MS = 30_000;

export const convertAudioToOgg: AudioConverter = (input) =>
  new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-c:a', 'libopus', '-b:a', '32k', '-f', 'ogg', 'pipe:1'],
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
