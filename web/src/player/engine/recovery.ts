// Recovery is driven by absence of progress, not by an assumed sequence of
// browser events. Only real media-clock progress (or an intentional stop) clears
// the watchdog. A reload can hang without emitting another error.
const MAX_DELAY = 15_000;
const STALL_GRACE = 6_000;
const FATAL_MAX_TRIES = 4;

export interface RecoveryHost {
  active(): HTMLMediaElement | null;
  wantsToPlay(): boolean;
  reload(fresh: boolean): void;
  setReconnecting(on: boolean): void;
  onFatal?(): void;
}

export class StallRecovery {
  private timer?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setTimeout>;
  private tries = 0;
  private stalledAt: number | null = null;
  private generation = 0;
  private host: RecoveryHost;
  constructor(host: RecoveryHost) { this.host = host; }

  clear(): void {
    clearTimeout(this.timer);
    clearTimeout(this.watchdog);
    this.timer = this.watchdog = undefined;
    this.tries = 0;
    this.stalledAt = null;
    this.generation++;
    this.host.setReconnecting(false);
  }
  get active(): boolean { return this.stalledAt !== null; }
  /** How long the current stall has lasted, in ms (0 when nothing is stalled). */
  stalledFor(): number { return this.stalledAt === null ? 0 : Date.now() - this.stalledAt; }

  onError(): void {
    clearTimeout(this.watchdog);
    this.watchdog = undefined;
    this.schedule();
  }
  onStall(): void {
    if (!this.host.wantsToPlay() || this.active) return;
    this.stalledAt = Date.now();
    this.watchdog = setTimeout(() => {
      this.watchdog = undefined;
      this.schedule();
    }, STALL_GRACE);
  }
  onOnline(): void {
    const wasStalled = this.active;
    const el = this.host.active();
    this.clear();
    if (this.host.wantsToPlay() && el?.src && (wasStalled || el.paused || el.error || el.readyState < 3)) this.schedule();
  }
  private schedule(delay?: number): void {
    if (!this.host.wantsToPlay()) { this.clear(); return; }
    if (this.timer !== undefined) return;
    const el = this.host.active();
    if (el?.error?.code === 4 && this.tries >= FATAL_MAX_TRIES) {
      this.host.setReconnecting(false);
      this.host.onFatal?.();
      return;
    }
    this.stalledAt ??= Date.now();
    this.host.setReconnecting(true);
    const generation = this.generation;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const audio = this.host.active();
      if (!audio?.src || !this.host.wantsToPlay()) { this.clear(); return; }
      if (typeof navigator !== 'undefined' && !navigator.onLine) { this.schedule(MAX_DELAY); return; }
      // Give seeks one grace period, not an indefinite exemption from recovery.
      if (audio.seeking && !audio.error && Date.now() - this.stalledAt! < STALL_GRACE) {
        this.schedule(STALL_GRACE); return;
      }
      this.tries++;
      this.host.reload(!!audio.error || this.tries > 2);
      if (generation !== this.generation) return;
      // Errors may schedule a retry themselves. Silent hangs still have a timer.
      if (this.timer === undefined) {
        this.watchdog = setTimeout(() => {
          this.watchdog = undefined;
          this.schedule();
        }, STALL_GRACE);
      }
    }, delay ?? Math.min(MAX_DELAY, 600 * 2 ** Math.min(this.tries, 5)));
  }
}
