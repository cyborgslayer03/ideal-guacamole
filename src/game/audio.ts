// Sound: every effect is synthesized with WebAudio (no audio files to load or
// license), and the music is generative: an ambient pad while exploring, with
// bass and drums in combat and an arpeggio lead for boss fights.
// Without an AudioContext (tests, very old browsers) everything is a no-op.

import type { Element } from '../core/types';

export const SFX = [
  'swing', 'hit', 'crit', 'cast', 'impact', 'explosion', 'beam', 'heal', 'shield', 'jump', 'dodge', 'teleport', 'leap',
  'webline', 'death', 'down', 'revive', 'charm', 'freeze', 'summon', 'thunder', 'sonic', 'ultimate', 'perfect',
  'levelup', 'loot', 'ui', 'banner',
] as const;
export type Sfx = (typeof SFX)[number];

export interface PlayOptions {
  element?: Element;
  /** -1 (left) to 1 (right). */
  pan?: number;
  /** 0-1 volume scale, e.g. for distance. */
  gain?: number;
}

export interface VolumeSettings {
  master: number;
  music: number;
  sfx: number;
}

/** 0 exploring, 1 combat, 2 boss fight. */
export type Intensity = 0 | 1 | 2;

/** Minimum seconds between two plays of the same sound, so rapid hits don't stack into noise. */
export const SFX_GAP: Partial<Record<Sfx, number>> = { hit: 0.045, crit: 0.06, impact: 0.05, swing: 0.04, beam: 0.15, ui: 0.03, explosion: 0.06 };
const MAX_VOICES = 28;

/** Which music layers play at each intensity. Pure, for tests. */
export function musicLayers(intensity: Intensity): { pad: boolean; bass: boolean; drums: boolean; lead: boolean } {
  return { pad: true, bass: intensity >= 1, drums: intensity >= 1, lead: intensity >= 2 };
}

