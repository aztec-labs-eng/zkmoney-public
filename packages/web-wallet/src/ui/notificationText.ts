/** The words of a bell entry, from its `about`. */
import { formatUnits, parseUnits } from "viem"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import {
  SIPA_PROCESSING_COPY,
  WITHDRAWAL_PHASE_COPY,
  depositAmounts,
  depositPhaseCopy,
  isNativeEth,
  isZeroAddress,
  savingsMoveLabel,
  tokenAmount,
  truncateMiddle,
  shortenAddressSm,
  type BridgeActivityItem,
  type NotificationAbout,
  type NotificationEntry,
  type PaylinkRecord,
  type TokenTransaction,
  type WithdrawalPhase,
  bridgeInReturned,
} from "@obsidion/front-core"
import type { AcrossBridge } from "@obsidion/config-client"
import { itemNote } from "../features/migration/residualNotes"
import { operationText } from "../features/operations/operationEntries"
import { withdrawalSent } from "../features/withdraw/oldVersionWithdrawals"
import { fmt } from "../lib/fmt"
import { fixedCents, shortL1Addr, tokenFigure, usdAtomicFloor } from "./format"
import copy from "./notifications.copy"
import { withdrawalFailureText } from "../features/withdraw/withdrawalFailure"

export interface NotificationText {
  title: string
  description: string
}

/** "$5" or "$2.50": the wallet quotes every figure in dollars. */
function dollars(atomic: bigint, decimals: number = DEFAULT_DECIMALS): string {
  const unit = 10n ** BigInt(decimals)
  return atomic % unit === 0n ? `$${atomic / unit}` : `$${fixedCents({ atomic, decimals })}`
}

