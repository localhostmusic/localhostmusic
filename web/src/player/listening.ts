// Count media heard, excluding seeks. Sparse background ticks are permitted only
// up to the wall time that passed at the current playback speed.
export class ListeningClock {
  seconds = 0;
  private previous: { position: number; at: number; playing: boolean } | null = null;
  tick(position: number, at: number, playing: boolean, rate = 1): number {
    const prev = this.previous;
    if (prev?.playing && playing) {
      const delta = position - prev.position;
      const elapsed = Math.max(0, (at - prev.at) / 1000);
      if (delta > 0 && delta <= elapsed * Math.max(0.25, rate) + 0.75) this.seconds += delta;
    }
    this.previous = { position, at, playing };
    return this.seconds;
  }
}
