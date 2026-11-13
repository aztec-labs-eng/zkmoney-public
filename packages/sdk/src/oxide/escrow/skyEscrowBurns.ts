/**
 * The account's burns into Sky escrows of given factories, read back from their recovery events
 * through one portal's withdrawal source: what a device with no record of a Sky move rebuilds it
 * from.
 */
import { isAddressEqual, type Address } from "viem"
import type {
  ScannedWithdrawEvent,
  WithdrawEventSource,
} from "../../services/withdrawal/withdrawEventSource.js"
import type { SkyWithdrawalMemo } from "../../services/withdrawal/withdrawalMemo.js"

/** A burn whose `l1Recipient` is the escrow its `sky` args derive. */
export type SkyEscrowBurn = ScannedWithdrawEvent & { sky: SkyWithdrawalMemo }

/** `burn` when it paid an escrow of `factory`. The source keeps only a memo that derives the escrow. */
export function readSkyEscrowBurn(
  burn: ScannedWithdrawEvent,
  factory: Address,
): SkyEscrowBurn | undefined {
  const { sky } = burn
  return sky && isAddressEqual(sky.factory, factory) ? { ...burn, sky } : undefined
}

/**
 * The burns `source` reads in L2 blocks `[fromBlock, toBlockExclusive)` that paid an escrow of one
 * of `factories`: the account's burns through that source's portal only. `unread`: a burn of the
 * range this read could not read, which a later read finds.
 */
export async function recoverSkyEscrowBurns(
  source: Pick<WithdrawEventSource, "scanWithdrawals">,
  args: { factories: readonly Address[]; fromBlock: number; toBlockExclusive: number },
): Promise<{ burns: SkyEscrowBurn[]; unread: boolean }> {
  const { withdrawals, unread } = await source.scanWithdrawals(
    args.fromBlock,
    args.toBlockExclusive,
  )
  const burns = withdrawals.flatMap((burn) => {
    const factory = args.factories.find((f) => burn.sky && isAddressEqual(burn.sky.factory, f))
    return (factory && readSkyEscrowBurn(burn, factory)) ?? []
  })
  return { burns, unread: unread.length > 0 }
}
