// Sound: every effect is synthesized with WebAudio (no audio files to load or
// license). Impacts are layered (a sharp transient, a saturated body, a sub
// boom, and a debris tail), sent through a room reverb tuned per world, and
// big hits briefly duck the music. Each biome has its own ambient bed, and the
// generative score shifts gears with the action: an ambient pad and pluck
// while exploring, driving drums, bass and power chords in combat, and a
// faster four-on-the-floor with toms and a choir for bosses.
// Without an AudioContext (tests, very old browsers) everything is a no-op.

import type { Biome, Element } from '../core/types';

export const SFX = [
  'swing', 'hit', 'crit', 'cast', 'impact', 'explosion', 'beam', 'heal', 'shield', 'jump', 'dodge', 'teleport', 'leap',
  'webline', 'death', 'down', 'revive', 'charm', 'freeze', 'summon', 'thunder', 'sonic', 'ultimate', 'perfect',
  'levelup', 'loot', 'ui', 'banner', 'scream', 'cheer', 'gasp', 'photo', 'honk', 'riser', 'stinger', 'victory', 'smash',
] as const;
export type Sfx = (typeof SFX)[number];

export interface PlayOptions {
  element?: Element;
  /** -1 (left) to 1 (right). */
  pan?: number;
  /** 0-1 volume scale, e.g. for distance. */
  gain?: number;
  /** Voice variety for screams and cheers (species). */
  voice?: 'human' | 'alien' | 'demon' | 'spirit';
}

export interface VolumeSettings {
  master: number;
  music: number;
  sfx: number;
}

/** 0 exploring, 1 combat, 2 boss fight. */
export type Intensity = 0 | 1 | 2;

/** Minimum seconds between two plays of the same sound, so rapid hits don't stack into noise. */
export const SFX_GAP: Partial<Record<Sfx, number>> = {
  hit: 0.045, crit: 0.06, impact: 0.05, swing: 0.04, beam: 0.15, ui: 0.03, explosion: 0.06, scream: 0.25, cheer: 0.4, gasp: 0.2, honk: 0.5, photo: 0.3, smash: 0.08,
};
const MAX_VOICES = 32;

/** Which music layers play at each intensity. Pure, for tests. */
export function musicLayers(intensity: Intensity): { pad: boolean; pluck: boolean; bass: boolean; drums: boolean; chords: boolean; lead: boolean; choir: boolean } {
  return { pad: true, pluck: intensity === 0, bass: intensity >= 1, drums: intensity >= 1, chords: intensity >= 1, lead: intensity >= 2, choir: intensity >= 2 };
}

/** Beats per minute by intensity. */
export function musicTempo(intensity: Intensity): number {
  return [96, 128, 140][intensity];
}

/** Reverb and ambience character per world. */
export const ENVIRONMENTS: Record<Biome, { decay: number; wet: number }> = {
  metropolis: { decay: 1.4, wet: 0.16 },
  cosmic: { decay: 3.6, wet: 0.32 },
  mystic: { decay: 2.8, wet: 0.28 },
  wasteland: { decay: 1.1, wet: 0.1 },
  frozen: { decay: 2.2, wet: 0.22 },
  jungle: { decay: 1.0, wet: 0.12 },
  underworld: { decay: 3.2, wet: 0.3 },
};

const ELEMENT_FREQ: Record<Element, number> = {
  kinetic: 140, energy: 520, fire: 260, ice: 1300, lightning: 900, cosmic: 330, shadow: 150, psychic: 620, nature: 520, tech: 1100,
};

