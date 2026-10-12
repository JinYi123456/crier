/**
 * The room noise, made from oscillators rather than files.
 *
 * A pit is not silent and a screen that is silent does not feel like a room. Everything here is
 * synthesised when you ask for it, so the page carries no audio assets and nothing plays until a
 * person presses the bell - browsers will not let an ambient loop start any other way.
 *
 * The parts: a low crowd murmur whose loudness follows how much noise the houses are making this
 * round, a brass bell for the close, a wooden clack for a print, a stamp for a decision, and a chime
 * when a seller is paid.
 */

export type Cue = 'bell' | 'print' | 'shout' | 'stamp' | 'chime';

const HORN = [440, 587.33];

export class FloorSound {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private murmur: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private murmurSource: AudioBufferSourceNode | null = null;

  get live(): boolean {
    return this.context !== null;
  }

  /** Must be called from a click or a key press; a browser blocks anything else. */
  async enable(volume = 0.5): Promise<void> {
    if (this.context !== null) {
      await this.context.resume();
      return;
    }
    const Ctor: typeof AudioContext | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    const context = new Ctor();
    await context.resume();

    const master = context.createGain();
    master.gain.value = volume;
    master.connect(context.destination);

    const length = Math.floor(context.sampleRate * 2);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const channel = buffer.getChannelData(0);
    let last = 0;
    for (let index = 0; index < length; index += 1) {
      const white = Math.random() * 2 - 1;
      last = (last + 0.04 * white) / 1.04;
      channel[index] = last * 3.2;
    }

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    const lowpass = context.createBiquadFilter();
    lowpass.type = 'lowpass';
    lowpass.frequency.value = 620;
    const gain = context.createGain();
    gain.gain.value = 0;
    source.connect(lowpass).connect(gain).connect(master);
    source.start();

    this.context = context;
    this.master = master;
    this.murmur = gain;
    this.noise = buffer;
    this.murmurSource = source;
  }

  setVolume(volume: number): void {
    if (this.master && this.context) this.master.gain.setTargetAtTime(volume, this.context.currentTime, 0.1);
  }

  /** 0 = an empty floor, 1 = a shouting pit. */
  setMurmur(level: number): void {
    const clamped = Math.max(0, Math.min(1, level));
    if (this.murmur && this.context) {
      this.murmur.gain.setTargetAtTime(0.055 * clamped, this.context.currentTime, 0.35);
    }
  }

  cue(cue: Cue): void {
    const context = this.context;
    const master = this.master;
    if (!context || !master) return;
    const at = context.currentTime;
    if (cue === 'bell') this.tone(at, master, HORN, 1.9, 0.22, 'triangle');
    if (cue === 'chime') this.tone(at, master, [784, 1046.5], 0.9, 0.13, 'sine');
    if (cue === 'print') this.burst(at, master, 0.05, 0.2, 1800);
    if (cue === 'stamp') this.burst(at, master, 0.09, 0.26, 320);
    if (cue === 'shout') this.burst(at, master, 0.03, 0.06, 900);
  }

  private tone(at: number, master: GainNode, frequencies: readonly number[], seconds: number, peak: number, type: OscillatorType): void {
    const context = this.context;
    if (!context) return;
    frequencies.forEach((frequency, index) => {
      const osc = context.createOscillator();
      const gain = context.createGain();
      osc.type = type;
      osc.frequency.value = frequency;
      gain.gain.setValueAtTime(0, at + index * 0.03);
      gain.gain.linearRampToValueAtTime(peak, at + index * 0.03 + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0005, at + seconds);
      osc.connect(gain).connect(master);
      osc.start(at + index * 0.03);
      osc.stop(at + seconds + 0.05);
    });
  }

  private burst(at: number, master: GainNode, seconds: number, peak: number, cutoff: number): void {
    const context = this.context;
    if (!context || this.noise === null) return;
    const source = context.createBufferSource();
    source.buffer = this.noise;
    source.playbackRate.value = 1 + Math.random() * 0.4;
    const filter = context.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = cutoff;
    filter.Q.value = 0.9;
    const gain = context.createGain();
    gain.gain.setValueAtTime(peak, at);
    gain.gain.exponentialRampToValueAtTime(0.0005, at + seconds);
    source.connect(filter).connect(gain).connect(master);
    source.start(at, Math.random());
    source.stop(at + seconds + 0.02);
  }

  dispose(): void {
    this.murmurSource?.stop();
    void this.context?.close();
    this.context = null;
    this.master = null;
    this.murmur = null;
    this.murmurSource = null;
  }
}

/** One room, one set of speakers. */
export const floorSound = new FloorSound();

/** A short buzz for the two actions a person takes deliberately, where a phone has a motor. */
export function thump(pattern: number | number[]): void {
  const navigatorWithVibrate = navigator as Navigator & { vibrate?: (pattern: number | number[]) => boolean };
  navigatorWithVibrate.vibrate?.(pattern);
}