const ELEMENT_FREQ: Record<Element, number> = {
  kinetic: 140, energy: 520, fire: 260, ice: 1300, lightning: 900, cosmic: 330, shadow: 150, psychic: 620, nature: 520, tech: 1100,
};

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private musicBus!: GainNode;
  private noiseBuf!: AudioBuffer;
  private lastPlayed = new Map<Sfx, number>();
  private voices = 0;
  private music: Music | null = null;
  private muted = false;
  /** Count of sounds started (for tests and debugging). */
  played = 0;

  constructor(private volumes: VolumeSettings) {}

  /** Browsers only allow audio after a user gesture; call this from one. */
  unlock() {
    if (!this.ctx) {
      const Ctor = typeof window !== 'undefined' ? (window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext) : undefined;
      if (!Ctor) return;
      try {
        this.ctx = new Ctor();
      } catch {
        return;
      }
      const ctx = this.ctx;
      this.master = ctx.createGain();
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      this.master.connect(comp).connect(ctx.destination);
      this.sfxBus = ctx.createGain();
      this.musicBus = ctx.createGain();
      this.sfxBus.connect(this.master);
      this.musicBus.connect(this.master);
      this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      this.applyVolumes();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  get available(): boolean {
    return !!this.ctx;
  }

  setVolumes(v: VolumeSettings) {
    this.volumes = { ...v };
    this.applyVolumes();
  }

  toggleMute(): boolean {
    this.muted = !this.muted;
    this.applyVolumes();
    return this.muted;
  }

  private applyVolumes() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volumes.master, t, 0.05);
    this.sfxBus.gain.setTargetAtTime(this.volumes.sfx, t, 0.05);
    this.musicBus.gain.setTargetAtTime(this.volumes.music * 0.6, t, 0.2);
  }

  // --- Music -------------------------------------------------------------------------

  startMusic() {
    if (!this.ctx || this.music) return;
    this.music = new Music(this.ctx, this.musicBus, this.noiseBuf);
  }

  stopMusic() {
    this.music?.stop();
    this.music = null;
  }

  setIntensity(i: Intensity) {
    if (this.music) this.music.intensity = i;
  }

  // --- Effects -----------------------------------------------------------------------

  play(name: Sfx, opts: PlayOptions = {}) {
    const ctx = this.ctx;
    if (!ctx || this.muted || ctx.state !== 'running') return;
    const now = ctx.currentTime;
    const gap = SFX_GAP[name] ?? 0.02;
    if (now - (this.lastPlayed.get(name) ?? -1) < gap || this.voices >= MAX_VOICES) return;
    this.lastPlayed.set(name, now);
    const out = ctx.createGain();
    out.gain.value = opts.gain ?? 1;
    let node: AudioNode = out;
    if (opts.pan && ctx.createStereoPanner) {
      const panner = ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, opts.pan));
      out.connect(panner);
      node = panner;
    }
    node.connect(this.sfxBus);
    this.voices++;
    this.played++;
    const life = this.recipe(name, now, out, opts.element ?? 'energy');
    setTimeout(() => {
      this.voices--;
      node.disconnect();
    }, (life + 0.1) * 1000);
  }

  /** Builds the sound; returns its length in seconds. */
  private recipe(name: Sfx, t: number, out: GainNode, el: Element): number {
    const f = ELEMENT_FREQ[el];
    switch (name) {
      case 'swing':
        return this.noise(t, 0.12, out, 0.22, 'bandpass', 1800, 600, 1.2);
      case 'hit':
        this.noise(t, 0.08, out, 0.35, 'lowpass', 1400, 300);
        return this.tone(t, 0.12, out, 0.4, 'sine', 170, 60);
      case 'crit':
        this.noise(t, 0.1, out, 0.4, 'lowpass', 2000, 400);
        this.tone(t, 0.12, out, 0.4, 'sine', 200, 60);
        return this.tone(t, 0.18, out, 0.12, 'square', 1500, 1300);
      case 'cast':
        return this.elementVoice(t, out, el, 1);
      case 'impact':
        this.noise(t, 0.12, out, 0.25, 'bandpass', f * 1.5, f * 0.6, 1.5);
        return this.tone(t, 0.1, out, 0.15, 'triangle', f, f * 0.5);
      case 'explosion':
        this.noise(t, 0.7, out, 0.55, 'lowpass', 1200, 90);
        return this.tone(t, 0.6, out, 0.55, 'sine', 90, 32);
      case 'beam':
        this.tone(t, 0.6, out, 0.12, 'sawtooth', f * 0.5, f * 0.55, 1200);
        return this.tone(t, 0.6, out, 0.08, 'square', f, f * 1.02, 2400);
      case 'heal':
      case 'revive':
        [523, 659, 784, 1046].forEach((n, i) => this.tone(t + i * 0.07, 0.35, out, 0.16, 'triangle', n, n));
        return 0.7;
      case 'shield':
        this.tone(t, 0.35, out, 0.2, 'sine', 300, 620);
        return this.tone(t, 0.35, out, 0.12, 'sine', 600, 1240);
      case 'jump':
        return this.tone(t, 0.12, out, 0.14, 'sine', 280, 620);
      case 'dodge':
        return this.noise(t, 0.16, out, 0.2, 'highpass', 900, 4000);
      case 'teleport':
        this.tone(t, 0.18, out, 0.16, 'square', 200, 2200, 3000);
        return this.tone(t + 0.05, 0.2, out, 0.14, 'sine', 2200, 300);
      case 'leap':
        this.noise(t, 0.25, out, 0.3, 'lowpass', 400, 200);
        return this.tone(t, 0.3, out, 0.25, 'sine', 90, 220);
      case 'webline':
        this.noise(t, 0.07, out, 0.25, 'highpass', 3500, 2500);
        return this.tone(t, 0.08, out, 0.12, 'sine', 1900, 900);
      case 'death':
        return this.tone(t, 0.6, out, 0.25, 'sawtooth', 320, 55, 900);
      case 'down':
        this.tone(t, 0.8, out, 0.25, 'sawtooth', 220, 40, 700);
        return this.tone(t, 0.8, out, 0.18, 'sine', 330, 110);
      case 'charm':
        return this.wobble(t, 0.6, out, 0.18, 640, 9, 90);
      case 'freeze':
        this.tone(t, 0.7, out, 0.2, 'sine', 2200, 380);
        return this.noise(t, 0.7, out, 0.12, 'highpass', 6000, 3000);
      case 'summon':
        [220, 277, 330, 440].forEach((n) => this.tone(t, 0.8, out, 0.08, 'triangle', n, n * 1.5, undefined, 0.25));
        return 0.8;
      case 'thunder':
        this.noise(t, 0.05, out, 0.5, 'highpass', 2500, 2500);
        this.noise(t + 0.03, 1.1, out, 0.5, 'lowpass', 900, 60);
        return 1.2;
      case 'sonic':
        return this.wobble(t, 0.45, out, 0.22, 900, 40, 300, 'sawtooth');
      case 'ultimate':
        this.noise(t, 1.2, out, 0.6, 'lowpass', 1800, 70);
        this.tone(t, 1.1, out, 0.6, 'sine', 120, 28);
        [220, 330, 440, 660].forEach((n) => this.tone(t, 1.2, out, 0.06, 'sawtooth', n, n * 2, 2500, 0.1));
        return 1.3;
      case 'perfect':
        this.tone(t, 0.5, out, 0.18, 'sine', 1568, 1568);
        return this.tone(t + 0.04, 0.5, out, 0.12, 'sine', 2349, 2349);
      case 'levelup':
        [523, 659, 784, 1046, 1318].forEach((n, i) => this.tone(t + i * 0.09, 0.5, out, 0.13, 'square', n, n, 3000));
        return 1;
      case 'loot':
        [784, 988, 1175, 1568].forEach((n, i) => this.tone(t + i * 0.06, 0.6, out, 0.14, 'triangle', n, n));
        return 0.9;
      case 'ui':
        return this.tone(t, 0.04, out, 0.06, 'sine', 950, 900);
      case 'banner':
        [262, 392, 523].forEach((n) => this.tone(t, 0.9, out, 0.05, 'triangle', n, n, undefined, 0.2));
        return 0.9;
    }
  }

  /** A power cast with a timbre per element. */
  private elementVoice(t: number, out: GainNode, el: Element, scale: number): number {
    const g = 0.22 * scale;
    switch (el) {
      case 'kinetic':
        this.noise(t, 0.18, out, g * 1.4, 'lowpass', 500, 150);
        return this.tone(t, 0.2, out, g * 1.4, 'sine', 140, 55);
      case 'energy':
        return this.tone(t, 0.2, out, g, 'square', 420, 980, 3500);
      case 'fire':
        this.noise(t, 0.4, out, g * 1.5, 'bandpass', 900, 250, 0.8);
        return this.tone(t, 0.35, out, g * 0.5, 'sawtooth', 110, 80, 600);
      case 'ice':
        this.tone(t, 0.35, out, g * 0.8, 'sine', 1300, 1900);
        return this.tone(t + 0.03, 0.35, out, g * 0.5, 'sine', 1950, 2600);
      case 'lightning':
        for (let i = 0; i < 5; i++) this.tone(t + i * 0.035, 0.04, out, g * 0.7, 'square', 1800 + Math.random() * 2400, 900);
        return this.noise(t, 0.22, out, g, 'highpass', 3000, 5000);
      case 'cosmic':
        [220, 277, 330].forEach((n) => this.tone(t, 0.5, out, g * 0.45, 'triangle', n, n * 2));
        return 0.5;
      case 'shadow':
        return this.tone(t, 0.45, out, g * 1.2, 'sawtooth', 190, 55, 700);
      case 'psychic':
        return this.wobble(t, 0.4, out, g, 620, 14, 120);
      case 'nature':
        this.tone(t, 0.25, out, g, 'triangle', 520, 500);
        return this.tone(t + 0.06, 0.25, out, g * 0.8, 'triangle', 780, 760);
      case 'tech':
        [1200, 1600, 1000].forEach((n, i) => this.tone(t + i * 0.05, 0.04, out, g * 0.7, 'square', n, n, 4000));
        return 0.2;
    }
  }

  private tone(t: number, dur: number, out: AudioNode, gain: number, type: OscillatorType, from: number, to: number, lowpass?: number, attack = 0.005): number {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    let src: AudioNode = osc;
    if (lowpass) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = lowpass;
      osc.connect(lp);
      src = lp;
    }
    src.connect(env).connect(out);
    osc.start(t);
    osc.stop(t + dur + 0.02);
    return dur;
  }

  private noise(t: number, dur: number, out: AudioNode, gain: number, type: BiquadFilterType, from: number, to: number, q = 0.7): number {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(from, t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(20, to), t + dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(env).connect(out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
    return dur;
  }

  /** A vibrato tone (psychic hums, sonic screams, charm). */
  private wobble(t: number, dur: number, out: AudioNode, gain: number, freq: number, rate: number, depth: number, type: OscillatorType = 'sine'): number {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = rate;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = depth;
    lfo.connect(lfoGain).connect(osc.frequency);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.03);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(env).connect(out);
    osc.start(t);
    lfo.start(t);
    osc.stop(t + dur + 0.02);
    lfo.stop(t + dur + 0.02);
    return dur;
  }
}

