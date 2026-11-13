/** `amount` at `from` decimals, at `to` decimals; a finer part than `to` holds is dropped. */
export const rescale = (amount: bigint, from: number, to: number): bigint =>
  to >= from ? amount * 10n ** BigInt(to - from) : amount / 10n ** BigInt(from - to)