/** Big sounds that should shake the mix. */
const HEAVY: ReadonlySet<Sfx> = new Set(['explosion', 'ultimate', 'thunder', 'smash', 'stinger']);

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfxBus!: GainNode;
  private musicBus!: GainNode;
  private duckGain!: GainNode;
  private ambienceBus!: GainNode;
  private reverb!: ConvolverNode;
  private reverbSend!: GainNode;
  private noiseBuf!: AudioBuffer;
  private lastPlayed = new Map<Sfx, number>();
  private voices = 0;
  private music: Music | null = null;
  private ambience: Ambience | null = null;
  private biome: Biome = 'metropolis';
  private muted = false;
  /** Per-play pitch multiplier (small random variation). */
  private pitch = 1;
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
      comp.threshold.value = -12;
      comp.ratio.value = 5;
      comp.attack.value = 0.003;
      comp.release.value = 0.2;
      this.master.connect(comp).connect(ctx.destination);
      this.sfxBus = ctx.createGain();
      this.musicBus = ctx.createGain();
      this.duckGain = ctx.createGain();
      this.ambienceBus = ctx.createGain();
      this.sfxBus.connect(this.master);
      this.musicBus.connect(this.duckGain).connect(this.master);
      this.ambienceBus.connect(this.master);
      // Shared room reverb: effects and music send into it.
      this.reverb = ctx.createConvolver();
      this.reverbSend = ctx.createGain();
      this.reverbSend.connect(this.reverb).connect(this.master);
      this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      this.setEnvironment(this.biome);
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
    this.ambienceBus.gain.setTargetAtTime(this.volumes.sfx * 0.5, t, 0.2);
    this.musicBus.gain.setTargetAtTime(this.volumes.music * 0.6, t, 0.2);
  }

  /** Tunes the reverb to the world (a vast station in space, a cramped jungle...). */
  setEnvironment(biome: Biome) {
    this.biome = biome;
    if (!this.ctx) return;
    const env = ENVIRONMENTS[biome];
    this.reverb.buffer = impulseResponse(this.ctx, env.decay);
    this.reverbSend.gain.setTargetAtTime(env.wet, this.ctx.currentTime, 0.1);
  }

  /** Briefly pulls the music down so a big hit cuts through. */
  duck(amount = 0.45, seconds = 0.5) {
    if (!this.ctx) return;
    const g = this.duckGain.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(1 - amount, t + 0.02);
    g.setTargetAtTime(1, t + 0.05, seconds / 3);
  }

  // --- Music and ambience --------------------------------------------------------------

  startMusic() {
    if (!this.ctx || this.music) return;
    this.music = new Music(this.ctx, this.musicBus, this.reverbSend, this.noiseBuf, this.shaperFor(this.musicBus), this.biome);
  }

  stopMusic() {
    this.music?.stop();
    this.music = null;
    this.ambience?.stop();
    this.ambience = null;
  }

  setIntensity(i: Intensity) {
    if (this.music) this.music.setIntensity(i);
  }

  /** Starts the world's ambient bed (city hum, space drone, underworld rumble...). */
  startAmbience(biome: Biome) {
    if (!this.ctx) return;
    this.ambience?.stop();
    this.ambience = new Ambience(this.ctx, this.ambienceBus, this.reverbSend, this.noiseBuf, biome);
  }

  private shaperFor(dest: AudioNode): WaveShaperNode {
    const s = this.ctx!.createWaveShaper();
    s.curve = saturationCurve(6);
    s.connect(dest);
    return s;
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
    // Every sound gets some room; heavy ones get more.
    const send = ctx.createGain();
    send.gain.value = HEAVY.has(name) ? 0.9 : 0.35;
    node.connect(send).connect(this.reverbSend);
    this.voices++;
    this.played++;
    this.pitch = 0.92 + Math.random() * 0.16;
    if (HEAVY.has(name)) this.duck(name === 'ultimate' || name === 'stinger' ? 0.6 : 0.4, 0.6);
    const life = this.recipe(name, now, out, opts.element ?? 'energy', opts.voice ?? 'human');
    setTimeout(() => {
      this.voices--;
      node.disconnect();
      send.disconnect();
    }, (life + 0.2) * 1000);
  }

  /** Heavy layers go through saturation into this sound's output. */
  private heavy(out: AudioNode): AudioNode {
    const s = this.ctx!.createWaveShaper();
    s.curve = saturationCurve(4);
    s.connect(out);
    return s;
  }

  /** Builds the sound; returns its length in seconds. */
  private recipe(name: Sfx, t: number, out: GainNode, el: Element, voice: NonNullable<PlayOptions['voice']>): number {
    const f = ELEMENT_FREQ[el];
    switch (name) {
      case 'swing':
        // A fast whoosh that sweeps down.
        this.noise(t, 0.16, out, 0.3, 'bandpass', 2600, 500, 1.4);
        return this.noise(t, 0.08, out, 0.12, 'highpass', 6000, 3000);
      case 'hit': {
        // Crack + saturated thump + short tail.
        this.noise(t, 0.012, out, 0.6, 'highpass', 4000, 4000);
        const body = this.heavy(out);
        this.tone(t, 0.14, body, 0.55, 'sine', 190, 55);
        this.noise(t, 0.12, out, 0.3, 'lowpass', 1800, 250);
        return 0.16;
      }
      case 'crit': {
        this.noise(t, 0.015, out, 0.8, 'highpass', 3500, 3500);
        const body = this.heavy(out);
        this.tone(t, 0.2, body, 0.7, 'sine', 220, 45);
        this.tone(t, 0.22, body, 0.3, 'triangle', 110, 40);
        this.noise(t, 0.2, out, 0.4, 'lowpass', 2500, 300);
        // A metallic ring on top.
        this.tone(t, 0.35, out, 0.12, 'square', 1800, 1650, 5000);
        return 0.35;
      }
      case 'cast':
        return this.elementVoice(t, out, el, 1);
      case 'impact':
        this.noise(t, 0.01, out, 0.4, 'highpass', 3000, 3000);
        this.noise(t, 0.16, out, 0.3, 'bandpass', f * 1.5, f * 0.5, 1.5);
        return this.tone(t, 0.12, this.heavy(out), 0.25, 'triangle', f * 0.7, f * 0.3);
      case 'explosion': {
        // Transient, saturated body, sub boom, then crackling debris.
        this.noise(t, 0.02, out, 0.9, 'highpass', 2500, 2500);
        const body = this.heavy(out);
        this.noise(t, 0.9, body, 0.7, 'lowpass', 1600, 70);
        this.tone(t, 0.9, out, 0.75, 'sine', 85, 26);
        for (let i = 0; i < 6; i++) this.noise(t + 0.15 + Math.random() * 0.5, 0.05, out, 0.08, 'bandpass', 2000 + Math.random() * 3000, 1500, 3);
        return 1.0;
      }
      case 'smash':
        // Wood, metal and glass breaking.
        this.noise(t, 0.02, out, 0.7, 'highpass', 3000, 3000);
        this.noise(t, 0.35, this.heavy(out), 0.5, 'lowpass', 1200, 150);
        for (let i = 0; i < 8; i++) this.tone(t + Math.random() * 0.25, 0.12, out, 0.05, 'sine', 2500 + Math.random() * 3500, 2000 + Math.random() * 3000);
        return 0.5;
      case 'beam':
        this.tone(t, 0.6, out, 0.13, 'sawtooth', f * 0.5, f * 0.55, 1400);
        this.tone(t, 0.6, out, 0.13, 'sawtooth', f * 0.505, f * 0.56, 1400);
        this.noise(t, 0.6, out, 0.08, 'bandpass', f * 2, f * 2.2, 2);
        return this.tone(t, 0.6, out, 0.07, 'square', f, f * 1.02, 2600);
      case 'heal':
      case 'revive':
        [523, 659, 784, 1046, 1318].forEach((n, i) => this.tone(t + i * 0.06, 0.45, out, 0.14, 'triangle', n, n));
        return 0.8;
      case 'shield':
        this.tone(t, 0.4, out, 0.2, 'sine', 300, 620);
        this.tone(t, 0.4, out, 0.12, 'sine', 600, 1240);
        return this.noise(t, 0.3, out, 0.06, 'highpass', 5000, 8000);
      case 'jump':
        this.noise(t, 0.08, out, 0.12, 'bandpass', 800, 1600, 1);
        return this.tone(t, 0.12, out, 0.14, 'sine', 260, 620);
      case 'dodge':
        // Air rush with a pitched whoosh.
        this.noise(t, 0.22, out, 0.32, 'bandpass', 600, 3800, 1.2);
        return this.noise(t, 0.12, out, 0.1, 'highpass', 4000, 7000);
      case 'teleport':
        this.tone(t, 0.18, out, 0.18, 'square', 200, 2400, 3000);
        this.tone(t + 0.05, 0.25, out, 0.15, 'sine', 2400, 300);
        return this.noise(t, 0.2, out, 0.1, 'highpass', 6000, 2000);
      case 'leap':
        this.noise(t, 0.3, out, 0.35, 'lowpass', 500, 200);
        return this.tone(t, 0.35, this.heavy(out), 0.3, 'sine', 80, 230);
      case 'webline':
        this.noise(t, 0.07, out, 0.3, 'highpass', 3800, 2500);
        return this.tone(t, 0.08, out, 0.14, 'sine', 2000, 900);
      case 'death':
        this.tone(t, 0.6, out, 0.25, 'sawtooth', 320, 55, 900);
        return this.noise(t, 0.4, out, 0.15, 'lowpass', 800, 100);
      case 'down':
        this.tone(t, 0.8, out, 0.25, 'sawtooth', 220, 40, 700);
        return this.tone(t, 0.8, out, 0.18, 'sine', 330, 110);
      case 'charm':
        return this.wobble(t, 0.6, out, 0.18, 640, 9, 90);
      case 'freeze':
        this.tone(t, 0.7, out, 0.2, 'sine', 2200, 380);
        this.tone(t, 0.9, out, 0.08, 'sine', 3300, 3300);
        return this.noise(t, 0.7, out, 0.12, 'highpass', 6000, 3000);
      case 'summon':
        [220, 277, 330, 440].forEach((n) => this.tone(t, 0.9, out, 0.08, 'triangle', n, n * 1.5, undefined, 0.25));
        return 0.9;
      case 'thunder':
        this.noise(t, 0.04, out, 0.8, 'highpass', 2500, 2500);
        this.noise(t + 0.02, 1.3, this.heavy(out), 0.6, 'lowpass', 1000, 50);
        this.tone(t, 1, out, 0.4, 'sine', 70, 30);
        return 1.4;
      case 'sonic':
        this.wobble(t, 0.5, out, 0.22, 900, 40, 300, 'sawtooth');
        return this.noise(t, 0.5, out, 0.15, 'bandpass', 1200, 400, 2);
      case 'ultimate': {
        // A rising whoosh into a massive saturated boom with a chord blooming over it.
        this.noise(t, 0.25, out, 0.3, 'highpass', 800, 6000);
        const body = this.heavy(out);
        this.noise(t + 0.2, 1.4, body, 0.8, 'lowpass', 2000, 60);
        this.tone(t + 0.2, 1.3, out, 0.8, 'sine', 110, 25);
        [220, 330, 440, 554, 660].forEach((n) => this.tone(t + 0.2, 1.4, out, 0.06, 'sawtooth', n, n * 1.01, 2800, 0.15));
        return 1.6;
      }
      case 'perfect':
        this.tone(t, 0.6, out, 0.18, 'sine', 1568, 1568);
        return this.tone(t + 0.04, 0.6, out, 0.12, 'sine', 2349, 2349);
      case 'levelup':
        [523, 659, 784, 1046, 1318].forEach((n, i) => this.tone(t + i * 0.09, 0.55, out, 0.13, 'square', n, n, 3000));
        return 1.1;
      case 'loot':
        [784, 988, 1175, 1568].forEach((n, i) => this.tone(t + i * 0.06, 0.6, out, 0.14, 'triangle', n, n));
        return 0.9;
      case 'ui':
        return this.tone(t, 0.04, out, 0.06, 'sine', 950, 900);
      case 'banner':
        [262, 392, 523].forEach((n) => this.tone(t, 1, out, 0.05, 'triangle', n, n, undefined, 0.2));
        return 1;
      case 'riser':
        // Tension before a boss phase: noise and a saw sweeping up.
        this.noise(t, 1.4, out, 0.25, 'bandpass', 300, 6000, 2);
        this.tone(t, 1.4, out, 0.1, 'sawtooth', 110, 880, 3000, 1.2);
        return 1.5;
      case 'stinger': {
        // A brass-like hit with a drum boom: something big just happened.
        const body = this.heavy(out);
        [98, 147, 196, 233].forEach((n) => this.tone(t, 1.1, body, 0.12, 'sawtooth', n, n * 0.98, 1800, 0.02));
        this.tone(t, 0.8, out, 0.6, 'sine', 70, 30);
        this.noise(t, 0.6, out, 0.3, 'lowpass', 900, 80);
        return 1.2;
      }
      case 'victory':
        // Fanfare: a rising major arpeggio landing on a big chord.
        [392, 523, 659].forEach((n, i) => this.tone(t + i * 0.12, 0.3, out, 0.14, 'sawtooth', n, n, 3000, 0.01));
        [523, 659, 784, 1046].forEach((n) => this.tone(t + 0.4, 1.4, out, 0.09, 'sawtooth', n, n, 3500, 0.03));
        this.tone(t + 0.4, 1, out, 0.4, 'sine', 65, 40);
        return 1.9;
      case 'scream':
        return this.scream(t, out, voice);
      case 'gasp':
        return this.noise(t, 0.25, out, 0.18, 'bandpass', voice === 'demon' ? 500 : 1400, voice === 'demon' ? 300 : 900, 3);
      case 'cheer': {
        // A little crowd: several voices and claps.
        for (let i = 0; i < 5; i++) this.voiceTone(t + Math.random() * 0.25, 0.5 + Math.random() * 0.3, out, 0.05, voice, 1.2 + Math.random() * 0.6);
        for (let i = 0; i < 10; i++) this.noise(t + Math.random() * 0.9, 0.03, out, 0.12, 'bandpass', 1800 + Math.random() * 1500, 1500, 1.5);
        return 1.2;
      }
      case 'photo':
        this.noise(t, 0.02, out, 0.18, 'highpass', 5000, 5000);
        return this.noise(t + 0.06, 0.03, out, 0.12, 'highpass', 4000, 4000);
      case 'honk':
        this.tone(t, 0.35, out, 0.12, 'square', 415, 415, 2000);
        return this.tone(t, 0.35, out, 0.1, 'square', 523, 523, 2000);
    }
  }

  /** A panicked scream, pitched and colored by species. */
  private scream(t: number, out: AudioNode, voice: NonNullable<PlayOptions['voice']>): number {
    const base = voice === 'demon' ? 180 : voice === 'alien' ? 900 : voice === 'spirit' ? 700 : 500 + Math.random() * 400;
    this.voiceTone(t, 0.7, out, 0.12, voice, base / 500);
    if (voice === 'demon') this.noise(t, 0.6, out, 0.1, 'lowpass', 600, 200);
    return 0.8;
  }

  /** A vocal-ish tone: a saw through a sweeping formant filter with vibrato. */
  private voiceTone(t: number, dur: number, out: AudioNode, gain: number, voice: NonNullable<PlayOptions['voice']>, k: number) {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = voice === 'spirit' ? 'sine' : 'sawtooth';
    const f0 = 500 * k * this.pitch;
    osc.frequency.setValueAtTime(f0, t);
    osc.frequency.linearRampToValueAtTime(f0 * 1.25, t + dur * 0.3);
    osc.frequency.linearRampToValueAtTime(f0 * 0.8, t + dur);
    const vib = ctx.createOscillator();
    vib.frequency.value = voice === 'alien' ? 28 : 6;
    const vibGain = ctx.createGain();
    vibGain.gain.value = voice === 'alien' ? f0 * 0.3 : f0 * 0.03;
    vib.connect(vibGain).connect(osc.frequency);
    const formant = ctx.createBiquadFilter();
    formant.type = 'bandpass';
    formant.Q.value = 4;
    formant.frequency.setValueAtTime(voice === 'demon' ? 500 : 1100, t);
    formant.frequency.linearRampToValueAtTime(voice === 'demon' ? 700 : 1600, t + dur * 0.4);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + 0.04);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(formant).connect(env).connect(out);
    osc.start(t);
    vib.start(t);
    osc.stop(t + dur + 0.02);
    vib.stop(t + dur + 0.02);
  }

  /** A power cast with a timbre per element. */
  private elementVoice(t: number, out: GainNode, el: Element, scale: number): number {
    const g = 0.24 * scale;
    switch (el) {
      case 'kinetic':
        this.noise(t, 0.2, this.heavy(out), g * 1.5, 'lowpass', 600, 150);
        return this.tone(t, 0.2, out, g * 1.4, 'sine', 150, 50);
      case 'energy':
        this.tone(t, 0.22, out, g, 'square', 420, 1100, 3500);
        return this.tone(t, 0.22, out, g * 0.6, 'sawtooth', 210, 560, 2500);
      case 'fire':
        this.noise(t, 0.45, out, g * 1.6, 'bandpass', 1000, 220, 0.8);
        return this.tone(t, 0.4, this.heavy(out), g * 0.5, 'sawtooth', 110, 70, 600);
      case 'ice':
        this.tone(t, 0.4, out, g * 0.8, 'sine', 1300, 2000);
        this.tone(t + 0.03, 0.4, out, g * 0.5, 'sine', 1950, 2700);
        return this.noise(t, 0.3, out, g * 0.4, 'highpass', 7000, 9000);
      case 'lightning':
        for (let i = 0; i < 6; i++) this.tone(t + i * 0.03, 0.04, out, g * 0.7, 'square', 1800 + Math.random() * 2600, 900);
        return this.noise(t, 0.25, out, g * 1.2, 'highpass', 3000, 5500);
      case 'cosmic':
        [220, 277, 330, 415].forEach((n) => this.tone(t, 0.55, out, g * 0.4, 'triangle', n, n * 2));
        return 0.55;
      case 'shadow':
        this.tone(t, 0.5, this.heavy(out), g * 1.1, 'sawtooth', 190, 50, 700);
        return this.noise(t, 0.4, out, g * 0.5, 'lowpass', 500, 120);
      case 'psychic':
        return this.wobble(t, 0.45, out, g, 620, 14, 140);
      case 'nature':
        this.tone(t, 0.28, out, g, 'triangle', 520, 500);
        return this.tone(t + 0.06, 0.28, out, g * 0.8, 'triangle', 780, 760);
      case 'tech':
        [1200, 1600, 1000, 1800].forEach((n, i) => this.tone(t + i * 0.045, 0.04, out, g * 0.7, 'square', n, n, 4000));
        return 0.22;
    }
  }

  private tone(t: number, dur: number, out: AudioNode, gain: number, type: OscillatorType, from: number, to: number, lowpass?: number, attack = 0.005): number {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from * this.pitch, t);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, to * this.pitch), t + dur);
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
    src.playbackRate.value = this.pitch;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.Q.value = q;
    filter.frequency.setValueAtTime(from * this.pitch, t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(20, to * this.pitch), t + dur);
    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filter).connect(env).connect(out);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.02);
    return dur;
  }

  /** A vibrato tone (psychic hums, sonic screams, charm). */
  private wobble(t: number, dur: number, out: AudioNode, gain: number, freq: number, rate: number, depth: number, type: OscillatorType = 'sine'): number {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq * this.pitch;
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

/** A soft-clipping curve: higher `amount` drives harder. */
export function saturationCurve(amount: number, samples = 1024): Float32Array<ArrayBuffer> {
  const curve = new Float32Array(new ArrayBuffer(samples * 4));
  const k = amount;
  for (let i = 0; i < samples; i++) {
    const x = (i / (samples - 1)) * 2 - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}

/** A synthetic room: decaying stereo noise, `decay` seconds long. */
function impulseResponse(ctx: BaseAudioContext, decay: number): AudioBuffer {
  const length = Math.floor(ctx.sampleRate * decay);
  const buf = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2.6);
  }
  return buf;
}