// --- Generative music -------------------------------------------------------------------

const BPM = 112;
const STEP = 60 / BPM / 4; // sixteenth notes
const A2 = 110;
/** i - VI - III - VII in A minor: Am, F, C, G (semitones from A, with chord tones). */
const PROGRESSION: { root: number; tones: number[] }[] = [
  { root: 0, tones: [0, 3, 7] },
  { root: -4, tones: [-4, 0, 3] },
  { root: 3, tones: [3, 7, 10] },
  { root: -2, tones: [-2, 2, 5] },
];
const hz = (semi: number, base = A2) => base * Math.pow(2, semi / 12);

class Music {
  intensity: Intensity = 0;
  private step = 0;
  private next: number;
  private timer: ReturnType<typeof setInterval>;
  private readonly out: GainNode;

  constructor(private readonly ctx: AudioContext, bus: GainNode, private readonly noiseBuf: AudioBuffer) {
    this.out = ctx.createGain();
    this.out.gain.setValueAtTime(0.0001, ctx.currentTime);
    this.out.gain.exponentialRampToValueAtTime(1, ctx.currentTime + 2);
    this.out.connect(bus);
    this.next = ctx.currentTime + 0.1;
    this.timer = setInterval(() => this.schedule(), 25);
  }

  stop() {
    clearInterval(this.timer);
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(0.0001, t, 0.3);
    setTimeout(() => this.out.disconnect(), 1500);
  }

