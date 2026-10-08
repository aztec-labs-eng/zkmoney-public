/**
 * What a SIPA implementation's sweep deposits into: the portal it is bound to and the amounts taken off the balance
 * before the portal meters it against its caps. All four are immutables, so a caller can cache them per
 * implementation. A deposit made under an earlier deployment keeps its own portal here, whichever deployment the
 * wallet has selected now.
 */
import type { Address, PublicClient } from "viem"
import { readSipaPlumbing, SIPAAbi } from "@oxide/l1-contracts"
import { readFpcFundingCut } from "./swapOnWithdraw.js"

export interface SipaPortalTerms {
  /** `PORTAL()`. */
  portal: Address
  /** `UNDERLYING()`: the portal's settlement token. */
  token: Address
  /** `DEPOSIT_FEE()`: paid to the relayer out of every sweep. */
  depositFee: bigint
  /** The portal's `FPC_FUNDING_CUT`, taken off what the sweep deposits. */
  fpcFundingCut: bigint
}

export async function readSipaPortalTerms(
  client: PublicClient,
  implementation: Address,
): Promise<SipaPortalTerms> {
  const [{ portal, depositFee }, token] = await Promise.all([
    readSipaPlumbing(client as never, implementation),
    client.readContract({ address: implementation, abi: SIPAAbi, functionName: "UNDERLYING" }),
  ])
  const fpcFundingCut = await readFpcFundingCut(client, portal)
  return { portal, token: token as Address, depositFee, fpcFundingCut }
}
