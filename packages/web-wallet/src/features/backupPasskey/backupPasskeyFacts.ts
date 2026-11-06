import { useCallback, useEffect, useMemo, useState } from "react"
import {
  backupLinks,
  fundingFits,
  isSavingsMoveSettled,
  unreadDeposits,
  useAfter,
  useCachedRecords,
  useStore,
  withNotes,
  WITHDRAWAL_TERMINAL_PHASES,
  type After,
  type BackupLinkHold,
  type ChunkFit,
  type PaylinkTransaction,
  type SavingsMoveRecord,
  type WithdrawalRecord,
  useResource,
} from "@obsidion/front-core"
import {
  type ContractService,
  fundingAmount,
  readBridgeDestination,
  RotationRouteNotLiveError,
  type FundingAmount,
  type ObsidionWallet,
  type SpendShape,
} from "@obsidion/sdk"
import type { Address } from "viem"
import { getConfig } from "../../config/env"
import { getFeeTokenBridgeTuple, l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import { wallClock } from "../../lib/clock"
import { useSession } from "../../session/session"
import { useOldVersionHoldings } from "../migration/oldVersionBalance"
import { useUpgradeLock } from "../migration/upgradeLock"
import { unlockedSessionKeys } from "../registration/registrationResume"
import { rescanPaylinks, usePaylinksRescanned } from "../paylink/paylinkRescanState"
import { getSavingsMoveStore } from "../savings/savingsMoveStore"
import { useSavingsMovesReplayed } from "../savings/savingsTasks"
import { useWithdrawals } from "../withdraw/useWithdrawals"
import { moveCount, readMoveBalances, type MoveBalance } from "./backupMoveTokens"

/** What the entry reads off the chain before it can be pressed. */
export interface ChainFacts {
  routeLive: boolean
  balance: bigint
  fundingAmount: bigint
  chunk: ChunkFit
  /** A move plan exists over every balance the add moves. */
  plan: boolean
  /** How many sponsored transfers the move takes, at most, Savings' shares included. */
  moves: number
}

/** What the entry reads off the chain, before it knows this device's open paylinks. */
export interface ChainReads {
  funding: FundingAmount | undefined
  /** Main Account's, which pays the funding and takes the paylink refunds. */
  shape: SpendShape
  cap: bigint
  /** The other balances the add moves: Savings' shares. */
  others?: readonly Pick<MoveBalance, "shape" | "cap">[]
}

// The deposit set is read by the move itself; here a balance held in deposits makes the plan an
// upper bound.
export function chainFacts(
  input: ChainReads & {
    /** The open paylinks' amounts, which land on Main Account's balance before the move. */
    refunds?: readonly bigint[]
  },
): ChainFacts {
  const { funding, shape, cap, others = [], refunds = [] } = input
  const amount = funding?.amount ?? 0n
  const deposits = unreadDeposits(shape)
  let moves = 0
  let plan = false
  try {
    moves = moveCount([{ shape: withNotes(shape, refunds), cap }, ...others])
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

/** The chain reads, and Main Account's token, which the paylinks the add takes back pay in. */
export async function readChainReads(
  wallet: ObsidionWallet,
  contractService: ContractService,
): Promise<ChainReads & { token: string }> {
  const keys = await unlockedSessionKeys(wallet)
  if (!keys) throw new Error("wallet locked")
  const config = getConfig()
  const client = l1PublicClient(config)
  const envTuple = await getFeeTokenBridgeTuple(config)
  const [funding, [main, ...others]] = await Promise.all([
    readBridgeDestination(client, envTuple).then((tuple) =>
      fundingAmount(client, {
        tuple,
        plainWithdrawalExecutor: requireTupleField(envTuple, "plainWithdrawalExecutor") as Address,
        proverTip: 0n,
      }).catch((err: unknown) => {
        if (err instanceof RotationRouteNotLiveError) return undefined
        throw err
      }),
    ),
    readMoveBalances(wallet, contractService, keys.account.getAddress()),
  ])
  return { funding, ...main!, others }
}

/**
 * The open paylinks `account` made that the add takes back, and what holds it instead, kept current
 * with the stored rows. Undefined until this page's rescan has rebuilt every link the account made;
 * `unreadable` while the latest pass failed or deferred a link.
 */
function useBackupLinks(
  account: string | undefined,
  token: string | undefined,
): { open: PaylinkTransaction[]; hold?: BackupLinkHold } | "unreadable" | undefined {
  const rescanned = usePaylinksRescanned(account)
  const network = useResource(useSession().wallet)?.networkId
  // The links still in escrow, once loaded: a link not yet read is not "none".
  const rows = useStore(useSession().reads.open)
  // Ticks, so an expiry or a closing cancel window changes the hold while the sheet stays open.
  const nowSec = Math.floor(useStore(wallClock) / 1000)
  const links = useMemo(
    () =>
      account && token ? backupLinks(rows.records, { account, network, token, nowSec }) : undefined,
    [rows.records, account, network, token, nowSec],
  )
  if (rescanned === false || rows.failed) return "unreadable"
  return rescanned && rows.loaded ? links : undefined
}

/** Whether a withdrawal of this wallet's is still on its way. */
export const withdrawalInFlight = (records: readonly Pick<WithdrawalRecord, "phase">[]) =>
  records.some((record) => !WITHDRAWAL_TERMINAL_PHASES.has(record.phase))

/**
 * Whether a Savings move has yet to land. A move whose burn failed funded nothing, and one stranded
 * on an old version can't finish here, so waiting on either would block the add for good. A Sky
 * burn a rescan rebuilt has no move record until the settle pass adopts it, so it counts as moving.
 */
export function savingsMoving(
  moves: readonly SavingsMoveRecord[],
  burns: readonly WithdrawalRecord[],
): boolean {
  const byId = new Map(burns.map((burn) => [burn.localId, burn]))
  const adopted = new Set(moves.map((move) => move.withdrawalLocalId))
  return (
    moves.some((move) => !isSavingsMoveSettled(move, byId.get(move.withdrawalLocalId))) ||
    burns.some((burn) => !!burn.skyMove && burn.phase !== "failed" && !adopted.has(burn.localId))
  )
}

export type EntryFacts = ChainFacts & {
  savingsMoving: boolean
  withdrawalInFlight: boolean
  /** Open paylinks the add takes back, one sponsored refund each. */
  links: number
  /** An open paylink the add waits on instead of taking it back. */
  linkHold?: BackupLinkHold
  /** Money on an old version still to move, or an upgrade not yet finished here. */
  historicBalance: boolean
}

/** A fresh device stores a Savings move it has no record of only once the replay adopts it. */
const READ_AFTER: After = { firstBalance: true, movesReplayed: true }

/**
 * The entry's facts for the signed-in account: the chain's read once the device has synced, and
 * again on `refresh`; the rest kept current. `checking` while they are read, `unreadable` when a
 * read failed, the Savings moves replay included, since a move it missed would land after the
 * switch, unclaimed; `refresh` also starts a paylink rescan and reads the Savings moves again.
 */
export function useBackupEntryFacts(
  wallet: ObsidionWallet | undefined,
  contractService: ContractService | null,
  active: boolean,
): { facts: "checking" | "unreadable" | EntryFacts; refresh: () => void } {
  const [chain, setChain] = useState<"checking" | "unreadable" | (ChainReads & { token: string })>(
    "checking",
  )
  const [run, setRun] = useState(0)
  const withdrawals = useWithdrawals()
  const holdings = useOldVersionHoldings()
  const identity = useStore(useSession().identity, (s) => s.value?.address)
  const upgrade = useUpgradeLock(identity).state
  const links = useBackupLinks(identity, typeof chain === "string" ? undefined : chain.token)
  const synced = useAfter(useSession().milestones, READ_AFTER)
  const savingsMoves = useCachedRecords(useMemo(getSavingsMoveStore, []))
  const replayed = useSavingsMovesReplayed(identity)
  useEffect(() => {
    if (!active || !wallet || !contractService || !synced) return
    let stale = false
    setChain("checking")
    readChainReads(wallet, contractService).then(
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
  }, [active, wallet, contractService, synced, run])
  const retryMoves = savingsMoves.retry
  const refresh = useCallback(() => {
    setRun((n) => n + 1)
    rescanPaylinks()
    retryMoves()
  }, [retryMoves])
  if (typeof chain === "string") return { facts: chain, refresh }
  if (links === "unreadable" || replayed === false || savingsMoves.failed)
    return { facts: "unreadable", refresh }
  const loaded =
    withdrawals.hydrated && !holdings.pending && savingsMoves.hydrated && replayed !== undefined
  if (!synced || !loaded || links === undefined) return { facts: "checking", refresh }
  return {
    facts: {
      ...chainFacts({ ...chain, refunds: links.open.map((row) => row.amountAtomic) }),
      links: links.open.length,
      ...(links.hold && { linkHold: links.hold }),
      savingsMoving: savingsMoving(savingsMoves.records, withdrawals.records),
      withdrawalInFlight: withdrawalInFlight(withdrawals.records),
      historicBalance: holdings.total > 0n || upgrade === "held",
    },
    refresh,
  }
}
