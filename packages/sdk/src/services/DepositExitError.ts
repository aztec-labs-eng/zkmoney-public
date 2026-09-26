/**
 * Typed classification of a deposit-exit proof-build failure. Callers dispatch on `reason`:
 *
 *   - `"already-claimed"` — positive on-chain evidence the deposit was claimed on L2: the frozen
 *     avenue's claim-nullifier non-inclusion witness failed AND the claim nullifier was then found
 *     in the frozen tree. Benign; the deposit unit is dropped.
 *   - `"transient"` — anything else (RPC, witness construction, enclave, precondition). Fails the
 *     run for retry; never a drop signal.
 *
 * The message is a fixed sanitized string — the raw underlying error lives only on `cause`.
 */
export type DepositExitReason = "already-claimed" | "transient"

const MESSAGES: Record<DepositExitReason, string> = {
  "already-claimed":
    "Deposit exit unavailable: the claim nullifier is already in the frozen tree — the deposit was claimed on L2.",
  "transient": "Deposit exit failed before L1 submission (proof build error). Safe to retry.",
}

// Benign-class messages differ across oxide pins; both mean the claim-nullifier non-inclusion miss.
// A match is a hint, never a verdict — a pruned or unreachable node produces the same failure shape
// for a deposit that was never claimed, and writing one off is permanent and invisible.
const ALREADY_CLAIMED_PATTERNS = [/low-nullifier witness/, /nullifier non-inclusion/]

/** Resolves true only when the deposit's claim nullifier is found in the frozen tree. */
export type ClaimNullifierConfirmer = () => Promise<boolean>

export class DepositExitError extends Error {
  readonly reason: DepositExitReason

  constructor(reason: DepositExitReason, options?: { cause?: unknown }) {
    super(MESSAGES[reason], options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = "DepositExitError"
    this.reason = reason

    // Preserve prototype chain for `instanceof` after transpilation.
    Object.setPrototypeOf(this, DepositExitError.prototype)
  }

  /**
   * Classify with positive evidence: a benign write-off needs BOTH the frozen avenue's
   * claim-nullifier failure shape and `confirm()` finding that nullifier in the frozen tree. A
   * confirmer that resolves false or throws yields "transient" — a retry beats a silent loss.
   *
   * FROZEN-avenue only: the unprocessed circuit has no claim-nullifier step, so its catches must
   * map to "transient" directly.
   */
  static async classifyConfirmed(
    err: unknown,
    confirm: ClaimNullifierConfirmer,
  ): Promise<DepositExitError> {
    if (err instanceof DepositExitError) return err
    const message = String((err as Error)?.message ?? err)
    if (!ALREADY_CLAIMED_PATTERNS.some((re) => re.test(message))) {
      return new DepositExitError("transient", { cause: err })
    }
    const claimed = await confirm().catch(() => false)
    return new DepositExitError(claimed ? "already-claimed" : "transient", { cause: err })
  }
}
