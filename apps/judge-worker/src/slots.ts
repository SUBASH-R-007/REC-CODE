/**
 * The node's judging slots (RECX_SLOTS), shared by every queue's BullMQ
 * worker. A slot is a concrete index, not just a count: slot N owns isolate
 * boxes BASE+N / BASE+100+N / BASE+200+N, so two jobs can never share a box.
 *
 * Phase 1 hands slots out first-come-first-served across queues. Weighted
 * lane allocation (assessment and run lanes reserved ahead of practice and
 * rejudge) is Phase 2.
 */
export class SlotPool {
  private readonly free: number[];
  private readonly waiters: ((slot: number) => void)[] = [];

  constructor(readonly size: number) {
    if (!Number.isInteger(size) || size < 1) throw new Error(`slot count must be a positive integer, got ${size}`);
    this.free = Array.from({ length: size }, (_, i) => i);
  }

  get busy(): number {
    return this.size - this.free.length;
  }

  /** The lowest free slot, waiting for one if all are busy. */
  acquire(): Promise<number> {
    const slot = this.free.shift();
    if (slot !== undefined) return Promise.resolve(slot);
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release(slot: number): void {
    if (!Number.isInteger(slot) || slot < 0 || slot >= this.size || this.free.includes(slot)) {
      throw new Error(`release of slot ${slot} that is not held`);
    }
    const next = this.waiters.shift();
    if (next) next(slot);
    else {
      this.free.push(slot);
      this.free.sort((a, b) => a - b);
    }
  }
}