// --- Generative music -------------------------------------------------------------------

const A2 = 110;
const hz = (semi: number, base = A2) => base * Math.pow(2, semi / 12);

interface Chord {
  root: number;
  tones: number[];
}

/** Each world has its own mood: dark Phrygian in the underworld, bright and floating in space. */
function progressionFor(biome: Biome): Chord[] {
  switch (biome) {
    case 'underworld':
      return [{ root: 0, tones: [0, 3, 7] }, { root: 1, tones: [1, 5, 8] }, { root: 0, tones: [0, 3, 7] }, { root: -2, tones: [-2, 1, 5] }];
    case 'cosmic':
    case 'mystic':
      return [{ root: 0, tones: [0, 4, 7] }, { root: 2, tones: [2, 6, 9] }, { root: 7, tones: [7, 11, 14] }, { root: 5, tones: [5, 9, 12] }];
    case 'frozen':
      return [{ root: 0, tones: [0, 3, 7] }, { root: 5, tones: [5, 8, 12] }, { root: 3, tones: [3, 7, 10] }, { root: -2, tones: [-2, 2, 5] }];
    default:
      // i - VI - III - VII: the classic heroic minor.
      return [{ root: 0, tones: [0, 3, 7] }, { root: -4, tones: [-4, 0, 3] }, { root: 3, tones: [3, 7, 10] }, { root: -2, tones: [-2, 2, 5] }];
  }
}

