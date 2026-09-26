/** Raised by `ObsidionWallet.getDefaultSendOptions`: the wallet has no default fee payer. */
export class FeeUnavailableError extends Error {
  constructor(options?: { cause?: unknown; message?: string }) {
    super(
      options?.message ??
        "Fee payment unavailable: the wallet has no default fee payer. Pass an explicit sendOptions.fee.paymentMethod.",
      options?.cause !== undefined ? { cause: options.cause } : undefined,
    )
    this.name = "FeeUnavailableError"

    // Preserve prototype chain for `instanceof` after transpilation.
    Object.setPrototypeOf(this, FeeUnavailableError.prototype)
  }
}
