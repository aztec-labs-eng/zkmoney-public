import type { SavingsQuote } from "@obsidion/front-core"
import { usdAtomic } from "../../ui/format"

/** The move's fees rose after its review: `quote` is what it would cost now. Nothing was sent. */
export class SavingsQuoteChangedError extends Error {
  constructor(readonly quote: SavingsQuote) {
    super(`Fees went up since your review: ${usdAtomic(quote.fee)} now. Nothing was sent.`)
    this.name = "SavingsQuoteChangedError"
  }
}