class Music {
  private intensity: Intensity = 0;
  /** Intensity requested; applied on the next bar with a fill and crash. */
  private pending: Intensity = 0;
  private step = 0;
  private next: number;
  private timer: ReturnType<typeof setInterval>;
  private readonly out: GainNode;
  /** Pad and chords route here so kicks can pump them. */
  private readonly pump: GainNode;
  private readonly progression: Chord[];

  constructor(
    private readonly ctx: AudioContext,
    bus: GainNode,
    private readonly verb: AudioNode,
    private readonly noiseBuf: AudioBuffer,
    private readonly drive: AudioNode,
    biome: Biome,
  ) {
    this.progression = progressionFor(biome);
    this.out = ctx.createGain();
    this.out.gain.setValueAtTime(0.0001, ctx.currentTime);
    this.out.gain.exponentialRampToValueAtTime(1, ctx.currentTime + 2);
    this.out.connect(bus);
    this.pump = ctx.createGain();
    this.pump.connect(this.out);
    this.next = ctx.currentTime + 0.1;
    this.timer = setInterval(() => this.schedule(), 25);
  }

  setIntensity(i: Intensity) {
    this.pending = i;
  }

  stop() {
    clearInterval(this.timer);
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(0.0001, t, 0.3);
    setTimeout(() => this.out.disconnect(), 1500);
  }

