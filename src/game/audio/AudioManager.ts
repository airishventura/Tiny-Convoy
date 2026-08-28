/**
 * Audio.
 *
 * Everything the truck does is synthesised in the Web Audio graph — engine,
 * tyres, wind, hitch rattle, impacts, settlement ambience and UI. That keeps
 * the first load instant (no audio downloads at all) and lets engine pitch
 * track load and speed continuously rather than crossfading canned loops.
 *
 * Howler is used for the optional radio: drop files into `public/audio/` and
 * they are picked up; with none present the radio plays a generative station
 * instead. Nothing here throws if audio is blocked or unavailable.
 */

import { Howl } from 'howler';
import { clamp, clamp01, lerp } from '@/lib/math';

export interface EngineInput {
  /** m/s */
  speed: number;
  /** 0..1 */
  load: number;
  throttle: number;
  boosting: boolean;
  /** 0..1 lateral slip amount. */
  slip: number;
  /** 0..1 surface roughness. */
  roughness: number;
  grounded: number;
  /** Suspension travel rate. */
  jolt: number;
  /** 0..1 dust storm intensity. */
  storm: number;
}

const RADIO_TRACKS = ['/audio/radio-1.mp3', '/audio/radio-2.mp3'];

const makeNoiseBuffer = (ctx: AudioContext, seconds = 2): AudioBuffer => {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * seconds, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1;
    // Slight brown tint — closer to tyre and wind noise than pure white.
    last = (last + 0.02 * white) / 1.02;
    data[i] = last * 3.2;
  }
  return buffer;
};

class AudioManager {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;

  private engineOscA: OscillatorNode | null = null;
  private engineOscB: OscillatorNode | null = null;
  private engineSub: OscillatorNode | null = null;
  private engineGain: GainNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;

  private tyreSrc: AudioBufferSourceNode | null = null;
  private tyreGain: GainNode | null = null;
  private tyreFilter: BiquadFilterNode | null = null;

  private windSrc: AudioBufferSourceNode | null = null;
  private windGain: GainNode | null = null;
  private windFilter: BiquadFilterNode | null = null;

  private ambienceGain: GainNode | null = null;
  private ambienceMurmur: AudioBufferSourceNode | null = null;
  private ambienceFilter: BiquadFilterNode | null = null;
  private ambienceLfo: OscillatorNode | null = null;
  private ambienceDroneA: OscillatorNode | null = null;
  private ambienceDroneB: OscillatorNode | null = null;
  private ambienceChimeTimer: number | null = null;
  /** Last level passed to setAmbience — the chime scheduler reads this so it
   *  can skip itself on the open road instead of spending nodes on silence. */
  private ambienceLevel = 0;
  private noiseBuffer: AudioBuffer | null = null;

  private radio: Howl | null = null;
  private radioTimer: number | null = null;
  private generativeStation = false;

  private started = false;
  private muted = false;
  private volumes = { master: 0.8, sfx: 0.9, music: 0.5 };
  private lastRattle = 0;
  private lastImpact = 0;
  private lastHorn = 0;

  get ready(): boolean {
    return this.started && this.ctx !== null;
  }

  /** Must be called from a user gesture. Safe to call repeatedly. */
  async start(): Promise<void> {
    if (this.started) {
      await this.ctx?.resume().catch(() => undefined);
      return;
    }
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;

    try {
      const ctx = new Ctor();
      await ctx.resume().catch(() => undefined);
      this.ctx = ctx;
      this.noiseBuffer = makeNoiseBuffer(ctx);

      const master = ctx.createGain();
      master.gain.value = this.volumes.master;
      master.connect(ctx.destination);
      this.master = master;

      const sfx = ctx.createGain();
      sfx.gain.value = this.volumes.sfx;
      sfx.connect(master);
      this.sfxBus = sfx;

      const music = ctx.createGain();
      music.gain.value = this.volumes.music * 0.5;
      music.connect(master);
      this.musicBus = music;

      this.buildEngine();
      this.buildRolling();
      this.buildAmbience();
      this.started = true;
    } catch {
      this.started = false;
    }
  }

  setVolumes(master: number, sfx: number, music: number): void {
    this.volumes = { master, sfx, music };
    if (this.master) this.master.gain.value = this.muted ? 0 : master;
    if (this.sfxBus) this.sfxBus.gain.value = sfx;
    if (this.musicBus) this.musicBus.gain.value = music * 0.5;
    this.radio?.volume(music * 0.6);
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : this.volumes.master;
  }

  suspend(): void {
    this.ctx?.suspend().catch(() => undefined);
  }

