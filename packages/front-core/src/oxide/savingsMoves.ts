/**
 * A Sky savings move after its burn. The move's escrow deposits into the destination portal under a commitment this
 * account derived from the move's nonce, and the account claims that deposit on L2 as it claims a swept SIPA deposit.
 * Fronts keep their own move records and run this step from their sync.
 */
import type { AztecAddress } from "@aztec/aztec.js/addresses"
import type { Fr } from "@aztec/aztec.js/fields"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import type { TokenService } from "@obsidion/sdk"
import { OxidePortalAbi } from "@oxide/l1-contracts"
import { parseUnits, type Address, type Hex, type PublicClient } from "viem"
import type { WithdrawalRecord } from "../core/services/bridge/types"
import { deriveSkyEscrowSalts } from "./oxideAccountKeys"

export interface SavingsMove {
  direction: "in" | "out"
  /** The burn's withdrawal record. */
  withdrawalLocalId: string
  escrow: Address
  nonce: Hex
  recipientCommitment: Hex
  /** What was burned, in the source token's base units: DAI moving in, sUSDS shares moving out. */
  amount: string
  /** The DAI the release pays the relayer, beyond the withdrawal subsidy; unknown on a move rebuilt from chain. */
  releaseTip?: string
  /** The DAI the escrow pays whoever runs it. */
  escrowTip: string
  /** The DAI a move into Savings paid for an early proof. */
  proverTip?: string
  /** The L1 block the next search for the deposit starts at: where the move began, then where the last search ended. */
  depositScanFrom?: string
  /** The destination portal's deposit once the escrow has run, and whether this account claimed it. */
  deposit?: { inboxIndex: string; amount: string; claimed: boolean }
  /** Where the escrow's funds were sent when it never ran. */
  recovered?: { to: Address; txHashes: Hex[] }
}

/** Where a move's deposit lands, and the token service that claims it there. */
export interface SavingsMoveDestination {
  portal: Address
  /** The portal's deployment block, where the search for the deposit starts. */
  fromBlock?: bigint
  claimer: () => Promise<Pick<TokenService, "claimSweptDeposit">>
}

export interface SavingsMoveSettleDeps {
  publicClient: Pick<PublicClient, "getContractEvents" | "getBlockNumber" | "getBlock">
  masterSecret: Fr
  recipient: AztecAddress
  /** A move out lands on Main's deployment, a move in on Savings'. */
  main: SavingsMoveDestination
  savings: SavingsMoveDestination
}

export const isSavingsMovePending = (move: SavingsMove) => !move.recovered && !move.deposit?.claimed

/** The move a rebuilt withdrawal record funds, for a front restored without its move records. */
export function savingsMoveOfWithdrawal(record: WithdrawalRecord): SavingsMove | undefined {
  const sky = record.skyMove
  if (!sky) return undefined
  return {
    direction: sky.direction,
    withdrawalLocalId: record.localId,
    escrow: record.recipient,
    nonce: sky.nonce,
    recipientCommitment: sky.recipientCommitment,
    amount: record.rawAmount ?? parseUnits(record.amount, DEFAULT_DECIMALS).toString(),
    ...(record.relayerTip ? { releaseTip: record.relayerTip } : {}),
    escrowTip: sky.relayerTip,
    ...(record.proverTip && BigInt(record.proverTip) > 0n ? { proverTip: record.proverTip } : {}),
  }
}

/** The most blocks one log query asks for; providers cap a query's range. */
const DEPOSIT_SCAN_WINDOW = 10_000n
/** Windows one sync searches, so a long-idle move catches up over several syncs. */
const DEPOSIT_SCAN_WINDOWS_PER_SYNC = 20

/**
 * Finds the move's deposit and claims it. A claim that fails, usually because the deposit's message has not reached L2
 * yet, leaves the move unclaimed for the next sync and comes back as `claimError`.
 */
export async function settleSavingsMove(
  move: SavingsMove,
  deps: SavingsMoveSettleDeps,
): Promise<{ move: SavingsMove; claimError?: unknown }> {
  if (!isSavingsMovePending(move)) return { move }
  const destination = move.direction === "in" ? deps.savings : deps.main
  let deposit = move.deposit
  if (!deposit) {
    const found = await findDeposit(move, destination, deps.publicClient)
    if (!found.deposit) {
      return found.scanFrom === move.depositScanFrom
        ? { move }
        : { move: { ...move, depositScanFrom: found.scanFrom } }
    }
    deposit = found.deposit
  }
  try {
    const claimer = await destination.claimer()
    await claimer.claimSweptDeposit({
      inboxIndex: BigInt(deposit.inboxIndex),
      amount: BigInt(deposit.amount),
      recipient: deps.recipient,
      sharedSecretSalt: deriveSkyEscrowSalts(deps.masterSecret, move.nonce).recipient,
    })
    return { move: { ...move, deposit: { ...deposit, claimed: true } } }
  } catch (claimError) {
    return { move: { ...move, deposit }, claimError }
  }
}

type SavingsDeposit = NonNullable<SavingsMove["deposit"]>

/**
 * Searches the destination portal a window at a time from the move's cursor, up to the head, and returns where the
 * next search starts. The cursor stops at the first block that is not final, so a block a provider has not indexed
 * yet, or that a reorg replaces, is searched again.
 */
async function findDeposit(
  move: SavingsMove,
  destination: SavingsMoveDestination,
  client: SavingsMoveSettleDeps["publicClient"],
): Promise<{ deposit?: SavingsDeposit; scanFrom: string }> {
  const [head, finalized] = await Promise.all([
    client.getBlockNumber(),
    client.getBlock({ blockTag: "finalized" }).then((block) => block.number),
  ])
  const start =
    move.depositScanFrom !== undefined ? BigInt(move.depositScanFrom) : destination.fromBlock ?? 0n
  let from = start
  for (let window = 0; window < DEPOSIT_SCAN_WINDOWS_PER_SYNC && from <= head; window++) {
    const to = from + DEPOSIT_SCAN_WINDOW - 1n < head ? from + DEPOSIT_SCAN_WINDOW - 1n : head
    const [log] = await client.getContractEvents({
      address: destination.portal,
      abi: OxidePortalAbi,
      eventName: "Deposit",
      args: { recipientCommitment: move.recipientCommitment },
      fromBlock: from,
      toBlock: to,
    })
    if (log) {
      const deposit = {
        inboxIndex: log.args.index!.toString(),
        amount: log.args.amount!.toString(),
        claimed: false,
      }
      return { deposit, scanFrom: from.toString() }
    }
    from = to + 1n
  }
  const next = from < finalized + 1n ? from : finalized + 1n
  return { scanFrom: (next > start ? next : start).toString() }
}