  private stepLength(): number {
    return 60 / musicTempo(this.intensity) / 4;
  }

  private schedule() {
    while (this.next < this.ctx.currentTime + 0.12) {
      this.playStep(this.step, this.next);
      this.next += this.stepLength();
      this.step = (this.step + 1) % 64;
    }
  }

  private playStep(step: number, t: number) {
    const beat = step % 16;
    // Gear changes land on the downbeat, announced by a fill on the bar before.
    if (beat === 12 && this.pending > this.intensity) this.fill(t);
    if (beat === 0 && this.pending !== this.intensity) {
      const rising = this.pending > this.intensity;
      this.intensity = this.pending;
      if (rising) this.crash(t);
    }
    const layers = musicLayers(this.intensity);
    const chord = this.progression[Math.floor(step / 16)];
    const len = this.stepLength();
    if (beat === 0 && layers.pad) for (const n of chord.tones) this.voice(t, len * 16, hz(n + 12), 0.03, 'sawtooth', 900, 0.5, this.pump);
    if (layers.pluck && beat % 2 === 0) {
      const tone = chord.tones[[0, 1, 2, 1, 0, 2, 1, 2][beat / 2]];
      this.voice(t, len * 1.5, hz(tone + 24), 0.04, 'triangle', 3000, 0.003, this.out, true);
    }
    if (layers.bass && beat % 2 === 0) {
      const oct = beat % 8 === 6 ? 12 : 0;
      this.voice(t, len * 1.7, hz(chord.root + oct, 55), 0.16, 'sawtooth', 420, 0.005, this.drive);
    }
    if (layers.chords && (beat === 0 || beat === 6 || beat === 10)) {
      // Power chord stab: root and fifth, driven hard.
      for (const n of [chord.root, chord.root + 7, chord.root + 12]) this.voice(t, len * (beat === 0 ? 3 : 1.5), hz(n + 12), 0.035, 'sawtooth', 2200, 0.004, this.drive);
    }
    if (layers.drums) {
      const four = this.intensity >= 2;
      if (beat % 8 === 0 || (four && beat % 4 === 0) || beat === 10) this.kick(t);
      if (beat % 8 === 4) this.snare(t);
      if (beat % 2 === 1 || (four && beat % 2 === 0)) this.hat(t, 0.03, 8000, four ? 0.06 : 0.045);
      if (four && step % 64 >= 60) this.tom(t, 220 - (step % 4) * 30);
    }
    if (layers.lead) {
      const tone = chord.tones[[0, 1, 2, 1][beat % 4]] + (beat >= 8 ? 12 : 0);
      this.voice(t, len * 0.9, hz(tone + 24), 0.045, 'square', 3500, 0.003, this.out, true);
    }
    if (layers.choir && beat === 0) {
      for (const n of chord.tones) this.choir(t, len * 16, hz(n + 12));
    }
  }

