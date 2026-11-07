/**
 * The ClaimFPC rails this wallet declares, by name.
 *
 * A rail is one sponsorship offer of the deployed FPC: a gate that admits users, a policy bounding
 * what their batches may carry, and an allowance. The deployment publishes its rails in the
 * ClaimFPC record's manifest; a flow names the one it rides and `railByName` resolves the id. A
 * name this deployment does not offer fails loudly rather than sending a batch the FPC refuses.
 */

/** One sponsored batch, ever, with no refill — what a NameClaim buys. Carries the registration
 *  SIPA broadcast today; the policy is open, so what it carries is the flow's choice. */
export const RAIL_REGISTRATION_BROADCAST = "registration-broadcast"

/** Sponsors the product's flows: sends, paylinks, deposits, withdrawals. */
export const RAIL_REGISTERED = "registered"

/**
 * Entered by gift alone: a link creator hands one use of their `sponsored` allowance to the link's
 * escrow, and whoever holds the link spends it. Same open policy, one use, never refills.
 */
export const RAIL_VOUCHER = "voucher"
