// The optional Web Audio graph. Each element feeds its own gain, both gains feed
// the analyser, then the master gain, then the output. A parallel path (analyser,
// convolver, wet gain, master) adds reverb.
//
// Used by the visualizer (analyser tap) and crossfade (per-element gains). Not
// built on touch devices: an AudioContext on a phone resamples the signal and is
// suspended in the background, which stops playback and breaks the audio clock.
// createMediaElementSource() reroutes an element permanently, so it is never called there.
//
// Callers must work without it: volume falls back to element volume, crossfade to
// a hard cut, and reverb does nothing.

export class AudioGraph {
  dispose(): void {
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.an = null;
    this.gains = [];
    this.master = null;
    this.convolver = null;
    this.wetGain = null;
  }
  private elems: HTMLMediaElement[];
  private ctx: AudioContext | null = null;
  private an: AnalyserNode | null = null;
  private gains: GainNode[] = [];
  private master: GainNode | null = null;
  private convolver: ConvolverNode | null = null;
  private wetGain: GainNode | null = null;
  private wet = 0;
  private failed = false;
  private readonly disabled: boolean;

  constructor(elems: HTMLMediaElement[]) {
    this.elems = elems;
    this.disabled =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia("(hover: none) and (pointer: coarse)").matches
        : false;
  }

  /** Has a graph been built? Callers use this to pick their fallback. */
  get built(): boolean { return !!this.master; }

  /**
   * Build the graph if this device allows one. Returns false when there is none
   * (touch device, no AudioContext, or construction failed).
   * `masterValue` seeds the output gain so volume doesn't jump when it appears.
   */
  ensure(masterValue: number): boolean {
    if (this.disabled || this.failed) return false;
    if (this.an) return true;
    if (typeof window === "undefined") return false;
    // Older WebKit only has the prefixed constructor.
    const g = globalThis as unknown as {
      AudioContext?: typeof AudioContext;
      webkitAudioContext?: typeof AudioContext;
    };
    const AC = g.AudioContext ?? g.webkitAudioContext;
    if (!AC || !this.elems[0]?.addEventListener) return false;
    let ctx: AudioContext | null = null;
    const sources: MediaElementAudioSourceNode[] = [];
    try {
      ctx = new AC();
      const an = ctx.createAnalyser();
      an.fftSize = 2048;
      // Default dB window (-100/-30), which the visualizer curves are tuned against.
      an.smoothingTimeConstant = 0.82;
      const gains: GainNode[] = [];
      this.elems.forEach((el, i) => {
        const g = ctx!.createGain();
        g.gain.value = 1;
        const source = ctx!.createMediaElementSource(el);
        sources.push(source);
        source.connect(g);
        g.connect(an);
        gains[i] = g;
      });
      // User volume applies after the analyser tap and the elements go to 1, so the
      // visualizer sees a full-scale signal regardless of volume or normalization.
      const master = ctx.createGain();
      master.gain.value = masterValue;
      an.connect(master);
      master.connect(ctx.destination);
      for (const el of this.elems) { try { el.volume = 1; } catch { /* */ } }
      this.ctx = ctx; this.an = an; this.gains = gains; this.master = master;
      return true;
    } catch {
      this.failed = true;
      if (ctx && sources.length) {
        // An element cannot be detached from its AudioContext, so route it straight
        // to the output if construction failed part way through.
        for (const source of sources) { try { source.disconnect(); source.connect(ctx.destination); } catch { /* unavailable output */ } }
        this.ctx = ctx;
      } else void ctx?.close().catch(() => {});
      return false;
    }
  }

  /** Browsers suspend the context (autoplay policy, backgrounding). */
  resume(): void { this.ctx?.resume().catch(() => { /* */ }); }
  get suspended(): boolean { return this.ctx?.state === "suspended"; }

  analyser(): AnalyserNode | null { return this.an; }

  /** Set output volume. Returns false when there is no graph to set it on. */
  setMaster(v: number): boolean {
    if (!this.master) return false;
    try { this.master.gain.value = v; } catch { /* */ }
    return true;
  }

  /**
   * Reverb wet mix. The impulse response is generated (decaying stereo noise), so
   * there is no IR file. `rand` is injectable for tests.
   */
  setReverb(v: number, masterValue: number, rand: () => number = Math.random): void {
    this.wet = Math.max(0, Math.min(1, isFinite(v) ? v : 0));
    if (this.wet > 0) {
      if (!this.ensure(masterValue)) return;
      this.resume();
      this.buildReverb(rand);
    }
    if (this.wetGain) { try { this.wetGain.gain.value = this.wet; } catch { /* */ } }
  }

  private buildReverb(rand: () => number): void {
    if (this.convolver || !this.ctx || !this.an || !this.master) return;
    try {
      const ctx = this.ctx;
      const sr = ctx.sampleRate;
      const len = Math.floor(sr * 2.8);
      const ir = ctx.createBuffer(2, len, sr);
      for (let ch = 0; ch < 2; ch++) {
        const d = ir.getChannelData(ch);
        for (let i = 0; i < len; i++) d[i] = (rand() * 2 - 1) * Math.pow(1 - i / len, 2.6);
      }
      const conv = ctx.createConvolver();
      conv.buffer = ir;
      const wet = ctx.createGain();
      wet.gain.value = this.wet;
      this.an.connect(conv);
      conv.connect(wet);
      wet.connect(this.master);
      this.convolver = conv;
      this.wetGain = wet;
    } catch { /* */ }
  }

  /**
   * Schedule the crossfade ramp: `from` fades out over `sec` while `to` fades in
   * (linear). Runs on the AudioContext wall clock, so callers converting from
   * media time must divide by the playback rate first.
   */
  rampCrossfade(from: number, to: number, sec: number): void {
    const ctx = this.ctx;
    if (!ctx || !this.gains[from] || !this.gains[to]) return;
    try {
      if (ctx.state === "suspended") ctx.resume();
      const t0 = ctx.currentTime;
      const out = this.gains[from].gain, inc = this.gains[to].gain;
      out.cancelScheduledValues(t0);
      inc.cancelScheduledValues(t0);
      out.setValueAtTime(out.value || 1, t0);
      out.linearRampToValueAtTime(0.0001, t0 + sec);
      inc.setValueAtTime(0.0001, t0);
      inc.linearRampToValueAtTime(1, t0 + sec);
    } catch { /* */ }
  }

  /** Return a faded-out element's gain to unity so it can be reused. */
  restoreGain(idx: number): void {
    const g = this.gains[idx];
    if (!g || !this.ctx) return;
    try { g.gain.cancelScheduledValues(this.ctx.currentTime); g.gain.value = 1; } catch { /* */ }
  }
}