  private voice(t: number, dur: number, freq: number, gain: number, type: OscillatorType, cutoff: number, attack: number, dest: AudioNode, verb = false) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    osc.detune.value = (Math.random() - 0.5) * 8;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = cutoff;
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + attack);
    env.gain.setValueAtTime(gain, t + Math.max(attack, dur * 0.6));
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(lp).connect(env).connect(dest);
    if (verb) env.connect(this.verb);
    osc.start(t);
    osc.stop(t + dur + 0.05);
  }

  /** Breathy "aah" voices for boss fights. */
  private choir(t: number, dur: number, freq: number) {
    const ctx = this.ctx;
    for (const detune of [-7, 7]) {
      const osc = ctx.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.value = freq;
      osc.detune.value = detune;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 800;
      f.Q.value = 3;
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(0.04, t + 0.6);
      env.gain.setValueAtTime(0.04, t + dur * 0.7);
      env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      osc.connect(f).connect(env).connect(this.out);
      env.connect(this.verb);
      osc.start(t);
      osc.stop(t + dur + 0.05);
    }
  }

  private kick(t: number) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(150, t);
    osc.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.5, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
    osc.connect(env).connect(this.drive);
    osc.start(t);
    osc.stop(t + 0.32);
    this.click(t, 0.12);
    // Pump the pads and chords around each kick.
    const p = this.pump.gain;
    p.setValueAtTime(0.35, t);
    p.linearRampToValueAtTime(1, t + 0.22);
  }

  private snare(t: number) {
    this.hat(t, 0.18, 1900, 0.28, 'bandpass', true);
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(240, t);
    osc.frequency.exponentialRampToValueAtTime(160, t + 0.08);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.18, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
    osc.connect(env).connect(this.out);
    osc.start(t);
    osc.stop(t + 0.12);
  }

  private tom(t: number, freq: number) {
    const ctx = this.ctx;
    const osc = ctx.createOscillator();
    osc.frequency.setValueAtTime(freq, t);
    osc.frequency.exponentialRampToValueAtTime(freq * 0.6, t + 0.2);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.3, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    osc.connect(env).connect(this.out);
    env.connect(this.verb);
    osc.start(t);
    osc.stop(t + 0.27);
  }

  /** A drum fill on the last beat of the bar, leading into a gear change. */
  private fill(t: number) {
    const len = this.stepLength();
    for (let i = 0; i < 4; i++) this.tom(t + i * len, 260 - i * 40);
  }

  private crash(t: number) {
    this.hat(t, 1.4, 5000, 0.22, 'highpass', true);
  }

  private click(t: number, gain: number) {
    this.hat(t, 0.008, 3000, gain, 'highpass');
  }

  private hat(t: number, dur: number, freq: number, gain: number, type: BiquadFilterType = 'highpass', verb = false) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const env = ctx.createGain();
    env.gain.setValueAtTime(gain, t);
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(env).connect(this.out);
    if (verb) env.connect(this.verb);
    src.start(t, Math.random() * 1.5);
    src.stop(t + dur + 0.02);
  }
}

