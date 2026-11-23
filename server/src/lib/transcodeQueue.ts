// One background encode leaves a slot available for an interactive stream.
// Jobs waiting for a slot are cheap and can be cancelled before spawning ffmpeg.
export class TranscodeQueue {
  private active = 0;
  private background = 0;
  private pending: { background: boolean; signal: AbortSignal; start: () => void; reject: (e: unknown) => void }[] = [];
  run<T>(work: () => Promise<T>, background: boolean, signal: AbortSignal): Promise<T> {
    if (this.pending.length >= 64) return Promise.reject(new Error("Transcode queue is full; retry shortly"));
    return new Promise((resolve, reject) => {
      const entry = { background, signal, reject, start: () => {
        signal.removeEventListener('abort', abort);
        this.active++;
        if (background) this.background++;
        Promise.resolve().then(work).then(resolve, reject).finally(() => {
          this.active--;
          if (background) this.background--;
          this.drain();
        });
      } };
      const abort = () => {
        const i = this.pending.indexOf(entry);
        if (i >= 0) this.pending.splice(i, 1);
        reject(signal.reason ?? new Error('Transcode cancelled'));
      };
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      this.pending.push(entry);
      this.drain();
    });
  }
  private drain() {
    while (this.active < 2) {
      let i = this.pending.findIndex(j => !j.background);
      if (i < 0 && this.background === 0) i = this.pending.findIndex(j => j.background);
      if (i < 0) return;
      this.pending.splice(i, 1)[0].start();
    }
  }
}
