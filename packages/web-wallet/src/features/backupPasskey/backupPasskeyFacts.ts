import { useCallback, useEffect, useMemo, useState } from "react"
import { bestEffortSync, WalletError } from "@obsidion/core/errors"
import {
  backupAddFees,
  backupLinks,
  FUNDING_STATUS,
  fundingFits,
  isMoveSettled,
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
  type MoveRecord,
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
import { gatedLinks } from "./backupEntryGate"
import { useWithdrawals } from "../withdraw/useWithdrawals"
import { moveCount, readMoveBalances, type MoveBalance } from "./backupMoveTokens"

/** What the entry reads off the chain before it can be pressed. */
export interface ChainFacts {
  routeLive: boolean
  balance: bigint
  fundingAmount: bigint
  /** The part of the funding that comes back once the backup is active; none without a route. */
  credited: bigint
  chunk: ChunkFit
  /** Whether one transfer from Main Account funds `amount`, such as the funding with a tip. */
  fits: (amount: bigint) => boolean
  /** A move plan exists over every balance the add moves. */
  plan: boolean
  /** How many sponsored transfers the move takes, at most, Savings' shares included. */
  moves: number
  /** What the add costs, before it starts; none while the route is not live. */
  quote?: BackupAddQuote
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
  // A throw means no plan over this balance and cap; the entry says so.
  const moves = bestEffortSync<number | undefined>(
    () => moveCount([{ shape: withNotes(shape, refunds), cap }, ...others]),
    undefined,
  )
  const fit = (at: bigint) => fundingFits(at, cap, shape, deposits)
  return {
    routeLive: funding !== undefined,
    balance: shape.balance,
    fundingAmount: amount,
    credited: funding?.credited ?? 0n,
    chunk: fit(amount),
    fits: (at) => fit(at).kind === "fits",
    plan: moves !== undefined,
    moves: moves ?? 0,
    ...(funding && { quote: backupAddFees(funding) }),
  }
}

/** The chain reads, and Main Account's token, which the paylinks the add takes back pay in. */
export async function readChainReads(
  session: Pick<Session, "auth" | "page" | "wallet" | "contractService">,
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
    readMoveBalances(chain, wallet, contractService, keys.account.getAddress()),
  ])
  return { funding, ...main!, others }
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

/** Move burns that funded something and no move carries yet: the replay has not rebuilt them. */
export function unadoptedBurns(
  moves: readonly MoveRecord[],
  burns: readonly WithdrawalRecord[],
): number {
  const local = new Set(moves.map((move) => move.withdrawalLocalId))
  const replayed = new Set(moves.map((move) => move.replayedFrom?.toLowerCase()))
  return burns.filter(
    (burn) =>
      (!!burn.skyMove || !!burn.vaultMove) &&
      burn.phase !== "failed" &&
      !local.has(burn.localId) &&
      !replayed.has(burn.l2TxHash?.toLowerCase()),
  ).length
}

/**
 * Whether a Savings move has yet to land. A settled move never blocks the add: a failed burn funded
 * nothing, and a stranded one can't finish here. A Sky burn the replay has not rebuilt yet counts
 * as moving.
 */
export function savingsMoving(
  moves: readonly MoveRecord[],
  burns: readonly WithdrawalRecord[],
): boolean {
  return moves.some((move) => !isMoveSettled(move)) || unadoptedBurns(moves, burns) > 0
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
 * The entry's facts for the signed-in account: the chain's read once the device has synced,
 * whenever Main's balance changes and on `refresh`; the rest kept current and gated by
 * `gatedLinks`. `refresh` also starts a paylink rescan. Saved Savings moves that do not read stay
 * unreadable until the page reloads.
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
  const moves = useStore(useSession().moves.view)
  // A deposit landing while Passkeys is open changes the spend shape, so the chain is read again.
  const balance = useStore(useSession().balances.view, (view) => view.main?.atomic)
  // eslint-disable-next-line local/effect-hook -- debt
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
  }, [active, session, built, synced, run, balance])
  const sweep = useSession().paylinkSweep
  const refresh = useCallback(() => {
    setRun((n) => n + 1)
    sweep.recheck()
  }, [sweep])
  if (typeof chain === "string") return { facts: chain, refresh }
  const open = gatedLinks({
    links,
    adopted: unadoptedBurns(moves.records, withdrawals.records) === 0,
    moves,
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
      savingsMoving: savingsMoving(moves.records, withdrawals.records),
      withdrawalInFlight: withdrawalInFlight(withdrawals.records),
      historicBalance: holdings.total > 0n || upgrade === "held",
    },
    refresh,
  }
}