// --- Ambience ------------------------------------------------------------------------

/**
 * A world's background sound: a filtered noise bed with slow movement, plus
 * occasional details (distant sirens, insect chirps, growls, wind gusts).
 */
class Ambience {
  private readonly out: GainNode;
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(private readonly ctx: AudioContext, bus: GainNode, private readonly verb: AudioNode, noiseBuf: AudioBuffer, private readonly biome: Biome) {
    this.out = ctx.createGain();
    this.out.gain.setValueAtTime(0.0001, ctx.currentTime);
    this.out.gain.exponentialRampToValueAtTime(1, ctx.currentTime + 3);
    this.out.connect(bus);
    const bed: Record<Biome, [BiquadFilterType, number, number, number]> = {
      // [filter, frequency, gain, wobble rate]
      metropolis: ['lowpass', 420, 0.22, 0.05],
      cosmic: ['lowpass', 160, 0.3, 0.03],
      mystic: ['bandpass', 600, 0.08, 0.08],
      wasteland: ['bandpass', 500, 0.16, 0.12],
      frozen: ['bandpass', 900, 0.14, 0.18],
      jungle: ['highpass', 3500, 0.03, 0.4],
      underworld: ['lowpass', 120, 0.4, 0.06],
    };
    const [type, freq, gain, rate] = bed[biome];
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = type === 'bandpass' ? 1.5 : 0.7;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = rate;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = freq * 0.5;
    lfo.connect(lfoGain).connect(filter.frequency);
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(filter).connect(g).connect(this.out);
    src.start();
    lfo.start();
    this.sources.push(src, lfo);
    // Space and the mystic realm hum with a low drone.
    if (biome === 'cosmic' || biome === 'mystic' || biome === 'underworld') {
      for (const f of biome === 'underworld' ? [41, 43.5] : [55, 82.4]) {
        const o = ctx.createOscillator();
        o.frequency.value = f;
        const og = ctx.createGain();
        og.gain.value = 0.05;
        o.connect(og).connect(this.out);
        o.start();
        this.sources.push(o);
      }
    }
    this.timer = setInterval(() => this.detail(), 900);
  }

