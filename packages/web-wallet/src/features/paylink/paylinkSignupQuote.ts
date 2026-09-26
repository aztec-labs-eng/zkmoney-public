/**
 * How a paylink-funded signup splits the note. The claim burns front-core's `goldenTicketBurn` to
 * the registration SIPA: the signed schedule's floor at the portal's cut, the return deposit's cut,
 * the withdrawal's cut and both tips. The rest of the note stays with the new account at once, and
 * the sweep's return deposit lands later.
 */
import { GOLDEN_TICKET_PROVER_TIP, WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import type { RegistrationSchedule } from "@obsidion/core/types"
import { goldenTicketBurn, goldenTicketCoverage, type GoldenTicketCuts } from "@obsidion/front-core"
import { ticketTagCharge } from "../onboarding/registrationAsk"

export interface PaylinkSignupQuote {
  paylink?: bigint
  /** What the claim leaves in the wallet at once: the note less the burn. */
  youReceive?: bigint
  /** `youReceive` plus the sweep's return deposit, once that lands. */
  eventual?: bigint
  /** The signed fee's part above the live sweep fee. Undefined until that fee is read. */
  tagFee?: bigint
  /** The signed fee is exactly the sweep fee. Undefined until that fee is read. */
  tagWaived?: boolean
  /** The sweep fee, both portal cuts and the relayer tip. */
  networkFee: bigint
  provingFee: bigint
  /** The return deposit the sweep sends back after the fee and its cut. */
  returned: bigint
  /** The gross the claim burns to the SIPA. */
  burn: bigint
  /** The note covers the burn with something left over. Undefined while its amount is unknown. */
  covers?: boolean
}

/** Prices one ticket signup; the caller supplies the live cuts, so an unread cut prices nothing. */
export function paylinkSignupQuote(args: {
  paylink?: bigint
  schedule: RegistrationSchedule
  cuts: GoldenTicketCuts
  sweepFee?: bigint
}): PaylinkSignupQuote {
  const { paylink, schedule, cuts, sweepFee } = args
  const burn = goldenTicketBurn(schedule, cuts)
  const tagFee = ticketTagCharge(schedule, sweepFee)
  const sweepPart = tagFee === undefined ? schedule.fee : schedule.fee - tagFee
  const coverage = paylink === undefined ? undefined : goldenTicketCoverage(paylink, schedule, cuts)
  return {
    paylink,
    youReceive: coverage?.immediate,
    eventual: coverage?.eventual,
    tagFee,
    tagWaived: tagFee === undefined ? undefined : tagFee === 0n,
    networkFee: sweepPart + cuts.withdrawalCut + cuts.depositCut + WITHDRAW_RELAYER_TIP,
    provingFee: GOLDEN_TICKET_PROVER_TIP,
    returned: burn.returned,
    burn: burn.burn,
    covers: coverage?.covers,
  }
}
