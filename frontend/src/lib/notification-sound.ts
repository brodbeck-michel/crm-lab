/**
 * Som de mensagem nova (CRMLAB-72, D-241 item 7): tom sintético curto por
 * WebAudio, sem arquivo de terceiros e sem download. Dois bipes curtos
 * (880 Hz → 1320 Hz, ~180 ms no total) com envelope para não estalar.
 *
 * O `AudioContext` nasce na primeira chamada e é reaproveitado. Navegador sem
 * WebAudio, ou que recuse tocar (política de autoplay antes de qualquer
 * interação com a página), simplesmente fica em silêncio: o som é um extra.
 */

type AudioContextCtor = new () => AudioContext;

let context: AudioContext | null = null;

function audioContextCtor(): AudioContextCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

function beep(ctx: AudioContext, frequency: number, start: number, duration: number): void {
  const oscillator = ctx.createOscillator();
  const gain = ctx.createGain();
  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, start);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.18, start + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(gain);
  gain.connect(ctx.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

export function playNewMessageSound(): void {
  try {
    const Ctor = audioContextCtor();
    if (!Ctor) return;
    context ??= new Ctor();
    const ctx = context;
    if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    const now = ctx.currentTime;
    beep(ctx, 880, now, 0.08);
    beep(ctx, 1320, now + 0.1, 0.08);
  } catch {
    // Sem som — nada a fazer.
  }
}