  private schedule() {
    // Look ahead a little so timing stays tight even if the main thread hiccups.
    while (this.next < this.ctx.currentTime + 0.12) {
      this.playStep(this.step, this.next);
      this.next += STEP;
      this.step = (this.step + 1) % 64;
    }
  }

  private playStep(step: number, t: number) {
    const layers = musicLayers(this.intensity);
    const chord = PROGRESSION[Math.floor(step / 16)];
    const beat = step % 16;
    if (beat === 0 && layers.pad) for (const n of chord.tones) this.voice(t, STEP * 16, hz(n + 12), 0.035, 'sawtooth', 700, 0.6);
    if (layers.bass && beat % 2 === 0) this.voice(t, STEP * 1.8, hz(chord.root + (beat % 8 === 4 ? 12 : 0), 55), 0.12, 'sawtooth', 380, 0.01);
    if (layers.drums) {
      if (beat % 8 === 0 || (this.intensity >= 2 && beat % 4 === 0)) this.kick(t);
      if (beat % 8 === 4) this.hat(t, 0.16, 1800, 0.2);
      if (beat % 2 === 1) this.hat(t, 0.035, 7000, 0.05);
    }
    if (layers.lead) {
      const tone = chord.tones[[0, 1, 2, 1][beat % 4]];
      this.voice(t, STEP * 0.9, hz(tone + 24), 0.05, 'triangle', 4000, 0.005);
    }
  }

  private voice(t: number, dur: number, freq: number, gain: number, type: OscillatorType, cutoff: number, attack: number) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = cutoff;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + attack);
    env.gain.setValueAtTime(gain, t + Math.max(attack, dur * 0.6));
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(lp).connect(env).connect(this.out);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  private kick(t: number) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(130, t);
    osc.frequency.exponentialRampToValueAtTime(40, t + 0.15);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.35, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    osc.connect(env).connect(this.out);
    osc.start(t);
    osc.stop(t + 0.3);
  }

  private hat(t: number, dur: number, freq: number, gain: number) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = freq > 3000 ? 'highpass' : 'bandpass';
    f.frequency.value = freq;
    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(env).connect(this.out);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }
}

let shared: AudioEngine | null = null;

/** One engine for the whole app (browsers limit how many AudioContexts a page may open). */
export function audio(volumes?: VolumeSettings): AudioEngine {
  shared ??= new AudioEngine(volumes ?? { master: 0.8, music: 0.6, sfx: 0.9 });
  if (volumes) shared.setVolumes(volumes);
  return shared;
}
