/**
 * The fresh-address withdrawal: two sponsored burns to one pasted L1 address, sharing a group id.
 * The gas leg (ETH) goes first, so the address can spend without anyone funding it; the funds leg
 * (the picked asset) starts only once the gas burn is mined, or PXE could select the same
 * notes twice. Each leg is its own operation and proof through `runSponsoredBurn`, and one
 * signature covers both; the group id sits on both records and in both burns' meta, so a rescan
 * pairs the legs again. Each burn is its own withdrawal under the per-withdrawal limit. A $0 gas
 * share sends the funds leg alone, under its own signature and no group: an ordinary withdrawal.
 */
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import type { WithdrawalGroupLeg } from "@obsidion/core/types"
import { nextOperationId } from "@obsidion/sdk"
import {
  GAS_LEG_UNDERWAY,
  AppNotificationStore,
  withdrawalGroupsOf,
  type WithdrawalGroup,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import type { Address, Hex } from "viem"
import { parseUnits } from "viem"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { assertWithinWithdrawalLimit } from "../limits/withdrawalLimit"
import { runOperation, type OperationHandle } from "../operations/operations"
import type { WithdrawalReceiveAsset } from "./withdrawAssets"
import {
  burnContext,
  getWithdrawalStore,
  ownSwapRecoverer,
  planSwapLeg,
  runSponsoredBurn,
  sponsoredExit,
  type BurnContext,
  type SponsoredBurnInput,
  type SwapCommit,
  type SwapRecoverer,
  type WithdrawDeps,
  type WithdrawStage,
} from "./withdrawGateway"

export type FreshLeg = WithdrawalGroupLeg

/** What one leg's confirmed quote commits to: the escrow tip, the estimate the record keeps, and the route's floor. */
export interface FreshLegQuote extends SwapCommit {
  floorAtomic: bigint
  /** The leg's prover tip, inside `floorAtomic`. */
  proverTip?: bigint
}

export interface FreshWithdrawalInput {
  recipient: Address
  recipientAlias?: string
  /** What the recipient should receive, display units of the wallet asset: the funds and the gas share. */
  fundsDisplay: string
  gasDisplay: string
  /** What the funds leg lands; the gas leg always lands ETH. */
  fundsAsset: WithdrawalReceiveAsset
  quotes: { funds: FreshLegQuote; gas: FreshLegQuote }
}

export interface FreshWithdrawStage {
  leg: FreshLeg
  index: 1 | 2
  stage: WithdrawStage
}

export interface FreshWithdrawalResult {
  /** Absent when the funds went alone, with no gas share: the record belongs to no group. */
  groupId?: Hex
  gas?: WithdrawalRecord
  /** Absent when the funds leg was not sent: the gas leg was left to chain without a receipt. */
  funds?: WithdrawalRecord
}

export const GAS_LEG_PENDING_COPY =
  "The gas withdrawal is still confirming. Send the remaining funds from Activity once it lands."
export const FUNDS_LEG_FAILED_COPY =
  "The gas withdrawal went out, but the funds did not. Send the remaining funds from Activity."

const LEG_INDEX: Record<FreshLeg, 1 | 2> = { gas: 1, funds: 2 }

/**
 * Why the funds leg cannot be sent under this group; undefined when it can. The gas burn must be
 * on chain and not reading as dropped. Every funds leg must have failed before its burn was sent:
 * a burn that was sent may still land, so sending again could burn the funds twice.
 */
export function remainingFundsRefusal(group: WithdrawalGroup | undefined): string | undefined {
  const gas = group?.legs.gas
  if (!gas || !GAS_LEG_UNDERWAY.has(gas.phase)) {
    return "The gas withdrawal has not gone through, so the funds were not sent."
  }
  if (gas.burnDroppedAt !== undefined) {
    return "The gas withdrawal is being checked. Try again in a few minutes."
  }
  const funds = group.records.filter((r) => r.groupLeg === "funds")
  if (funds.some((r) => r.phase !== "failed")) {
    return "The funds withdrawal for this address is already on its way."
  }
  return funds.some((r) => r.droppedBurn || r.l2TxHash)
    ? "The funds withdrawal was sent and may still land, so it cannot be sent again."
    : undefined
}

const runningLegs = new Map<string, Hex>()

/** The group a running operation is a leg of. */
export const groupOfOperation = (operationId: string) => runningLegs.get(operationId)

/** A group's bell entry: the live row the bridge producer mints, or the funds that did not go out. */
export const groupEntryId = (groupId: string, entry: "inflight" | "remaining") =>
  `bridge:withdrawal-group:${groupId.toLowerCase()}:${entry}`

/** 16 random bytes as 0x-hex: what both legs' records and burn meta carry. */
export function newWithdrawalGroupId(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`
}

/** What a leg burns: the amount the recipient should receive plus the route's floor on top. */
export function freshLegBurnAmount(display: string, floorAtomic: bigint): bigint {
  return parseUnits(display, DEFAULT_DECIMALS) + floorAtomic
}

function legBurnAmount(input: FreshWithdrawalInput, leg: FreshLeg): bigint {
  const display = leg === "gas" ? input.gasDisplay : input.fundsDisplay
  return freshLegBurnAmount(display, input.quotes[leg].floorAtomic)
}

/**
 * Both legs, the gas leg first and the funds leg once the gas burn is mined. Both burns are checked
 * against the limit before either is screened or signed. A gas leg that throws never starts the
 * funds leg. A gas leg left to chain ends the flow with `funds` absent, and a funds leg that throws
 * propagates with the gas leg already recorded: both leave the bell's entry for the remaining
 * funds. A $0 gas share is the funds leg alone, see {@link submitFundsAlone}.
 */
export async function submitFreshAddressWithdrawal(
  deps: WithdrawDeps,
  input: FreshWithdrawalInput,
  onStage: (stage: FreshWithdrawStage) => void,
): Promise<FreshWithdrawalResult> {
  if (parseUnits(input.gasDisplay, DEFAULT_DECIMALS) === 0n) {
    return submitFundsAlone(deps, input, onStage)
  }
  const groupId = newWithdrawalGroupId()
  const gas = await runLeg(input, groupId, "gas", onStage, async (op, stage) => {
    for (const leg of ["gas", "funds"] as const)
      assertWithinWithdrawalLimit(legBurnAmount(input, leg))
    const ctx = await burnContext(deps, input.recipient)
    const recoverer = await ownSwapRecoverer(ctx.tuple)
    // Both burns are planned before anything persists, so a bad manifest or a locked wallet
    // aborts with no record and never strands a mined gas leg without its funds leg.
    const gasBurn = await planLeg(deps, ctx, input, groupId, "gas", recoverer)
    const fundsBurn = await planLeg(deps, ctx, input, groupId, "funds", recoverer)
    const exits = await Promise.all(
      [gasBurn, fundsBurn].map((burn) => sponsoredExit(ctx.tuple, burn)),
    )
    // Proving is reported once, ahead of the signature: a cancel lands before the passkey opens.
    stage("proving")
    const [gasShare, fundsShare] = await deps.tokenService.authorizeSponsoredExits(
      exits,
      ctx.sponsor,
      { userAccount: deps.account, useRawAmount: true },
    )
    // The signed exit is handed on: a read failing after the signature would tell no one.
    const burn = { ...gasBurn, exit: exits[0], authorization: gasShare }
    const burned = await runSponsoredBurn(op, deps, ctx, burn, (s) => s === "proving" || stage(s))
    return { ...burned, ctx, fundsBurn: { ...fundsBurn, authorization: fundsShare } }
  })
  if (!gas.mined) {
    await notifyFundsRemaining(groupId, gas.record, GAS_LEG_PENDING_COPY)
    return { groupId, gas: gas.record }
  }

  try {
    const funds = await runLeg(input, groupId, "funds", onStage, (op, stage) => {
      // The funds burn rides the FPC its intent names. The gas burn minted the rail's
      // subscription, and a batch that subscribed again would replay its nullifier.
      const { subscribe: _, ...sponsor } = gas.ctx.sponsor
      return runSponsoredBurn(op, deps, { ...gas.ctx, sponsor }, gas.fundsBurn, stage)
    })
    return { groupId, gas: gas.record, funds: funds.record }
  } catch (err) {
    await notifyFundsRemaining(groupId, gas.record, FUNDS_LEG_FAILED_COPY)
    throw err
  }
}

/**
 * The funds leg with no gas share: one burn under its own signature and no group, so the record is
 * an ordinary withdrawal. The address gets no ETH; its gas has to come from elsewhere.
 */
async function submitFundsAlone(
  deps: WithdrawDeps,
  input: FreshWithdrawalInput,
  onStage: (stage: FreshWithdrawStage) => void,
): Promise<FreshWithdrawalResult> {
  const funds = await runLeg(input, undefined, "funds", onStage, async (op, stage) => {
    assertWithinWithdrawalLimit(legBurnAmount(input, "funds"))
    const ctx = await burnContext(deps, input.recipient)
    const recoverer = await ownSwapRecoverer(ctx.tuple)
    const burn = await planLeg(deps, ctx, input, undefined, "funds", recoverer)
    return runSponsoredBurn(op, deps, ctx, burn, stage)
  })
  return { funds: funds.record }
}

/**
 * The funds leg alone, under an existing group whose gas leg went out: the "Send remaining funds"
 * path. Refuses, on a fresh read of the store, for the reason {@link remainingFundsRefusal} gives,
 * and refuses a funds burn over the limit.
 */
export async function resumeFreshAddressFunds(
  deps: WithdrawDeps,
  input: FreshWithdrawalInput & { groupId: Hex },
  onStage: (stage: FreshWithdrawStage) => void,
): Promise<FreshWithdrawalResult> {
  const { groupId } = input
  const store = getWithdrawalStore()
  await store.load()
  const group = withdrawalGroupsOf(store.list()).find(
    (g) => g.groupId.toLowerCase() === groupId.toLowerCase(),
  )
  const refusal = remainingFundsRefusal(group)
  if (refusal) throw new Error(refusal)

  const funds = await runLeg(input, groupId, "funds", onStage, async (op, stage) => {
    assertWithinWithdrawalLimit(legBurnAmount(input, "funds"))
    const ctx = await burnContext(deps, input.recipient)
    const recoverer = await ownSwapRecoverer(ctx.tuple)
    const burn = await planLeg(deps, ctx, input, groupId, "funds", recoverer)
    return runSponsoredBurn(op, deps, ctx, burn, stage)
  })
  const remaining = groupEntryId(groupId, "remaining")
  await AppNotificationStore.get(webStorage).dismiss(remaining).catch(console.warn)
  return { groupId, funds: funds.record }
}

/**
 * The bell's entry for a group whose funds leg did not go out. It opens the group's detail, which
 * sends the funds leg alone. A failed write is only logged, so the burn's own outcome stands.
 */
async function notifyFundsRemaining(groupId: Hex, gas: WithdrawalRecord, description: string) {
  const id = groupEntryId(groupId, "remaining")
  await AppNotificationStore.get(webStorage)
    .createIfAbsent({
      id,
      sourceId: id,
      producer: "bridge",
      domain: "bridge",
      title: "Funds not sent",
      description,
      timestampMs: Date.now(),
      systemIcon: "exclamationmark.triangle.fill",
      severity: "error",
      target: { type: "bridge.txDetail", bridgeKind: "withdrawal", sourceId: gas.localId },
    })
    .catch(console.warn)
}

/** One leg as its own operation, its stages reported under the leg. No group: a lone burn. */
function runLeg<T>(
  input: FreshWithdrawalInput,
  groupId: Hex | undefined,
  leg: FreshLeg,
  onStage: (stage: FreshWithdrawStage) => void,
  run: (op: OperationHandle, stage: (stage: WithdrawStage) => void) => Promise<T>,
): Promise<T> {
  const index = groupId ? LEG_INDEX[leg] : 1
  const display = leg === "gas" ? input.gasDisplay : input.fundsDisplay
  const to = `$${display} to ${input.recipientAlias?.trim() || "Ethereum"}`
  const summary = groupId ? `${to} (${index} of 2)` : to
  const stage = (s: WithdrawStage) => onStage({ leg, index, stage: s })
  const operation = { operationId: nextOperationId("withdraw"), flow: "withdraw" as const, summary }
  if (groupId) runningLegs.set(operation.operationId, groupId)
  return runOperation(operation, (op) => {
    stage("building")
    return run(op, stage)
  }).finally(() => runningLegs.delete(operation.operationId))
}

/** One leg's burn, any group on its record and in its meta: to its escrow, or direct for DAI. */
async function planLeg(
  deps: WithdrawDeps,
  ctx: BurnContext,
  input: FreshWithdrawalInput,
  groupId: Hex | undefined,
  leg: FreshLeg,
  recoverer: SwapRecoverer,
): Promise<SponsoredBurnInput> {
  const { recipient, recipientAlias } = input
  const quote = input.quotes[leg]
  const amount = legBurnAmount(input, leg)
  const asset = leg === "gas" ? "ETH" : input.fundsAsset
  const { proverTip = 0n } = quote
  const swap = await planSwapLeg(
    deps.wallet,
    asset,
    recipient,
    amount,
    quote,
    recoverer,
    ctx.tuple,
    proverTip,
  )
  const group = groupId
    ? { record: { groupId, groupLeg: leg }, options: { group: { id: groupId, leg } } }
    : {}
  return { recipient, recipientAlias, amount, swap, swapCommit: swap && quote, proverTip, ...group }
}
