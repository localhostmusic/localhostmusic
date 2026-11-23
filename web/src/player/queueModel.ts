// Queue model: pure functions, no React, engine or Connect.
// `queue` is the tracks as added, `order` is a list of indices into it, and `pos`
// is the cursor within the order. Shuffling rewrites `order`, never the queue.

export type RepeatMode = "off" | "all" | "one";

/**
 * Build the play order (indices into the queue). Sequential, or shuffled with the
 * starting track placed first.
 * `weights[i]` biases the shuffle toward higher weights (Efraimidis-Spirakis:
 * key = random^(1/weight), sort descending).
 */
export function buildOrder(
  n: number,
  startQueueIdx: number,
  shuffle: boolean,
  weights?: number[],
): { order: number[]; pos: number } {
  if (!shuffle) return { order: Array.from({ length: n }, (_, i) => i), pos: Math.max(0, startQueueIdx) };
  const rest = Array.from({ length: n }, (_, i) => i).filter(i => i !== startQueueIdx);
  if (weights) {
    const keyed = rest.map(i => ({ i, k: Math.random() ** (1 / Math.max(0.001, weights[i] ?? 1)) }));
    keyed.sort((a, b) => b.k - a.k);
    rest.splice(0, rest.length, ...keyed.map(x => x.i));
  } else {
    for (let i = rest.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [rest[i], rest[j]] = [rest[j], rest[i]];
    }
  }
  return { order: startQueueIdx >= 0 ? [startQueueIdx, ...rest] : rest, pos: 0 };
}

/**
 * The order position that plays after `pos`, or null when there is no distinct
 * next one (end of queue with repeat off, or repeat-one). Also decides what to
 * preload for a gapless transition.
 */
export function nextPos(orderLen: number, pos: number, repeat: RepeatMode): number | null {
  if (repeat === "one") return null;
  const np = pos + 1;
  if (np >= orderLen) return repeat === "all" && orderLen > 0 ? 0 : null;
  return np;
}
