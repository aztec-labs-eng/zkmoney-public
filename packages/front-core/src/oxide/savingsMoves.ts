/**
 * A Sky savings move after its burn. The move's escrow deposits into the destination portal under a commitment this
 * account derived from the move's nonce, and the account claims that deposit on L2 as it claims a swept SIPA deposit.
 * Fronts keep their own move records and run this step from their sync.
 */
import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import type { TokenService } from "@obsidion/sdk"
import { OxidePortalAbi } from "@oxide/l1-contracts"
import {
  erc20Abi,
  erc4626Abi,
  parseEventLogs,
  parseUnits,
  type Address,
  type Hex,
  type PublicClient,
} from "viem"
import type { WithdrawalRecord } from "../core/services/bridge/types"
import { deriveSkyEscrowSalts } from "./oxideAccountKeys"
import { isAlreadyClaimedError } from "./depositClaimErrors"

export interface SavingsMove {
  direction: "in" | "out"
  /** The burn's withdrawal record. */
  withdrawalLocalId: string
  escrow: Address
  nonce: Hex
  recipientCommitment: Hex
  /** What was burned, in the source token's base units: DAI moving in, sUSDS shares moving out. */
  amount: string
  /** The L1 block the next search for the deposit starts at: where the move began, then where the last search ended. */
  depositScanFrom?: string
  /**
   * The L1 block the search's range begins at: the head at the burn, or a block before the burn's time. A cursor
   * without it is from before the floor was kept, and the next search starts over at the floor.
   */
  depositScanFloor?: string
  /**
   * The destination portal's deposit once the escrow has run, and whether this account claimed it.
   * `txHash` is the escrow run that made it.
   */
  deposit?: {
    inboxIndex: string
    amount: string
    claimed: boolean
    txHash?: Hex
    blockNumber?: string
    /** When the deposit's L1 block was made, ms: when the move's shares entered or left Savings' side. */
    at?: number
    /** When this device stored the claim, ms: the destination's balance holds it from its next read. */
    storedAt?: number
  }
  /**
   * The vault's own figures from the escrow run's receipt: the USDS it took in for a move in, or
   * paid out for a move out, and the shares. Exact where the quote only estimated.
   */
  vault?: { txHash: Hex; assets: string; shares: string }
  /** The transaction that should hold the vault's event was read and holds none for this move: the exact figures cannot be known. */
  vaultUnknown?: string
  /** The lookup that wrote `vault` or `vaultUnknown`; a marker from an older lookup is read again. */
  vaultLookup?: number
  /** Where the search for a move out's release (the DAI paid to its escrow) goes on from. */
  releaseScanFrom?: string
  /** Where the search for a claimed move's escrow run goes on from, when its deposit was kept without the hash. */
  runScanFrom?: string
  /** Where the escrow's funds were sent when it never ran. */
  recovered?: { to: Address; txHashes: Hex[] }
  /** The Sky escrow factory the move was built with; its portals are where the escrow deposits. */
  factory?: Address
}

/** Where a move's deposit lands, and the token service that claims it there. */
export interface SavingsMoveDestination {
  portal: Address
  /** The deployment's L1 token; a move out's release pays it to the move's escrow. */
  token?: Address
  /** The portal's deployment block, where the search for the deposit starts. */
  fromBlock?: bigint
  claimer: () => Promise<Pick<TokenService, "claimSweptDeposit">>
}

export interface SavingsMoveSettleDeps {
  publicClient: Pick<
    PublicClient,
    "getContractEvents" | "getBlockNumber" | "getBlock" | "getTransactionReceipt"
  >
  /** The sUSDS vault; its events on the escrow run's receipt give a move its exact figures. */
  vault?: Address
  /** A move whose transaction is known and holds no matching vault event: told once. */
  onVaultUnknown?: (move: SavingsMove, txHash: Hex, reason: string) => void
  masterSecret: Fr
  recipient: AztecAddress
  /** A move out lands on Main's deployment, a move in on Savings'. */
  main: SavingsMoveDestination
  savings: SavingsMoveDestination
  /**
   * Where a move with a factory lands: the portal its factory deposits into, which an older move
   * keeps after the profile moves Savings or Main to a new deployment. Without it, or for a move
   * without a factory, the current deployment for its direction.
   */
  destinationFor?: (move: SavingsMove & { factory: Address }) => Promise<SavingsMoveDestination>
}

