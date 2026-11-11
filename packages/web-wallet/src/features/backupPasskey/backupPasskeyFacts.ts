import { useCallback, useEffect, useMemo, useState } from "react"
import { bestEffortSync, WalletError } from "@obsidion/core/errors"
import {
  backupAddFees,
  backupLinks,
  FUNDING_STATUS,
  fundingFits,
  isSavingsMoveSettled,
  operationIndex,
  unreadDeposits,
  useAfter,
  useStore,
  withNotes,
  withOperation,
  WITHDRAWAL_TERMINAL_PHASES,
  type After,
  type BackupAddQuote,
  type BackupLinkHold,
  type ChunkFit,
  type OperationRecord,
  type PaylinkRecord,
  type RecordSet,
  type SavingsMoveRecord,
  type WithdrawalRecord,
  serviceStatus,
} from "@obsidion/front-core"
import {
  fundingAmount,
  readBridgeDestination,
  RotationRouteNotLiveError,
  type FundingAmount,
  type SpendShape,
} from "@obsidion/sdk"
import type { Address } from "viem"
import { l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import { useSession, type Session } from "../../session/session"
import { useOldVersionHoldings } from "../migration/oldVersionBalance"
import { useUpgradeLock } from "../migration/upgradeLock"
import { unlockedSessionKeys } from "../registration/registrationResume"
import { useSavingsMovesReplayed } from "../savings/savingsTasks"
import { gatedLinks } from "./backupEntryGate"
import { useWithdrawals } from "../withdraw/useWithdrawals"
import { readBackupAddTakesMs } from "./backupAddTime"
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
  /** What the add costs and takes, before it starts; none while the route is not live. */
  quote?: BackupAddQuote
}

/** What the entry reads off the chain, before it knows this device's open paylinks. */
export interface ChainReads {
  funding: FundingAmount | undefined
  takesMs: number
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
  const { funding, takesMs, shape, cap, others = [], refunds = [] } = input
  const amount = funding?.amount ?? 0n
  const deposits = unreadDeposits(shape)
  // A throw means no plan over this balance and cap; the entry says so.
  const moves = bestEffortSync<number | undefined>(
    () => moveCount([{ shape: withNotes(shape, refunds), cap }, ...others]),
    undefined,
  )
  return {
    routeLive: funding !== undefined,
    balance: shape.balance,
    fundingAmount: amount,
    chunk: fundingFits(amount, cap, shape, deposits),
    plan: moves !== undefined,
    moves: moves ?? 0,
    ...(funding && { quote: { ...backupAddFees(funding), takesMs } }),
  }
}

/** The chain reads, and Main Account's token, which the paylinks the add takes back pay in. */
export async function readChainReads(
  session: Pick<Session, "auth" | "burnDurations" | "page" | "wallet" | "contractService">,
): Promise<ChainReads & { token: string }> {
  const [wallet, contractService] = await Promise.all([
    session.wallet.ready(),
    session.contractService.ready(),
  ])
  const keys = await unlockedSessionKeys(session, wallet)
  if (!keys) throw new WalletError("account.locked", "wallet locked")
  const { config, chain } = session.page
  const client = l1PublicClient(config)
  const envTuple = await chain.feeTokenBridgeTuple.read()
  const [funding, takesMs, [main, ...others]] = await Promise.all([
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
    readBackupAddTakesMs(session.burnDurations, session.page, wallet.node),
    readMoveBalances(chain, wallet, contractService, keys.account.getAddress()),
  ])
  return { funding, takesMs, ...main!, others }
}

/**
 * The open paylinks `account` made that the add takes back among `links`, each funded as its
 * operation says, and what holds the add instead. Undefined until a rescan has rebuilt every link
 * the account made; `unreadable` while the latest pass failed or deferred a link, or a read failed.
 */
