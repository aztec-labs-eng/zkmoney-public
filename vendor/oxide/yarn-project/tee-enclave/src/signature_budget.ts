import { randomInt } from 'node:crypto';

export const MAX_SIGNATURES_PER_KEY = 1_000_000;

/** Structured-clone-safe form: the SharedArrayBuffer is shared with workers. */
export interface SignatureBudgetWorkerData {
  effectiveLimit: number;
  counter: SharedArrayBuffer;
}

/** Shared cap on ECDSA signatures across all workers. */
export class SignatureBudget {
  readonly effectiveLimit: number;
  private readonly used: Int32Array;
  private readonly onExhausted?: () => void;
  private exhaustedFired = false;

  constructor(effectiveLimit: number, counter: SharedArrayBuffer = new SharedArrayBuffer(4), onExhausted?: () => void) {
    this.effectiveLimit = effectiveLimit;
    this.used = new Int32Array(counter);
    this.onExhausted = onExhausted;
  }

  /** Draws the effective limit with downward jitter so tees that boot together do not exhaust together. */
  static create(limit = MAX_SIGNATURES_PER_KEY): SignatureBudget {
    return new SignatureBudget(limit - randomInt(0, Math.floor(limit / 10) + 1));
  }

  /** Reserves one signature; past the limit it fires `onExhausted` (once) and throws. */
  consume(): void {
    const prev = Atomics.add(this.used, 0, 1);
    if (prev >= this.effectiveLimit) {
      if (!this.exhaustedFired) {
        this.exhaustedFired = true;
        this.onExhausted?.();
      }
      throw new Error('signature budget exhausted');
    }
  }

  remaining(): number {
    return Math.max(0, this.effectiveLimit - Atomics.load(this.used, 0));
  }

  toWorkerData(): SignatureBudgetWorkerData {
    return { effectiveLimit: this.effectiveLimit, counter: this.used.buffer as SharedArrayBuffer };
  }

  static fromWorkerData(data: SignatureBudgetWorkerData, onExhausted?: () => void): SignatureBudget {
    return new SignatureBudget(data.effectiveLimit, data.counter, onExhausted);
  }
}