/** The deployment `move`'s escrow deposits into. */
async function destinationOf(move: SavingsMove, deps: SavingsMoveSettleDeps) {
  if (move.factory && deps.destinationFor)
    return deps.destinationFor({ ...move, factory: move.factory })
  return move.direction === "in" ? deps.savings : deps.main
}

export const isSavingsMovePending = (move: SavingsMove) => !move.recovered && !move.deposit?.claimed

/** The lookup this code runs; an unknown written by an older one does not stick. */
const VAULT_LOOKUP = 2

/** Known for good: this lookup read the move's transaction and found no event for it. */
export const vaultKnownUnknown = (move: Pick<SavingsMove, "vaultUnknown" | "vaultLookup">) =>
  !!move.vaultUnknown && move.vaultLookup === VAULT_LOOKUP

/** A claimed move still without the vault's figures: the next pass reads them from its transaction. */
export const needsVaultFigures = (move: SavingsMove) =>
  !!move.deposit?.claimed && !move.recovered && !move.vault && !vaultKnownUnknown(move)

/** The move a rebuilt withdrawal record funds, for a front restored without its move records. */
export function savingsMoveOfWithdrawal(record: WithdrawalRecord): SavingsMove | undefined {
  const sky = record.skyMove
  if (!sky) return undefined
  return {
    direction: sky.direction,
    withdrawalLocalId: record.localId,
    escrow: record.recipient,
    factory: sky.factory,
    nonce: sky.nonce,
    recipientCommitment: sky.recipientCommitment,
    amount: record.rawAmount ?? parseUnits(record.amount, DEFAULT_DECIMALS).toString(),
    ...(sky.depositScanFrom !== undefined
      ? { depositScanFrom: sky.depositScanFrom, depositScanFloor: sky.depositScanFrom }
      : {}),
  }
}

/** The most blocks one log query asks for; providers cap a query's range. */
const DEPOSIT_SCAN_WINDOW = 10_000n
/** Windows one sync searches, so a long-idle move catches up over several syncs. */
const DEPOSIT_SCAN_WINDOWS_PER_SYNC = 20

/**
 * Finds the move's deposit and claims it. A claim that fails, usually because the deposit's message has not reached L2
 * yet, leaves the move unclaimed for the next sync and comes back as `claimError`. A claim the token refuses as already
 * stored or spent was made by an earlier pass whose record was lost, so the move is claimed; only a claim stored now
 * comes back `stored`, as the balance does not hold it yet. `startedAtMs` is when the
 * burn began; a move with no cursor searches from the L1 block of that time rather than the chain's start.
 */
export async function settleSavingsMove(
  move: SavingsMove,
  deps: SavingsMoveSettleDeps,
  startedAtMs?: number,
): Promise<{ move: SavingsMove; claimError?: unknown; stored?: boolean }> {
  if (!isSavingsMovePending(move)) return { move }
  const destination = await destinationOf(move, deps)
  let deposit = move.deposit
  if (!deposit) {
    const found = await findDeposit(move, destination, deps.publicClient, startedAtMs)
    const range = { depositScanFrom: found.scanFrom, depositScanFloor: found.scanFloor }
    if (!found.deposit) {
      return found.scanFrom === move.depositScanFrom && found.scanFloor === move.depositScanFloor
        ? { move }
        : { move: { ...move, ...range } }
    }
    deposit = found.deposit
    move = { ...move, ...range }
  }
  // A move in's vault figures ride the deposit's receipt; a failed read is retried by a later pass.
  // A move out's are in its burn's release, which the backfill reads once the tracker names it.
  const vault =
    move.vault ??
    (move.direction === "in"
      ? await readVaultFigures({ ...move, deposit }, deposit.txHash, deps).catch(() => undefined)
      : undefined)
  const settled = (claimed: boolean): SavingsMove => ({
    ...move,
    deposit: { ...deposit, claimed },
    ...(vault ? { vault, vaultLookup: VAULT_LOOKUP } : {}),
  })
  try {
    const claimer = await destination.claimer()
    await claimer.claimSweptDeposit({
      inboxIndex: BigInt(deposit.inboxIndex),
      amount: BigInt(deposit.amount),
      recipient: deps.recipient,
      sharedSecretSalt: deriveSkyEscrowSalts(deps.masterSecret, move.nonce).recipient,
    })
    return { move: settled(true), stored: true }
  } catch (claimError) {
    if (isAlreadyClaimedError(claimError)) return { move: settled(true) }
    return { move: settled(false), claimError }
  }
}