export function selectBackupLinks(
  rescanned: boolean | undefined,
  links: RecordSet<PaylinkRecord>,
  ops: RecordSet<OperationRecord>,
  opts: { account?: string; network?: string; token?: string; nowSec: number },
): { open: PaylinkRecord[]; hold?: BackupLinkHold } | "unreadable" | undefined {
  if (rescanned === false || links.failed || ops.failed) return "unreadable"
  const { account, network, token, nowSec } = opts
  if (!rescanned || !links.loaded || !ops.loaded || !account || !token) return undefined
  const index = operationIndex(ops.records)
  const statusOf = (link: PaylinkRecord) => FUNDING_STATUS[withOperation(link, index).funding]
  return backupLinks(links.records, statusOf, { account, network, token, nowSec })
}

function useBackupLinks(
  account: string | undefined,
  token: string | undefined,
): { open: PaylinkRecord[]; hold?: BackupLinkHold } | "unreadable" | undefined {
  const rescanned = useStore(useSession().paylinkSweep.rescanned)
  const network = useStore(useSession().page.networkId)
  // The links still in escrow, once loaded: a link not yet read is not "none".
  const links = useStore(useSession().reads.open)
  const ops = useStore(useSession().operations.view)
  // Ticks, so an expiry or a closing cancel window changes the hold while the sheet stays open.
  const { wallClock } = useSession().page
  const nowSec = Math.floor(useStore(wallClock) / 1000)
  return useMemo(
    () => selectBackupLinks(rescanned, links, ops, { account, network, token, nowSec }),
    [rescanned, links, ops, account, network, token, nowSec],
  )
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

/** A fresh device has a Savings move it has no record of only once the replay rebuilds its burn. */
const READ_AFTER: After = { firstBalance: true, movesReplayed: true }

/**
 * The entry's facts for the signed-in account: the chain's read once the device has synced, and
 * again on `refresh`; the rest kept current and gated by `gatedLinks`. `refresh` also starts a
 * paylink rescan. Saved Savings moves that do not read stay unreadable until the page reloads.
 */
export function useBackupEntryFacts(active: boolean): {
  facts: "checking" | "unreadable" | EntryFacts
  refresh: () => void
} {
  const [chain, setChain] = useState<"checking" | "unreadable" | (ChainReads & { token: string })>(
    "checking",
  )
  const [run, setRun] = useState(0)
  const withdrawals = useWithdrawals()
  const holdings = useOldVersionHoldings()
  const session = useSession()
  const wallet = useStore(session.wallet, serviceStatus)
  const contracts = useStore(session.contractService, serviceStatus)
  const built = wallet === "ready" && contracts === "ready"
  const identity = useStore(useSession().identity, (s) => s.value?.address)
  const upgrade = useUpgradeLock(identity).state
  const links = useBackupLinks(identity, typeof chain === "string" ? undefined : chain.token)
  const synced = useAfter(useSession().milestones, READ_AFTER)
  const savingsMoves = useStore(useSession().savingsMoves.view)
  const replayed = useSavingsMovesReplayed()
  const adopted = useStore(useSession().savingsSettleDue, (due) => due.unadopted === 0)
  // eslint-disable-next-line local/effect-hook -- ZKM-1806
  useEffect(() => {
    if (!active || !built || !synced) return
    let stale = false
    setChain("checking")
    readChainReads(session).then(
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
  }, [active, session, built, synced, run])
  const sweep = useSession().paylinkSweep
  const refresh = useCallback(() => {
    setRun((n) => n + 1)
    sweep.recheck()
  }, [sweep])
  if (typeof chain === "string") return { facts: chain, refresh }
  const open = gatedLinks({
    links,
    replayed,
    adopted,
    savingsMoves,
    withdrawalsHydrated: withdrawals.hydrated,
    holdingsPending: holdings.pending,
    synced,
  })
  if (typeof open === "string") return { facts: open, refresh }
  return {
    facts: {
      ...chainFacts({ ...chain, refunds: open.open.map((row) => row.amountAtomic) }),
      links: open.open.length,
      ...(open.hold && { linkHold: open.hold }),
      savingsMoving: savingsMoving(savingsMoves.records, withdrawals.records),
      withdrawalInFlight: withdrawalInFlight(withdrawals.records),
      historicBalance: holdings.total > 0n || upgrade === "held",
    },
    refresh,
  }
}
