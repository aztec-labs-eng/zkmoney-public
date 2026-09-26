import type { Address } from "viem"
import type { WithdrawalRecord } from "./types"

/**
 * Who a withdrawal pays — on chain, and in the end.
 *
 * A direct withdrawal has one answer to both. A swap-on-withdraw has two: the portal releases DAI
 * to a counterfactual escrow, and a later L1 operation swaps and pays the recipient. Every
 * consumer that names an address — the burn, the release-tx lookup, the detail sheet, the
 * self-finalize helper page — has to pick the right one, so the pick is made once here.
 */
export interface WithdrawalRecipients {
  /** L1 address the burn pays and the portal releases to. An escrow on a swap. */
  release: Address
  /** Where the value ends up: the address the user chose. Equals `release` on a direct withdrawal. */
  final: Address
  /** A swap leg stands between the release and `final`. */
  viaEscrow: boolean
}

type WithdrawalRecipientFields = Pick<WithdrawalRecord, "recipient" | "swapOutput" | "swapEscrow">

export function withdrawalRecipients(record: WithdrawalRecipientFields): WithdrawalRecipients {
  // `swapOutput` and `swapEscrow` are written together before the burn signs, so a swap record
  // without an escrow is corrupt. Reading it as direct keeps the sheet renderable and names the
  // only address the record still has, rather than showing escrow copy over a recipient address.
  const escrow = record.swapOutput ? record.swapEscrow : undefined
  return {
    release: escrow ?? record.recipient,
    final: record.recipient,
    viaEscrow: escrow !== undefined,
  }
}
