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
import { getConfig } from "../../config/env"
import { getFeeTokenBridgeTuple, l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import { getSavingsTuple } from "../savings/savingsGateway"
import { bridgeOfToken, txAmountCap } from "../token/oxideToken"

/**
 * The tokens a backup add moves to the new account: Main Account's first, then Savings' shares
 * where the deployment has Savings.
 */
export async function backupMoveTokens(): Promise<string[]> {
  const config = getConfig()
  const [main, savings] = await Promise.all([
    getFeeTokenBridgeTuple(config),
    getSavingsTuple(config),
  ])
  return (savings ? [main, savings] : [main]).map((tuple) => requireTupleField(tuple, "l2Token"))
}

/** The most one transfer of `token` moves: its own portal's cap. */
export async function moveCap(token: string): Promise<bigint> {
  const { portal } = await bridgeOfToken(token)
  return txAmountCap(l1PublicClient(getConfig()), portal as Address)
}

/** A balance the add moves, and the most one transfer of it moves. */
export interface MoveBalance {
  token: string
  shape: SpendShape
  cap: bigint
}

/** Each balance a backup add moves out of `owner`, Main Account's first. */
export async function readMoveBalances(
  wallet: ObsidionWallet,
  contractService: ContractService,
  owner: AztecAddress,
): Promise<MoveBalance[]> {
  return Promise.all(
    (await backupMoveTokens()).map(async (token) => {
      const [shape, cap] = await Promise.all([
        getWebOxideToken(wallet, contractService, token).then((oxide) =>
          readSpendShape(wallet, oxide, owner),
        ),
        moveCap(token),
      ])
      return { token, shape, cap }
    }),
  )
}

/** How many sponsored sends moving every one of `balances` takes, at most. Throws where one has no plan. */
export const moveCount = (balances: readonly Pick<MoveBalance, "shape" | "cap">[]): number =>
  balances.reduce((n, { shape, cap }) => n + planMove(shape, cap, unreadDeposits(shape)).m, 0)