/**
 * The vault's event for the move on a transaction's receipt: `Deposit` on a move in's Sky portal
 * deposit (the escrow run), `Withdraw` on a move out's L1 release, where the executor redeems the
 * shares before the swap to DAI. Several escrows can run in one transaction, so the events naming
 * the move's escrow come first; among them the one for its shares, else the only one. Undefined
 * without the vault's address or the hash, or when no event is the move's; throws when the receipt
 * cannot be read.
 */
async function readVaultFigures(
  move: Pick<SavingsMove, "direction" | "amount" | "deposit" | "escrow">,
  txHash: Hex | undefined,
  deps: Pick<SavingsMoveSettleDeps, "publicClient" | "vault">,
): Promise<SavingsMove["vault"] | undefined> {
  if (!deps.vault || !txHash) return undefined
  const receipt = await deps.publicClient.getTransactionReceipt({ hash: txHash })
  const vault = deps.vault.toLowerCase()
  const logs = parseEventLogs({
    abi: erc4626Abi,
    eventName: move.direction === "in" ? "Deposit" : "Withdraw",
    logs: receipt.logs.filter((entry) => entry.address.toLowerCase() === vault),
  })
  const escrow = move.escrow.toLowerCase()
  const ours = logs.filter((entry) =>
    Object.values(entry.args).some(
      (arg) => typeof arg === "string" && arg.toLowerCase() === escrow,
    ),
  )
  const pool = ours.length > 0 ? ours : logs
  const shares = move.direction === "in" ? move.deposit?.amount : move.amount
  const log =
    pool.find((entry) => entry.args.shares.toString() === shares) ??
    (move.direction === "in" && pool.length === 1 ? pool[0] : undefined)
  if (!log) return undefined
  return { txHash, assets: log.args.assets.toString(), shares: log.args.shares.toString() }
}

/**
 * Gives a claimed move the vault's figures it was claimed without. A move in's escrow run is found
 * again by the deposit's hash, or by the deposit log from the move's floor; a move out's release is
 * the hash the tracker resolved on its burn, and until it is resolved the move is left for a later
 * pass. The receipt is read: unreadable comes back as `error`, for the next pass to try again; read
 * with no matching event settles the move as unknown, so no pass reads it again.
 */
export async function backfillSavingsMoveFigures(
  move: SavingsMove,
  deps: SavingsMoveSettleDeps,
  startedAtMs?: number,
  burn?: Pick<WithdrawalRecord, "l1TxHash" | "finalizeTxHash">,
): Promise<{ move: SavingsMove; error?: unknown }> {
  if (!needsVaultFigures(move) || !deps.vault || !move.deposit) return { move }
  if (move.direction === "out") {
    const release = burn?.l1TxHash ?? burn?.finalizeTxHash
    if (release) return readFigures(move, release, deps)
    const found = await findReleaseTx(move, deps, startedAtMs)
    if (found.txHash)
      return readFigures({ ...move, releaseScanFrom: found.scanFrom }, found.txHash, deps)
    if (!found.exhausted) return { move: { ...move, releaseScanFrom: found.scanFrom } }
    return unknown(
      move,
      `no release paying its escrow up to block ${found.scanFrom}`,
      undefined,
      deps,
    )
  }
  let deposit = move.deposit
  if (!deposit.txHash) {
    const destination = await destinationOf(move, deps)
    const found = await findDeposit(
      { ...move, depositScanFrom: move.runScanFrom, depositScanFloor: move.runScanFrom },
      destination,
      deps.publicClient,
      startedAtMs,
    )
    if (!found.deposit?.txHash) return { move: { ...move, runScanFrom: found.scanFrom } }
    deposit = {
      ...deposit,
      txHash: found.deposit.txHash,
      ...(found.deposit.blockNumber ? { blockNumber: found.deposit.blockNumber } : {}),
    }
  }
  const run = deposit.txHash
  if (!run) return { move }
  return readFigures({ ...move, deposit }, run, deps)
}

