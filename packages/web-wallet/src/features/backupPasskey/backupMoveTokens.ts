import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { planMove, unreadDeposits } from "@obsidion/front-core"
import {
  readSpendShape,
  type ContractService,
  type ObsidionWallet,
  type SpendShape,
} from "@obsidion/sdk"
import type { Address } from "viem"
import { getWebOxideToken } from "../../config/classArtifacts"
import { requireTupleField } from "../../config/oxideTuple"
import type { PageChain } from "../../session/pageChain"

/**
 * The tokens a backup add moves to the new account: Main Account's first, then Savings' shares
 * where the deployment has Savings.
 */
export async function backupMoveTokens(reads: PageChain): Promise<string[]> {
  const [main, savings] = await Promise.all([
    reads.feeTokenBridgeTuple.read(),
    reads.savingsTuple.read(),
  ])
  return (savings ? [main, savings] : [main]).map((tuple) => requireTupleField(tuple, "l2Token"))
}

/** The most one transfer of `token` moves: its own portal's cap. */
export async function moveCap(reads: PageChain, token: string): Promise<bigint> {
  const { portal } = await reads.bridgeOfToken(token).read()
  return reads.txAmountCap(portal as Address).read()
}

/** A balance the add moves, and the most one transfer of it moves. */
export interface MoveBalance {
  token: string
  shape: SpendShape
  cap: bigint
}

/** Each balance a backup add moves out of `owner`, Main Account's first. */
export async function readMoveBalances(
  reads: PageChain,
  wallet: ObsidionWallet,
  contractService: ContractService,
  owner: AztecAddress,
): Promise<MoveBalance[]> {
  return Promise.all(
    (await backupMoveTokens(reads)).map(async (token) => {
      const [shape, cap] = await Promise.all([
        getWebOxideToken(wallet, contractService, token).then((oxide) =>
          readSpendShape(wallet, oxide, owner),
        ),
        moveCap(reads, token),
      ])
      return { token, shape, cap }
    }),
  )
}

/** How many sponsored sends moving every one of `balances` takes, at most. Throws where one has no plan. */
export const moveCount = (balances: readonly Pick<MoveBalance, "shape" | "cap">[]): number =>
  balances.reduce((n, { shape, cap }) => n + planMove(shape, cap, unreadDeposits(shape)).m, 0)