function dollarsOf(display: string): string {
  try {
    return dollars(parseUnits(display, DEFAULT_DECIMALS))
  } catch {
    return dollars(0n)
  }
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/
const HEX = /^0x[0-9a-fA-F]+$/

/** The sender as the activity row names it: a mint is the faucet, a tag stays, an address is cut. */
function receiveFrom(tx: TokenTransaction): string {
  if (isZeroAddress(tx.from) || isZeroAddress(tx.senderL2Address)) return copy.receive.faucet
  const from = tx.from
  if (from && !ADDRESS.test(from) && !HEX.test(from)) return from
  const addr = tx.senderL2Address ?? from
  return addr ? truncateMiddle(addr, 15) : copy.receive.unknown
}

const paylinkAmount = (tx: PaylinkRecord | undefined) =>
  tx?.token ? fmt(copy.paylink.amount, { amount: dollars(tx.amountAtomic, tx.token.decimals) }) : ""

const savingsOf = (item: BridgeActivityItem) =>
  item.kind === "bridge.withdrawal" ? item.record.skyMove : undefined

const bridgeOutOf = (item: BridgeActivityItem) =>
  item.kind === "bridge.withdrawal" ? item.record.bridgeOut : undefined

/**
 * The figure a bridge entry names: a withdrawal its burn, a deposit what credits the balance (a
 * recovery returns the whole balance), ETH in ETH, a move out of Savings its dollar value.
 */
function bridgeAmount(item: BridgeActivityItem): string {
  const savings = savingsOf(item)
  if (savings?.direction === "out")
    return savings.value === undefined ? copy.bridge.fromSavings : dollars(BigInt(savings.value))
  if (item.kind === "bridge.withdrawal") return dollarsOf(item.record.amount)
  // A swapped deposit's amounts are in its row token's units, not the funded token's.
  const { record } = item
  const amounts = depositAmounts(record, record.rowToken ? undefined : record.tokenDecimals)
  const figure = record.phase === "recovered" ? amounts.grossDisplay : amounts.netDisplay
  return isNativeEth(item.record.tokenAddress)
    ? fmt(copy.bridge.eth, { amount: tokenAmount(figure) })
    : dollarsOf(figure)
}

/** What a bridge-out landed: the fill's amount, else the quote's floor, in its output token. */
function bridgeOutArrived(item: BridgeActivityItem): string | undefined {
  if (item.kind !== "bridge.withdrawal") return undefined
  const { bridgeOut, swapOutput, swapOutputDecimals } = item.record
  if (!bridgeOut || swapOutput === undefined || swapOutputDecimals === undefined) return undefined
  const atomic = BigInt(bridgeOut.filledAmount ?? bridgeOut.minReceived)
  return `${tokenAmount(formatUnits(atomic, swapOutputDecimals))} ${swapOutput}`
}

/** The phases a withdrawal spends releasing its burn on Ethereum. */
const RELEASING_PHASES: ReadonlySet<WithdrawalPhase> = new Set([
  "l2_mined",
  "awaiting_proven",
  "finalizing_l1",
])

/** The shared table's releasing line names Ethereum; a bridge-out names its destination. */
function withdrawalLive(phase: WithdrawalPhase, destination: string | undefined): string {
  return destination !== undefined && RELEASING_PHASES.has(phase)
    ? fmt(copy.bridge.releasingTo, { chain: destination })
    : WITHDRAWAL_PHASE_COPY[phase].live ?? ""
}

function bridgeLive(about: Extract<NotificationAbout, { kind: "bridgeLive" }>): NotificationText {
  const { item, migration, reason } = about
  const savings = savingsOf(item)
  const withdrawal = item.kind === "bridge.withdrawal"
  const bridgeOut = bridgeOutOf(item)
  const title = migration
    ? copy.bridge.upgrading
    : savings
    ? savingsMoveLabel(savings.direction)
    : bridgeOut
    ? fmt(copy.bridge.bridgeOutLive, { chain: bridgeOut.chainName })
    : withdrawal
    ? item.record.source === "paylink"
      ? copy.bridge.paylinkWithdrawalLive
      : copy.bridge.withdrawalLive
    : copy.bridge.depositLive
  const amount = bridgeAmount(item)
  if (savings) return { title, description: amount }
  const label = reason
    ? SIPA_PROCESSING_COPY[reason].short
    : item.kind === "bridge.withdrawal"
    ? withdrawalLive(item.record.phase, bridgeOut?.chainName)
    : depositPhaseCopy(item.record).live ?? ""
  return { title, description: fmt(copy.bridge.live, { amount, label }) }
}

function bridgeEnded(about: Extract<NotificationAbout, { kind: "bridgeEnded" }>): NotificationText {
  const { item, outcome, migration } = about
  const done = outcome === "done"
  const recovered = item.record.phase === "recovered"
  const savings = savingsOf(item)
  const bridgeOut = bridgeOutOf(item)
  const what = bridgeOut
    ? copy.bridge.bridgeOut
    : item.kind === "bridge.withdrawal" && item.record.source === "paylink"
    ? copy.bridge.paylinkWithdrawal
    : copy.bridge.withdrawal
  const title =
    migration && !recovered
      ? done
        ? copy.bridge.upgradeComplete
        : copy.bridge.upgradeFailed
      : savings
      ? done
        ? savingsMoveLabel(savings.direction)
        : copy.bridge.moveFailed
      : item.kind === "bridge.withdrawal"
      ? fmt(recovered ? copy.bridge.recovered : done ? copy.bridge.complete : copy.bridge.failed, {
          what,
        })
      : recovered
      ? copy.bridge.depositRecovered
      : done
      ? copy.bridge.depositComplete
      : copy.bridge.depositFailed
  const failure = item.kind === "bridge.withdrawal" ? withdrawalFailureText(item.record) : undefined
  if (!done) return { title, description: failure ?? copy.bridge.tapForDetails }
  const amount = bridgeAmount(item)
  // A move's release is in; the move itself finishes when the destination claims the deposit.
  const description = recovered
    ? fmt(copy.bridge.returned, { amount })
    : savings
    ? amount
    : bridgeOut
    ? fmt(copy.bridge.arrivedOn, {
        amount: bridgeOutArrived(item) ?? amount,
        chain: bridgeOut.chainName,
      })
    : item.kind === "bridge.withdrawal"
    ? fmt(copy.bridge.sentToEthereum, { amount })
    : fmt(copy.bridge.arrived, { amount })
  return { title, description }
}

/** Origin amounts in the origin token's decimals. A payment to someone else names its payee. */
function bridgeInEnded(
  about: Extract<NotificationAbout, { kind: "bridgeInEnded" | "paymentBridgeEnded" }>,
  bridge?: AcrossBridge,
): NotificationText {
  const { record } = about
  const words = copy.bridgeIn
  if (record.status === "filled") {
    const amount = tokenFigure(
      formatUnits(BigInt(record.outputAmount), record.outputDecimals),
      record.outputSymbol,
    )
    return record.pays
      ? {
          title: copy.paymentBridge.filled,
          description: fmt(copy.paymentBridge.filledDescription, {
            amount,
            tag: record.pays.payee,
          }),
        }
      : { title: words.filled, description: fmt(words.filledDescription, { amount }) }
  }
  // What comes back is what Across bridged, which an origin swap or wrap makes another token: the
  // refund then names both.
  const sent = tokenFigure(
    formatUnits(BigInt(record.inputAmount), record.inputDecimals),
    record.symbol,
  )
  const back = bridgeInReturned(record)
  const returned = tokenFigure(formatUnits(back.amount, back.decimals), back.symbol)
  const network =
    bridge?.chains.find((c) => c.chainId === record.originChainId)?.name ?? words.otherChain
  const figures = { amount: sent, returned, network }
  switch (record.status) {
    case "refunded":
      return {
        title: words.refunded,
        description: fmt(
          back.other ? words.refundedAsDescription : words.refundedDescription,
          figures,
        ),
      }
    case "failed":
      return { title: words.failed, description: fmt(words.failedDescription, figures) }
    default:
      return {
        title: words.expired,
        description: fmt(
          back.other ? words.expiredAsDescription : words.expiredDescription,
          figures,
        ),
      }
  }
}

function registrationLive(
  about: Extract<NotificationAbout, { kind: "registrationLive" }>,
): NotificationText {
  const r = copy.registration
  const securing = fmt(r.securing, { tag: about.tag })
  if (about.reason)
    return { title: r.received, description: SIPA_PROCESSING_COPY[about.reason].short }
  switch (about.stage) {
    case "funding":
      return { title: r.claimingTag, description: securing }
    case "received":
      return { title: r.received, description: securing }
    case "sweeping":
      return { title: r.sweeping, description: r.sweepingDescription }
    case "claiming":
      return { title: fmt(r.claiming, { tag: about.tag }), description: r.claimingDescription }
    case "crediting":
      return { title: r.crediting, description: r.creditingDescription }
  }
}

function eventText(about: Extract<NotificationAbout, { kind: "event" }>): NotificationText {
  const { event } = about
  switch (event.kind) {
    case "reorg": {
      const { outcome, incoming, withdrawal } = event.data
      const r = copy.reorg
      if (outcome === "failed")
        return { title: r.failed, description: incoming ? r.failedIncoming : r.failedOutgoing }
      return withdrawal
        ? { title: r.withdrawalResumed, description: r.withdrawalResumedDescription }
        : { title: r.paymentConfirmed, description: r.paymentConfirmedDescription }
    }
    case "contactAdded": {
      const { tag, address } = event.data
      const who = tag ? fmt(copy.contactAdded.tag, { tag }) : shortenAddressSm(address)
      return {
        title: copy.contactAdded.title,
        description: fmt(copy.contactAdded.description, { who }),
      }
    }
    case "claimReversed":
      return {
        title: copy.paylink.claimReverted,
        description: copy.paylink.claimRevertedDescription,
      }
    case "reclaimable":
      return {
        title: copy.paylink.reclaimable,
        description: fmt(copy.paylink.reclaimableDescription, {
          amount: paylinkAmount(about.link),
        }),
      }
    case "migrationResiduals":
      return {
        title: copy.migration.residuals,
        description: event.data.items.map(itemNote).join(" · "),
      }
    case "migrationRun":
      return { title: copy.migration.run, description: copy.migration[event.data.stop] }
  }
}

/** `bridge` names a bridge-in's origin chain. */
export function notificationText(
  entry: Pick<NotificationEntry, "about">,
  bridge?: AcrossBridge,
): NotificationText {
  const { about } = entry
  switch (about.kind) {
    case "bridgeLive":
      return bridgeLive(about)
    case "bridgeEnded":
      return bridgeEnded(about)
    case "upgradeRun": {
      const { run, done, value } = about
      const n = run.legs.length
      // A run with no value names no figure.
      if (!done)
        return {
          title: copy.bridge.upgrading,
          description:
            value === undefined
              ? fmt(copy.upgrade.arrivedUnpriced, { arrived: run.arrived, total: n })
              : fmt(copy.upgrade.arrived, {
                  figure: dollars(value),
                  arrived: run.arrived,
                  total: n,
                }),
        }
      if (value === undefined)
        return {
          title: copy.bridge.upgradeComplete,
          description:
            n === 1
              ? copy.upgrade.oneTransferUnpriced
              : fmt(copy.upgrade.transfersUnpriced, { count: n }),
        }
      const figure = dollars(value)
      return {
        title: copy.bridge.upgradeComplete,
        description:
          n === 1
            ? fmt(copy.upgrade.oneTransfer, { figure })
            : fmt(copy.upgrade.transfers, { figure, count: n }),
      }
    }
    case "registrationLive":
      return registrationLive(about)
    case "bridgeInEnded":
    case "paymentBridgeEnded":
      return bridgeInEnded(about, bridge)
    case "registrationEnded":
      return about.registered
        ? {
            title: fmt(copy.registration.registered, { tag: about.tag }),
            description: copy.registration.registeredDescription,
          }
        : {
            title: copy.registration.failed,
            description: fmt(copy.registration.failedDescription, { tag: about.tag }),
          }
    case "receive":
      return {
        title: copy.receive.title,
        description: fmt(copy.receive.description, {
          amount: dollars(about.tx.amountAtomic, about.tx.token.decimals),
          from: receiveFrom(about.tx),
        }),
      }
    case "paylinkClaimed": {
      const { link } = about
      const to = link.flavor !== "direct" && link.to ? fmt(copy.paylink.to, { to: link.to }) : ""
      return {
        title: copy.paylink.claimed,
        description: fmt(copy.paylink.claimedDescription, { amount: paylinkAmount(link), to }),
      }
    }
    case "operation":
      return operationText(about.record)
    case "oldVersionWithdrawal": {
      const { record } = about
      const words = copy.oldVersionWithdrawal
      return {
        title: words[record.phase],
        description:
          record.phase === "failed"
            ? words.failedDescription
            : fmt(words.description, {
                amount: usdAtomicFloor(withdrawalSent(record)),
                to: shortL1Addr(record.to),
              }),
      }
    }
    case "event":
      return eventText(about)
  }
}