async function readFigures(
  move: SavingsMove,
  txHash: Hex,
  deps: SavingsMoveSettleDeps,
): Promise<{ move: SavingsMove; error?: unknown }> {
  try {
    const vault = await readVaultFigures(move, txHash, deps)
    if (vault) return { move: { ...move, vault, vaultLookup: VAULT_LOOKUP } }
    return unknown(
      move,
      `no vault ${move.direction === "in" ? "Deposit" : "Withdraw"} for its shares in ${txHash}`,
      txHash,
      deps,
    )
  } catch (error) {
    return { move, error }
  }
}

/** Settles the move's figures as unknown for this lookup, and says so once. */
function unknown(
  move: SavingsMove,
  reason: string,
  txHash: Hex | undefined,
  deps: Pick<SavingsMoveSettleDeps, "onVaultUnknown">,
): { move: SavingsMove } {
  deps.onVaultUnknown?.(move, txHash ?? ("0x" as Hex), reason)
  return { move: { ...move, vaultUnknown: reason, vaultLookup: VAULT_LOOKUP } }
}

/**
 * A move out's release: the executor pays the DAI to the move's escrow in it, so the token's
 * `Transfer` to the escrow names its transaction. Searched a window at a time from the move's
 * floor up to the deposit that followed it (or the head), with the cursor kept between passes;
 * `exhausted` once the whole range held no such transfer.
 */
async function findReleaseTx(
  move: SavingsMove,
  deps: SavingsMoveSettleDeps,
  startedAtMs?: number,
): Promise<{ txHash?: Hex; scanFrom: string; exhausted: boolean }> {
  const token = deps.main.token
  const client = deps.publicClient
  const head = await client.getBlockNumber()
  const upper = move.deposit?.blockNumber ? BigInt(move.deposit.blockNumber) : head
  const floor = await scanFloor(move, client, head, startedAtMs, deps.main.fromBlock)
  const start = move.releaseScanFrom !== undefined ? BigInt(move.releaseScanFrom) : floor
  if (!token) return { scanFrom: start.toString(), exhausted: false }
  const { log, from } = await scanFirst(start, upper, (fromBlock, toBlock) =>
    client.getContractEvents({
      address: token,
      abi: erc20Abi,
      eventName: "Transfer",
      args: { to: move.escrow },
      fromBlock,
      toBlock,
    }),
  )
  if (log?.transactionHash)
    return { txHash: log.transactionHash, scanFrom: from.toString(), exhausted: false }
  return { scanFrom: from.toString(), exhausted: from > upper }
}

/** The block a move's searches begin at: the floor it keeps, else a block before the burn's time, else the destination's first. */
const scanFloor = (
  move: Pick<SavingsMove, "depositScanFloor">,
  client: SavingsMoveSettleDeps["publicClient"],
  head: bigint,
  startedAtMs: number | undefined,
  fromBlock: bigint | undefined,
): Promise<bigint> =>
  move.depositScanFloor !== undefined
    ? Promise.resolve(BigInt(move.depositScanFloor))
    : startedAtMs !== undefined
    ? blockAround(client, head, startedAtMs, fromBlock ?? 0n)
    : Promise.resolve(fromBlock ?? 0n)