  /** Occasional sounds that make a place feel alive. */
  private detail() {
    const r = Math.random();
    const t = this.ctx.currentTime + Math.random() * 0.5;
    switch (this.biome) {
      case 'metropolis':
        if (r < 0.05) this.siren(t);
        else if (r < 0.12) this.blip(t, 415 + Math.random() * 100, 0.3, 'square', 0.02); // distant horn
        break;
      case 'jungle':
        if (r < 0.5) for (let i = 0; i < 4; i++) this.blip(t + i * 0.07, 3000 + Math.random() * 1500, 0.05, 'sine', 0.025);
        else if (r < 0.62) this.blip(t, 900 + Math.random() * 600, 0.25, 'sine', 0.03, 1.6); // bird
        break;
      case 'underworld':
        if (r < 0.15) this.blip(t, 70 + Math.random() * 40, 1.2, 'sawtooth', 0.04, 0.6); // distant growl
        else if (r < 0.45) this.blip(t, 2500 + Math.random() * 2000, 0.02, 'square', 0.02); // crackle
        break;
      case 'cosmic':
        if (r < 0.15) this.blip(t, 1200 + Math.random() * 800, 0.6, 'sine', 0.015, 1.5); // station chirp
        break;
      case 'frozen':
      case 'wasteland':
        if (r < 0.2) this.blip(t, 300 + Math.random() * 200, 1.5, 'sine', 0.01, 1.3); // wind whistle
        break;
      case 'mystic':
        if (r < 0.2) this.blip(t, [523, 659, 784, 988][Math.floor(Math.random() * 4)], 1.8, 'sine', 0.02); // chime
        break;
    }
  }

  private blip(t: number, freq: number, dur: number, type: OscillatorType, gain: number, bend = 1) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(freq * bend, t + dur);
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(gain, t + Math.min(0.05, dur / 3));
    env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(env).connect(this.out);
    env.connect(this.verb);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private siren(t: number) {
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    const lfo = this.ctx.createOscillator();
    lfo.frequency.value = 0.8;
    const lg = this.ctx.createGain();
    lg.gain.value = 180;
    lfo.connect(lg).connect(o.frequency);
    o.frequency.value = 760;
    const env = this.ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(0.012, t + 1);
    env.gain.exponentialRampToValueAtTime(0.0001, t + 4);
    o.connect(env).connect(this.out);
    env.connect(this.verb);
    o.start(t);
    lfo.start(t);
    o.stop(t + 4.1);
    lfo.stop(t + 4.1);
  }

  stop() {
    clearInterval(this.timer);
    const t = this.ctx.currentTime;
    this.out.gain.cancelScheduledValues(t);
    this.out.gain.setTargetAtTime(0.0001, t, 0.5);
    setTimeout(() => {
      this.sources.forEach((s) => s.stop());
      this.out.disconnect();
    }, 2500);
  }
}

let shared: AudioEngine | null = null;

/** One engine for the whole app (browsers limit how many AudioContexts a page may open). */
export function audio(volumes?: VolumeSettings): AudioEngine {
  shared ??= new AudioEngine(volumes ?? { master: 0.8, music: 0.6, sfx: 0.9 });
  if (volumes) shared.setVolumes(volumes);
  return shared;
}
