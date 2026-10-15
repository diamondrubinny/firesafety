/**
 * Audible alert using the Web Audio API (no audio files, works offline).
 * Browsers only allow audio after a user gesture, so the operator must enable it once.
 */
const PREF_KEY = 'fs.sound.enabled';

export function loadSoundPref(): boolean {
  try {
    return window.localStorage.getItem(PREF_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveSoundPref(on: boolean): void {
  try {
    window.localStorage.setItem(PREF_KEY, on ? '1' : '0');
  } catch {
    // Storage may be unavailable (private mode); the preference just won't persist.
  }
}

export class AlarmSound {
  private ctx: AudioContext | null = null;
  private timer: ReturnType<typeof setInterval> | undefined;

  /** Must be called from a user gesture at least once. */
  async unlock(): Promise<boolean> {
    try {
      this.ctx ??= new AudioContext();
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return this.ctx.state === 'running';
    } catch {
      return false;
    }
  }

  get playing(): boolean {
    return this.timer !== undefined;
  }

  start(): void {
    if (this.timer || !this.ctx) return;
    const beep = () => {
      const ctx = this.ctx;
      if (!ctx || ctx.state !== 'running') return;
      for (const [offset, freq] of [[0, 880], [0.5, 660]] as const) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = freq;
        gain.gain.value = 0.08;
        osc.connect(gain).connect(ctx.destination);
        osc.start(ctx.currentTime + offset);
        osc.stop(ctx.currentTime + offset + 0.4);
      }
    };
    beep();
    this.timer = setInterval(beep, 1500);
  }

  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }
}
