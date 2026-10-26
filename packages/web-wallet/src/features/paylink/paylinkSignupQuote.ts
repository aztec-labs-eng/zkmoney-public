/**
 * How a paylink-funded signup splits the note. The claim burns front-core's `goldenTicketBurn` to
 * the registration SIPA: the signed schedule's floor, the relayer tip and the committed prover tip.
 * The rest of the note stays with the new account at once, and the sweep's return deposit lands
 * later. The rows sum to the note: the burn's fixed dust slice, cents the sweep returns, is folded
 * into the network fee rather than shown as money owed back; a signed minimum is real money held
 * until the sweep, and counts in the balance after.
 */
import { GOLDEN_TICKET_BRIDGE_REMAINDER, WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import type { RegistrationSchedule } from "@obsidion/core/types"
import { goldenTicketBurn, goldenTicketCoverage } from "@obsidion/front-core"
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
  /** The sweep fee, the relayer tip, and the dust the sweep returns. */
  networkFee: bigint
  /** The committed prover tip; zero when the burn does not tip. */
  provingFee: bigint
  /** A signed minimum the sweep sends back after the fee; zero for dust. */
  returned: bigint
  /** The gross the claim burns to the SIPA. */
  burn: bigint
  /** The note covers the burn with something left over. Undefined while its amount is unknown. */
  covers?: boolean
}

/** Prices one ticket signup. */
export function paylinkSignupQuote(args: {
  paylink?: bigint
  schedule: RegistrationSchedule
  sweepFee?: bigint
  proverTip: bigint
  /** The source executor's withdrawal fee. */
  withdrawalFee: bigint
  /** A golden ticket's schedule: the tag is free whatever the live sweep fee, and the whole signed
   *  fee is the network's. */
  ticket?: boolean
}): PaylinkSignupQuote {
  const { paylink, schedule, sweepFee, proverTip, withdrawalFee, ticket } = args
  const burn = goldenTicketBurn(schedule, proverTip, withdrawalFee)
  const tagFee = ticket && sweepFee !== undefined ? 0n : ticketTagCharge(schedule, sweepFee)
  const sweepPart = tagFee === undefined ? schedule.fee : schedule.fee - tagFee
  const coverage =
    paylink === undefined
      ? undefined
      : goldenTicketCoverage(paylink, schedule, proverTip, withdrawalFee)
  const dust = burn.returned <= GOLDEN_TICKET_BRIDGE_REMAINDER
  return {
    paylink,
    youReceive: coverage?.immediate,
    eventual: coverage?.eventual,
    tagFee,
    tagWaived: tagFee === undefined ? undefined : tagFee === 0n,
    networkFee: sweepPart + withdrawalFee + WITHDRAW_RELAYER_TIP + (dust ? burn.returned : 0n),
    provingFee: proverTip,
    returned: dust ? 0n : burn.returned,
    burn: burn.burn,
    covers: coverage?.covers,
  }
}
