/**
 * What one registration costs.
 *
 * Two prices per kind. The schedule is what the chain enforces — the account service's signed
 * terms, else the RegistrationController's immutable schedule — and its floor decides only whether
 * a deposit is accepted. The ask is what the wallets tell a user to deposit; it sits above the
 * floor so a deposit swapped from another token still clears it, and a depositor of the ask is
 * credited `ask - fee`.
 *
 * Code and tests read both from here. Places that restate them by hand:
 *
 * - `iac/secrets/manifest.json` schedule defaults (pinned by account-service's registrationAskDrift test)
 * - `iac/docs/services.md` and `packages/backend/account-service/.env.example`
 * - `packages/desktop-download-web/content/{get-started.md,limits.md,faq.json}`
 * - `packages/web-wallet/scripts/ui-capture/plans/flows/limits-registration-origin.json` amounts
 * - `docs/paylink/golden-ticket.md` and `docs/limits-validation.md`
 */

import type { RegistrationKind, RegistrationSchedule } from "../types/registration.js"

/** The deposit each kind is asked for, 18-dp DAI. */
export const REGISTRATION_ASK_DEPOSIT_TOTAL: Record<RegistrationKind, bigint> = {
  standard: 5n * 10n ** 18n,
  earned_tag: 1n * 10n ** 18n,
}

/** The schedule each kind is signed when the account service runs on its defaults, 18-dp DAI. */
export const REGISTRATION_SCHEDULE_DEFAULTS: Record<RegistrationKind, RegistrationSchedule> = {
  standard: { fee: 425n * 10n ** 16n, min: 15n * 10n ** 16n },
  // The fee is the registration sweep fee: a random tag pays only the relayer.
  earned_tag: { fee: 5n * 10n ** 17n, min: 15n * 10n ** 16n },
}

/**
 * Every fee the account service has signed, 18-dp DAI. A registration address commits to its fee and
 * a re-sign can quote a lower one, so recovery tries each: 0 (free grants before the sweep fee), 0.5
 * (the sweep fee: random tags and golden tickets), then the standard schedule's past fees.
 */
export const REGISTRATION_SIGNED_FEES: readonly bigint[] = [
  0n,
  5n * 10n ** 17n,
  425n * 10n ** 16n,
  49n * 10n ** 17n,
  5n * 10n ** 18n,
  55n * 10n ** 17n,
  10n * 10n ** 18n,
]

/**
 * The least a deposit on this schedule may be for the chain to take it.
 *
 * Three contracts price a deposit `D` against a schedule of minimum `M` and fee `F`:
 *
 * - `RegistrationController._checkPayment` requires `D >= M + F`
 * - the SIPA sweep requires `D > F`, the sweep fee being carved out of `F`
 * - `OxidePortal.deposit` requires `D - F > 0`
 *
 * So a deposit is accepted exactly when it reaches `F + max(M, 1)`.
 */
export function registrationFloor(schedule: RegistrationSchedule): bigint {
  return schedule.fee + (schedule.min > 1n ? schedule.min : 1n)
}

/**
 * The largest conversion loss a SIPA's stablecoin swap accepts, in basis points. Mirrors oxide's
 * `ThreePoolLib`: a mainnet USDC/USDT deposit is swapped into DAI before the floor is checked, so
 * what the chain floors is at least `parity * (1 - this)`.
 */
export const SIPA_SWAP_MAX_SLIPPAGE_BPS = 100n

/**
 * The deductions a golden-ticket registration pays beyond its schedule. The link's note is burned
 * to L1 through the registration SIPA; the executor takes its fee and the tips pay the withdrawal's
 * relayer and prover.
 */
export interface GoldenTicketDeductions {
  /** The plain withdrawal executor's `FEE()`. */
  withdrawalFee: bigint
  relayerTip: bigint
  proverTip: bigint
  bridgeRemainder: bigint
}

/**
 * What a ticket registration moves: `sipaTarget` is what the SIPA must receive after the
 * withdrawal leg, `burn` the gross L2 amount that gets it there, and `returned` the L2 deposit the
 * sweep sends back after the fee.
 */
export interface GoldenTicketQuote {
  sipaTarget: bigint
  burn: bigint
  returned: bigint
}

/**
 * Sizes a ticket registration off the signed schedule and the live deductions, in base units.
 * The SIPA target is the larger of the schedule floor and the fee plus the bridge remainder, so a
 * minimum above the remainder is funded once, never on top of it.
 */
export function goldenTicketQuote(
  schedule: RegistrationSchedule,
  deductions: GoldenTicketDeductions,
): GoldenTicketQuote {
  const floor = registrationFloor(schedule)
  const withRemainder = schedule.fee + deductions.bridgeRemainder
  const sipaTarget = floor > withRemainder ? floor : withRemainder
  return {
    sipaTarget,
    burn: sipaTarget + deductions.withdrawalFee + deductions.relayerTip + deductions.proverTip,
    returned: sipaTarget - schedule.fee,
  }
}