/**
 * The first log `read` returns between `start` and `upper`, a window at a time, at most
 * {@link DEPOSIT_SCAN_WINDOWS_PER_SYNC} windows: the log with the window it was found in, or no
 * log with the block the next search goes on from.
 */
async function scanFirst<L>(
  start: bigint,
  upper: bigint,
  read: (fromBlock: bigint, toBlock: bigint) => Promise<readonly L[]>,
): Promise<{ log?: L; from: bigint }> {
  let from = start
  for (let window = 0; window < DEPOSIT_SCAN_WINDOWS_PER_SYNC && from <= upper; window++) {
    const to = from + DEPOSIT_SCAN_WINDOW - 1n < upper ? from + DEPOSIT_SCAN_WINDOW - 1n : upper
    const [log] = await read(from, to)
    if (log) return { log, from }
    from = to + 1n
  }
  return { from }
}

type SavingsDeposit = NonNullable<SavingsMove["deposit"]>

/**
 * Searches the destination portal a window at a time from the move's cursor, up to the head, and returns where the
 * next search starts and the floor its range begins at. The cursor stops at the first block that is not final, so a
 * block a provider has not indexed yet, or that a reorg replaces, is searched again. A cursor kept without its floor
 * may sit past the deposit, so the search starts over at the floor: a block before the burn's time, or the
 * destination's first block when that time is unknown.
 */
async function findDeposit(
  move: SavingsMove,
  destination: SavingsMoveDestination,
  client: SavingsMoveSettleDeps["publicClient"],
  startedAtMs?: number,
): Promise<{ deposit?: SavingsDeposit; scanFrom: string; scanFloor: string }> {
  const [head, finalized] = await Promise.all([
    client.getBlockNumber(),
    client.getBlock({ blockTag: "finalized" }).then((block) => block.number),
  ])
  const floor = await scanFloor(move, client, head, startedAtMs, destination.fromBlock)
  const cursor = move.depositScanFrom !== undefined ? BigInt(move.depositScanFrom) : undefined
  const start =
    move.depositScanFloor !== undefined && cursor !== undefined && cursor >= floor ? cursor : floor
  const { log, from } = await scanFirst(start, head, (fromBlock, toBlock) =>
    client.getContractEvents({
      address: destination.portal,
      abi: OxidePortalAbi,
      eventName: "Deposit",
      args: { recipientCommitment: move.recipientCommitment },
      fromBlock,
      toBlock,
    }),
  )
  if (log) {
    const at = log.blockNumber
      ? await client
          .getBlock({ blockNumber: log.blockNumber })
          .then((block) => Number(block.timestamp) * 1000)
          .catch(() => undefined)
      : undefined
    const deposit: SavingsDeposit = {
      inboxIndex: log.args.index!.toString(),
      amount: log.args.amount!.toString(),
      claimed: false,
      ...(log.transactionHash ? { txHash: log.transactionHash } : {}),
      ...(log.blockNumber ? { blockNumber: log.blockNumber.toString() } : {}),
      ...(at !== undefined ? { at } : {}),
    }
    return { deposit, scanFrom: from.toString(), scanFloor: floor.toString() }
  }
  const next = from < finalized + 1n ? from : finalized + 1n
  return { scanFrom: (next > start ? next : start).toString(), scanFloor: floor.toString() }
}

/**
 * The last block at or before `atMs`, found by its timestamp a halving at a time; never before
 * `floor`. A floor guaranteed before the burn, whatever the block times did.
 */
async function blockAround(
  client: SavingsMoveSettleDeps["publicClient"],
  head: bigint,
  atMs: number,
  floor: bigint,
): Promise<bigint> {
  const at = BigInt(Math.floor(atMs / 1000))
  let low = floor
  let high = head
  while (low < high) {
    const mid = (low + high + 1n) / 2n
    const { timestamp } = await client.getBlock({ blockNumber: mid })
    if (timestamp <= at) low = mid
    else high = mid - 1n
  }
  return low
}
