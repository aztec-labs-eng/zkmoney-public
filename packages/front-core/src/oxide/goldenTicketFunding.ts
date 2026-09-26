/**
 * Wallet-side pricing of a golden-ticket registration: what the link's note must burn so the
 * registration SIPA sweeps, what the recipient keeps at once, and what the sweep returns later.
 * The figures come from `goldenTicketQuote` in core; this layer adds the tips and the note.
 */
import {
  GOLDEN_TICKET_BRIDGE_REMAINDER,
  GOLDEN_TICKET_PROVER_TIP,
  goldenTicketQuote,
  WITHDRAW_RELAYER_TIP,
  type GoldenTicketQuote,
} from "@obsidion/core/constants"
import type { RegistrationSchedule } from "@obsidion/core/types"

/**
 * The portal's cut on each leg of the round trip, read live. Both are the portal's
 * `FPC_FUNDING_CUT` today; they are priced apart so each leg is funded on its own.
 */
export interface GoldenTicketCuts {
  withdrawalCut: bigint
  depositCut: bigint
}

/** The burn for one signed schedule at the live cuts, with the fixed tips and remainder. */
export function goldenTicketBurn(
  schedule: RegistrationSchedule,
  cuts: GoldenTicketCuts,
): GoldenTicketQuote {
  return goldenTicketQuote(schedule, {
    withdrawalCut: cuts.withdrawalCut,
    depositCut: cuts.depositCut,
    relayerTip: WITHDRAW_RELAYER_TIP,
    proverTip: GOLDEN_TICKET_PROVER_TIP,
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

/** Whether, and how, one note funds a ticket registration on this schedule at these cuts. */
export function goldenTicketCoverage(
  noteAmount: bigint,
  schedule: RegistrationSchedule,
  cuts: GoldenTicketCuts,
): GoldenTicketCoverage {
  const quote = goldenTicketBurn(schedule, cuts)
  const immediate = noteAmount - quote.burn
  return {
    ...quote,
    noteAmount,
    immediate,
    eventual: immediate + quote.returned,
    covers: noteAmount > quote.burn,
  }
}