  resume(): void {
    this.ctx?.resume().catch(() => undefined);
  }

  // ── Continuous layers ─────────────────────────────────────────────────────

  private buildEngine(): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxBus) return;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 420;
    filter.Q.value = 3.2;

    const gain = ctx.createGain();
    gain.gain.value = 0;

    const a = ctx.createOscillator();
    a.type = 'sawtooth';
    a.frequency.value = 60;
    const b = ctx.createOscillator();
    b.type = 'square';
    b.frequency.value = 90;
    const sub = ctx.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = 30;

    const aG = ctx.createGain();
    aG.gain.value = 0.5;
    const bG = ctx.createGain();
    bG.gain.value = 0.18;
    const subG = ctx.createGain();
    subG.gain.value = 0.6;

    a.connect(aG).connect(filter);
    b.connect(bG).connect(filter);
    sub.connect(subG).connect(filter);
    filter.connect(gain).connect(this.sfxBus);

    a.start();
    b.start();
    sub.start();

    this.engineOscA = a;
    this.engineOscB = b;
    this.engineSub = sub;
    this.engineGain = gain;
    this.engineFilter = filter;
  }

  private buildRolling(): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxBus || !this.noiseBuffer) return;

    const mk = (type: BiquadFilterType, freq: number) => {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = freq;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(this.sfxBus!);
      src.start();
      return { src, filter, gain };
    };

    const tyre = mk('bandpass', 900);
    tyre.filter.Q.value = 0.8;
    this.tyreSrc = tyre.src;
    this.tyreFilter = tyre.filter;
    this.tyreGain = tyre.gain;

    const wind = mk('lowpass', 700);
    this.windSrc = wind.src;
    this.windFilter = wind.filter;
    this.windGain = wind.gain;

    const amb = ctx.createGain();
    amb.gain.value = 0;
    amb.connect(this.sfxBus);
    this.ambienceGain = amb;
  }

  /**
   * Settlement ambience: a soft filtered-noise murmur with a slow breathing
   * LFO, a warm low drone standing in for a generator or a lived-in hum, and
   * occasional soft chime notes. Everything here routes into `ambienceGain`,
   * so proximity — set externally via `setAmbience` — is the only thing that
   * ever makes any of it audible.
   */
  private buildAmbience(): void {
    const ctx = this.ctx;
    if (!ctx || !this.ambienceGain || !this.noiseBuffer) return;

    const murmur = ctx.createBufferSource();
    murmur.buffer = this.noiseBuffer;
    murmur.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 620;
    filter.Q.value = 1.1;
    const murmurGain = ctx.createGain();
    murmurGain.gain.value = 0.55;
    murmur.connect(filter).connect(murmurGain).connect(this.ambienceGain);
    murmur.start();
    this.ambienceMurmur = murmur;
    this.ambienceFilter = filter;

    // A slow breathing LFO on the filter's centre frequency keeps the murmur
    // from reading as a static drone — it rises and falls the way real
    // distant activity does.
    const lfo = ctx.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.06;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 180;
    lfo.connect(lfoGain).connect(filter.frequency);
    lfo.start();
    this.ambienceLfo = lfo;

    const drone = (freq: number, gain: number): OscillatorNode => {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = gain;
      osc.connect(g).connect(this.ambienceGain!);
      osc.start();
      return osc;
    };
    this.ambienceDroneA = drone(98, 0.4);
    this.ambienceDroneB = drone(98.6, 0.32);

    // A hanging bell or a loose sheet of tin, once every few seconds — routed
    // through the same bus as the murmur so it fades with distance exactly
    // like everything else here, and skipped outright while the level is
    // near zero so the open road never spends nodes on notes no one can hear.
    const notes = [523.25, 587.33, 659.25, 783.99];
    this.ambienceChimeTimer = window.setInterval(() => {
      if (this.ambienceLevel < 0.1) return;
      const freq = notes[Math.floor(Math.random() * notes.length)];
      this.burst(
        { freq, decay: 1.1 + Math.random() * 0.6, gain: 0.04 + this.ambienceLevel * 0.05, osc: 'sine', type: 'lowpass' },
        this.ambienceGain,
      );
    }, 2600);
  }

  /** Called every frame while driving. */
  updateDriving(i: EngineInput, dt: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.engineGain || !this.engineOscA) return;
    const t = ctx.currentTime;
    const smooth = clamp(dt * 6, 0.02, 0.4);

    // Gear-stepped rev band: the pitch climbs, drops, climbs again.
    const spd = Math.abs(i.speed);
    const gear = Math.min(5, Math.floor(spd / 7.5));
    const within = clamp01((spd - gear * 7.5) / 7.5);
    const idle = 34;
    const rev = idle + within * 46 + gear * 5 + i.load * 18 + (i.boosting ? 14 : 0);

    const set = (param: AudioParam, value: number) => {
      param.setTargetAtTime(value, t, smooth);
    };

    set(this.engineOscA.frequency, rev);
    if (this.engineOscB) set(this.engineOscB.frequency, rev * 1.51);
    if (this.engineSub) set(this.engineSub.frequency, rev * 0.5);
    if (this.engineFilter) set(this.engineFilter.frequency, 260 + i.load * 1500 + within * 400);
    set(this.engineGain.gain, lerp(0.06, 0.19, clamp01(i.load * 0.7 + Math.abs(i.throttle) * 0.5)));

    if (this.tyreGain && this.tyreFilter) {
      const rolling = clamp01(spd / 26) * (i.grounded > 0 ? 1 : 0);
      const skid = clamp01(i.slip / 7);
      set(this.tyreGain.gain, rolling * (0.045 + i.roughness * 0.14) + skid * 0.12);
      set(this.tyreFilter.frequency, 420 + rolling * 1400 + skid * 1800 + i.roughness * 500);
    }

    if (this.windGain && this.windFilter) {
      const wind = clamp01(spd / 34) * 0.08 + i.storm * 0.3;
      set(this.windGain.gain, wind);
      set(this.windFilter.frequency, 260 + clamp01(spd / 34) * 900 + i.storm * 1400);
    }

    // Hitch rattle: discrete ticks driven by suspension travel, not a loop.
    if (i.jolt > 1.9 && t - this.lastRattle > 0.09) {
      this.lastRattle = t;
      this.rattle(clamp01((i.jolt - 1.9) / 5));
    }
  }

  /** Proximity to settlements/POIs, 0..1. Ramped, never stepped. */
  setAmbience(level: number): void {
    this.ambienceLevel = clamp01(level);
    if (!this.ambienceGain || !this.ctx) return;
    this.ambienceGain.gain.setTargetAtTime(this.ambienceLevel * 0.055, this.ctx.currentTime, 0.6);
  }

  // ── One-shots ─────────────────────────────────────────────────────────────

  private burst(
    opts: { freq: number; decay: number; gain: number; type?: BiquadFilterType; noise?: boolean; osc?: OscillatorType },
    bus: GainNode | null = this.sfxBus,
  ): void {
    const ctx = this.ctx;
    if (!ctx || !bus) return;
    const t = ctx.currentTime;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(opts.gain, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + opts.decay);

    const filter = ctx.createBiquadFilter();
    filter.type = opts.type ?? 'lowpass';
    filter.frequency.setValueAtTime(opts.freq, t);
    filter.frequency.exponentialRampToValueAtTime(Math.max(60, opts.freq * 0.25), t + opts.decay);

    if (opts.noise && this.noiseBuffer) {
      const src = ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      src.playbackRate.value = 0.8 + Math.random() * 0.5;
      src.connect(filter).connect(gain).connect(bus);
      src.start(t);
      src.stop(t + opts.decay + 0.05);
    } else {
      const osc = ctx.createOscillator();
      osc.type = opts.osc ?? 'sine';
      osc.frequency.setValueAtTime(opts.freq, t);
      osc.frequency.exponentialRampToValueAtTime(Math.max(40, opts.freq * 0.4), t + opts.decay);
      osc.connect(filter).connect(gain).connect(bus);
      osc.start(t);
      osc.stop(t + opts.decay + 0.05);
    }
  }

  rattle(intensity: number): void {
    this.burst({ freq: 1400 + intensity * 1800, decay: 0.06 + intensity * 0.05, gain: 0.03 + intensity * 0.07, noise: true, type: 'bandpass' });
  }

  impact(intensity: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.currentTime - this.lastImpact < 0.08) return;
    this.lastImpact = ctx.currentTime;
    const i = clamp01(intensity);
    this.burst({ freq: 180 + i * 260, decay: 0.22 + i * 0.4, gain: 0.12 + i * 0.35, noise: true });
    this.burst({ freq: 70 + i * 40, decay: 0.3 + i * 0.4, gain: 0.1 + i * 0.25, osc: 'triangle' });
  }

  hitchSnap(): void {
    this.burst({ freq: 2200, decay: 0.14, gain: 0.3, noise: true, type: 'highpass' });
    this.burst({ freq: 120, decay: 0.5, gain: 0.24, osc: 'sawtooth' });
  }

  ui(kind: 'click' | 'confirm' | 'back' | 'error' | 'reward' = 'click'): void {
    switch (kind) {
      case 'confirm':
        this.burst({ freq: 660, decay: 0.12, gain: 0.08, osc: 'sine', type: 'lowpass' });
        this.burst({ freq: 990, decay: 0.18, gain: 0.05, osc: 'sine', type: 'lowpass' });
        break;
      case 'back':
        this.burst({ freq: 330, decay: 0.12, gain: 0.07, osc: 'sine' });
        break;
      case 'error':
        this.burst({ freq: 180, decay: 0.24, gain: 0.12, osc: 'square', type: 'lowpass' });
        break;
      case 'reward':
        [523, 659, 784].forEach((f, n) => setTimeout(() => this.burst({ freq: f, decay: 0.35, gain: 0.07, osc: 'triangle' }), n * 90));
        break;
      default:
        this.burst({ freq: 520, decay: 0.06, gain: 0.05, osc: 'sine' });
    }
  }

  /** Safe to call on every keypress — a short cooldown stops rapid taps stacking into noise. */
  horn(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.currentTime - this.lastHorn < 0.12) return;
    this.lastHorn = ctx.currentTime;
    this.burst({ freq: 210, decay: 0.55, gain: 0.16, osc: 'sawtooth', type: 'lowpass' });
    this.burst({ freq: 280, decay: 0.5, gain: 0.12, osc: 'square', type: 'lowpass' });
  }

  // ── Radio ────────────────────────────────────────────────────────────────

  startRadio(): void {
    if (this.radio || this.generativeStation) return;
    const src = RADIO_TRACKS;
    const howl = new Howl({
      src,
      volume: this.volumes.music * 0.6,
      loop: true,
      html5: true,
      onloaderror: () => {
        // No files shipped — run the generative station instead.
        this.radio = null;
        this.startGenerativeStation();
      },
      onplayerror: () => {
        this.radio = null;
        this.startGenerativeStation();
      },
    });
    this.radio = howl;
    howl.play();
  }

  stopRadio(): void {
    this.radio?.stop();
    this.radio?.unload();
    this.radio = null;
    if (this.radioTimer !== null) {
      window.clearInterval(this.radioTimer);
      this.radioTimer = null;
    }
    this.generativeStation = false;
  }

  /** A slow, warm arpeggio in a pentatonic scale. Cosy, never in the way. */
  private startGenerativeStation(): void {
    if (!this.ctx || !this.musicBus || this.generativeStation) return;
    this.generativeStation = true;
    const scale = [196, 220, 261.63, 293.66, 349.23, 392, 440, 523.25];
    let step = 0;

    const play = () => {
      const ctx = this.ctx;
      if (!ctx || !this.musicBus) return;
      const t = ctx.currentTime;
      const note = scale[(step * 3 + (step % 5)) % scale.length] * (step % 8 === 0 ? 0.5 : 1);
      step++;

      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = note;
      const osc2 = ctx.createOscillator();
      osc2.type = 'sine';
      osc2.frequency.value = note * 2.005;

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.1, t + 0.4);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 3.6);

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 1400;

      osc.connect(filter);
      osc2.connect(filter);
      filter.connect(gain).connect(this.musicBus);
      osc.start(t);
      osc2.start(t);
      osc.stop(t + 3.8);
      osc2.stop(t + 3.8);
    };

    play();
    this.radioTimer = window.setInterval(play, 2400);
  }

  dispose(): void {
    this.stopRadio();
    if (this.ambienceChimeTimer !== null) {
      window.clearInterval(this.ambienceChimeTimer);
      this.ambienceChimeTimer = null;
    }
    for (const node of [
      this.engineOscA,
      this.engineOscB,
      this.engineSub,
      this.tyreSrc,
      this.windSrc,
      this.ambienceMurmur,
      this.ambienceLfo,
      this.ambienceDroneA,
      this.ambienceDroneB,
    ]) {
      try {
        node?.stop();
        node?.disconnect();
      } catch {
        /* already stopped */
      }
    }
    // The ambience filter is a processing node, not a source: it has no stop(),
    // so it cannot ride the loop above — the throw would skip its disconnect.
    try {
      this.ambienceFilter?.disconnect();
    } catch {
      /* already disconnected */
    }
    this.ambienceFilter = null;
    this.ctx?.close().catch(() => undefined);
    this.ctx = null;
    this.started = false;
  }
}

export const audio = new AudioManager();
