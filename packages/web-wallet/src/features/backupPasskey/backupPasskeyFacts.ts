import { useCallback, useEffect, useState } from "react"
import {
  fundingFits,
  planMove,
  unreadDeposits,
  WITHDRAWAL_TERMINAL_PHASES,
  type ChunkFit,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import {
  ContractService,
  fundingAmount,
  readBridgeDestination,
  readSpendShape,
  RotationRouteNotLiveError,
  type FundingAmount,
  type ObsidionWallet,
  type SpendShape,
} from "@obsidion/sdk"
import type { Address } from "viem"
import { getConfig } from "../../config/env"
import { getWebOxideToken } from "../../config/classArtifacts"
import { getFeeTokenBridgeTuple, l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { useOldVersionHoldings } from "../migration/oldVersionBalance"
import { useUpgradeLock } from "../migration/upgradeLock"
import { unlockedSessionKeys } from "../onboarding/registrationResume"
import { currentTxAmountCap } from "../token/oxideToken"
import { useWithdrawals } from "../withdraw/useWithdrawals"

/** What the entry reads off the chain before it can be pressed. */
export interface ChainFacts {
  routeLive: boolean
  balance: bigint
  fundingAmount: bigint
  chunk: ChunkFit
  /** A move plan exists over the balance. */
  plan: boolean
  /** How many sponsored sends the move takes, at most. */
  moves: number
}

// The deposit set is read by the move itself; here a balance held in deposits makes the plan an
// upper bound.
export function chainFacts(input: {
  funding: FundingAmount | undefined
  shape: SpendShape
  cap: bigint
}): ChainFacts {
  const { funding, shape, cap } = input
  const amount = funding?.amount ?? 0n
  const deposits = unreadDeposits(shape)
  let moves = 0
  let plan = false
  try {
    moves = planMove(shape, cap, deposits).m
    plan = true
  } catch {
    // No plan over this balance and cap; the entry says so.
  }
  return {
    routeLive: funding !== undefined,
    balance: shape.balance,
    fundingAmount: amount,
    chunk: fundingFits(amount, cap, shape, deposits),
    plan,
    moves,
  }
}

export async function readChainFacts(
  wallet: ObsidionWallet,
  contractService: ContractService,
): Promise<ChainFacts> {
  const keys = await unlockedSessionKeys(wallet)
  if (!keys) throw new Error("wallet locked")
  const config = getConfig()
  const client = l1PublicClient(config)
  const envTuple = await getFeeTokenBridgeTuple(config)
  const [tuple, token] = await Promise.all([
    readBridgeDestination(client, envTuple),
    getWebOxideToken(wallet, contractService, requireTupleField(envTuple, "l2Token")),
  ])
  const [funding, shape, cap] = await Promise.all([
    fundingAmount(client, {
      tuple,
      plainWithdrawalExecutor: requireTupleField(envTuple, "plainWithdrawalExecutor") as Address,
      proverTip: 0n,
    }).catch((err: unknown) => {
      if (err instanceof RotationRouteNotLiveError) return undefined
      throw err
    }),
    readSpendShape(wallet, token, keys.account.getAddress()),
    currentTxAmountCap(),
  ])
  return chainFacts({ funding, shape, cap })
}

/** Whether a withdrawal of this wallet's is still on its way. */
export const withdrawalInFlight = (records: readonly Pick<WithdrawalRecord, "phase">[]) =>
  records.some((record) => !WITHDRAWAL_TERMINAL_PHASES.has(record.phase))

export type EntryFacts = ChainFacts & {
  withdrawalInFlight: boolean
  /** Money on an old version still to move, or an upgrade not yet finished here. */
  historicBalance: boolean
}

/**
 * The entry's facts for the signed-in account, read once per mount and again on `refresh`:
 * `checking` while they are read, `unreadable` when a read failed.
 */
export function useBackupEntryFacts(
  wallet: ObsidionWallet | undefined,
  contractService: ContractService | null,
  active: boolean,
): { facts: "checking" | "unreadable" | EntryFacts; refresh: () => void } {
  const [chain, setChain] = useState<"checking" | "unreadable" | ChainFacts>("checking")
  const [run, setRun] = useState(0)
  const withdrawals = useWithdrawals()
  const holdings = useOldVersionHoldings()
  const upgrade = useUpgradeLock(loadWalletIdentity()?.address).state
  useEffect(() => {
    if (!active || !wallet || !contractService) return
    let stale = false
    setChain("checking")
    readChainFacts(wallet, contractService).then(
      (facts) => {
        if (!stale) setChain(facts)
      },
      (err: unknown) => {
        console.warn("[backup passkey] entry facts read failed", err)
        if (!stale) setChain("unreadable")
      },
    )
    return () => {
      stale = true
    }
  }, [active, wallet, contractService, run])
  const refresh = useCallback(() => setRun((n) => n + 1), [])
  if (typeof chain === "string") return { facts: chain, refresh }
  if (!withdrawals.hydrated || holdings.pending) return { facts: "checking", refresh }
  return {
    facts: {
      ...chain,
      withdrawalInFlight: withdrawalInFlight(withdrawals.records),
      historicBalance: holdings.total > 0n || upgrade === "held",
    },
    refresh,
  }
}
