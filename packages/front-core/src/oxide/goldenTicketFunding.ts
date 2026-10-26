/**
 * Wallet-side pricing of a golden-ticket registration: what the link's note must burn so the
 * registration SIPA sweeps, what the recipient keeps at once, and what the sweep returns later.
 * The figures come from `goldenTicketQuote` in core; this layer adds the tips and the note. The
 * prover tip is the caller's: zero, or the one the review committed to. The withdrawal fee is the
 * source executor's `FEE()`.
 */
import {
  GOLDEN_TICKET_BRIDGE_REMAINDER,
  goldenTicketQuote,
  WITHDRAW_RELAYER_TIP,
  type GoldenTicketQuote,
} from "@obsidion/core/constants"
import type { RegistrationSchedule } from "@obsidion/core/types"

/** The burn for one signed schedule, with the executor's fee, the relayer tip and remainder. */
export function goldenTicketBurn(
  schedule: RegistrationSchedule,
  proverTip: bigint,
  withdrawalFee: bigint,
): GoldenTicketQuote {
  return goldenTicketQuote(schedule, {
    withdrawalFee,
    relayerTip: WITHDRAW_RELAYER_TIP,
    proverTip,
    bridgeRemainder: GOLDEN_TICKET_BRIDGE_REMAINDER,
  })
}

export interface GoldenTicketCoverage extends GoldenTicketQuote {
  noteAmount: bigint
  /** What the recipient keeps as the claim lands: the note less the burn. */
  immediate: bigint
  /** The immediate balance plus the sweep's return deposit, once that lands. */
  eventual: bigint
  /** The note funds the burn with something left over. A note equal to the burn is refused. */
  covers: boolean
}

/** Whether, and how, one note funds a ticket registration on this schedule. */
export function goldenTicketCoverage(
  noteAmount: bigint,
  schedule: RegistrationSchedule,
  proverTip: bigint,
  withdrawalFee: bigint,
): GoldenTicketCoverage {
  const quote = goldenTicketBurn(schedule, proverTip, withdrawalFee)
  const immediate = noteAmount - quote.burn
  return {
    ...quote,
    noteAmount,
    immediate,
    eventual: immediate + quote.returned,
    covers: noteAmount > quote.burn,
  }
}
