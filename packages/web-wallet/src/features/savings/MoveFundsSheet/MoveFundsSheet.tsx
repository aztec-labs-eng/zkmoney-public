import { useEffect, useRef, useState } from "react"
import { parseUnits, type Address } from "viem"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import {
  assetUsd,
  bestEffort,
  holdingUsd,
  savingsPaybackYears,
  savingsVaultSwapGain,
  UNREAD,
  useStore,
  type MoveQuote,
  type SavingsDirection,
  type SavingsMoveTiming,
  WalletError,
} from "@obsidion/front-core"
import { isPasskeyCancelled } from "@obsidion/passkey-web"
import {
  GradientText,
  Icon,
  PrimaryGradientButton,
  Spinner,
  TopNavIconButton,
} from "@obsidion/web-ds"
import { showReportableError } from "../../../errors/errorModal"
import { AmountStep } from "../../../ui/flow/AmountStep/AmountStep"
import { PickerList, type PickerItem } from "../../../ui/PickerList/PickerList"
import type { TransferAsset } from "../../../ui/TransferWidget/TransferWidget"
import { failureCode, fireEvent } from "../../../lib/analytics"
import {
  amountError,
  decimalInput,
  floorToCents,
  parseAmount,
  usdAtomic,
  usdAtomicFloor,
  usdFigure,
} from "../../../ui/format"
import { useProvingOutcome } from "../../../ui/hooks"
import { Modal } from "../../../ui/Modal"
import { Warning } from "../../../ui/Warning"
import { DepositFact } from "../../../ui/screens/DepositFact"
import {
  SponsoredActionNotice,
  useSponsoredActionBlock,
} from "../../allowance/SponsoredActionNotice"
import { SavingsTermsAccept } from "../SavingsTerms/SavingsTerms"
import { failureCodeOf, useBusyLabel, useUserFlowActive } from "../../operations/operations"
import { OperationHandOff } from "../../operations/OperationHandOff"
import { FEE_UNAVAILABLE_COPY, ProtocolFeeNote } from "../../withdraw/withdrawQuote"
import { mainTransferAsset } from "../../withdraw/withdrawAssets"
import { LimitNotice, usdFigureGrouped } from "../../limits/publicLimit"
import {
  sharesBurnLimitProblem,
  sharesBurnMax,
  withdrawalLimitProblem,
  withdrawalMaxAtomic,
} from "../../limits/withdrawalLimit"
import { apyPercent } from "../EarningsCalculator"
import { moveOperationId } from "../movesSession"
import { holdingRow, type HoldingRowView } from "../holdingRows"
import { MoveVault, vaultPickerItem, vaultTransferAsset } from "../MoveVault/MoveVault"
import { moveInLine, moveLine, moveLines, type SavingsPosition } from "../savingsLine"
import { moveNowEta, savingsEtaCopy, useSavingsMoveTiming } from "../savingsMoveTiming"
import { useTxAmountCap } from "../../token/useTxAmountCap"
import { useSession } from "../../../session/session"
import styles from "./MoveFundsSheet.module.css"
import copy from "./MoveFundsSheet.copy"
import { fmt } from "../../../lib/fmt"

const QUOTE_DEBOUNCE_MS = 400

/** A payback time in the unit that fits: days under two months, months under two years, else years. */
function paybackLabel(years: number): string {
  const unit = (count: number, word: "day" | "month" | "year") =>
    fmt(copy.payback[count === 1 ? word : (`${word}s` as const)], { count })
  if (years * 12 < 2) return unit(Math.max(1, Math.round(years * 365)), "day")
  if (years < 2) return unit(Math.round(years * 12), "month")
  return unit(Math.round(years), "year")
}

/** The sheet says how long a move in takes to earn back its fee, and warns past a year. */
const PAYBACK_WARNING_YEARS = 1

/** What the confirm step says a move takes while the live timing has not loaded. */
const FALLBACK_ESTIMATE = copy.fallbackEstimate

/** The whole journey for a move confirmed now: the estimator's submitting phase, from this moment. */
function moveEstimate(timing: SavingsMoveTiming | undefined, nowMs: number): string {
  const eta = timing && moveNowEta(timing, nowMs)
  return eta ? savingsEtaCopy(eta) : FALLBACK_ESTIMATE
}

/** A move's quote as the sheet shows it, in DAI: what leaves the source, what lands, the fee. */
interface SheetQuote {
  /** What the source burns: DAI moving in, shares moving out. */
  amount: bigint
  value: bigint
  net: bigint
  fee: bigint
  quote: MoveQuote
}

/** `assetDecimals`: the vault's asset's, which the quote's vault side is in. */
export function sheetQuote(
  direction: SavingsDirection,
  amount: bigint,
  quote: MoveQuote,
  assetDecimals: number,
): SheetQuote {
  const usd = (assets: bigint) => assetUsd(assets, { assetDecimals })
  const value = direction === "in" ? amount : usd(quote.expectedOut)
  const net = direction === "in" ? usd(quote.conversionOut) : quote.conversionOut
  return { amount, value, net, fee: value - net, quote }
}

/**
 * A swap's quote as the sheet shows it: `value`, the shares' worth, leaves; what the destination
 * takes in, in its asset of `assetDecimals`, lands.
 */
export function vaultSwapSheetQuote(
  amount: bigint,
  value: bigint,
  quote: MoveQuote,
  assetDecimals: number,
): SheetQuote {
  const net = assetUsd(quote.conversionOut, { assetDecimals })
  return { amount, value, net, fee: value - net, quote }
}

const NO_TARGETS: readonly string[] = []

/** The "Move to" picker's id for Main Account; a holding id never takes it. */
const MAIN = "main"

/** A vault by the profile's name for it, else its asset's. */
const vaultName = (vault: HoldingRowView | undefined) =>
  vault?.words?.rateName ??
  (vault?.symbol === undefined ? copy.savings : fmt(copy.vaultName, { symbol: vault.symbol }))

/** The tips a quote refused for exceeding the burn, in the burn's units. */
const tipsOf = (err: unknown): bigint | undefined =>
  err instanceof WalletError && err.code === "move.tipsExceedAmount" && err.data?.tips
    ? BigInt(err.data.tips)
    : undefined

/** The shares worth `value` dollars, at the position's dollar value; every share for all of it. */
export function sharesFor(
  position: Pick<SavingsPosition, "shares" | "value">,
  value: bigint,
): bigint {
  if (position.value === 0n || value >= position.value) return position.shares
  return (value * position.shares) / position.value
}

/**
 * Amount entry, review and the sponsored burn of a move between Main and Savings. The typed
 * figure is what leaves the source; the fee comes out of it and the rest lands. The passkey
 * ceremony is the last beat needing the user: `OperationHandOff` then closes the sheet while the
 * proof and the send carry on under the bell. Cancel is honored only while the burn is still building.
 */
export function MoveFundsSheet({
  direction: initialDirection,
  initialAmount = "",
  holdingId,
  onClose,
}: {
  direction: SavingsDirection
  initialAmount?: string
  /** The vault the move goes through, picked from its details. */
  holdingId?: string
  onClose: () => void
}) {
  const txAmountCap = useTxAmountCap()
  const session = useSession()
  const savings = useStore(session.savingsLine)
  // Lines the profile no longer lists only let their shares leave.
  const exitOnly = !moveInLine(savings) && savings.lines.length > 0
  const direction: SavingsDirection = exitOnly ? "out" : initialDirection
  const [chosen, setChosen] = useState(holdingId)
  const [amount, setAmount] = useState(initialAmount)
  const parsed = parseAmount(amount)
  const valueAtomic =
    !amountError(amount) && parsed > 0 ? parseUnits(amount, DEFAULT_DECIMALS) : undefined
  const picked = moveLine(savings, direction, chosen)
  const line = picked?.line
  // Named without waiting for every line's shares: a move in needs none of them.
  const { holdingCopy } = session.page.config
  const row = picked && holdingRow(picked, holdingCopy)
  const through = moveLines(savings, direction)
  const choices = through.map((figures) => holdingRow(figures, holdingCopy))
  const position = picked?.position ?? null
  // The vaults a move out of the line can swap into, as the engine offers them.
  const targets = useStore(session.vaultSwapTargets, (all) =>
    direction === "out" && line ? all.get(line.id) ?? NO_TARGETS : NO_TARGETS,
  )
  const destinations = savings.lines.filter((figures) => targets.includes(figures.line.id))
  const [into, setInto] = useState<string>()
  const intoFigures = destinations.find((figures) => figures.line.id === into)
  const intoRow = intoFigures && holdingRow(intoFigures, holdingCopy)
  // The vault whose terms the move accepts: the one a move in or a switch puts funds into.
  const termsRow = direction === "in" ? row : intoRow
  // A vault without words for its provider's terms takes no funds.
  const unworded = termsRow !== undefined && termsRow.words === undefined
  const assetDecimals = intoFigures
    ? intoFigures.price?.assetDecimals
    : position?.assetDecimals ?? picked?.price?.assetDecimals
  // What the shares are worth, in dollars like the typed figure.
  const worth = position ? assetUsd(position.value, position) : undefined
  const savingsCap = useStore(
    line ? session.page.chain.txAmountCap(line.held.portal as Address) : UNREAD,
    (state) => (state.status === "ready" ? state.value : undefined),
  )
  const wallet = useStore(session.balances.view)
  const [maxed, setMaxed] = useState(false)
  const [phase, setPhase] = useState<"amount" | "vault" | "confirm" | "working">("amount")
  /** Which asset chip's choices are open. The From and To labels stay labels. */
  const [menu, setMenu] = useState<"from" | "to">()
  const [priced, setPriced] = useState<{
    key: string
    quote?: SheetQuote
    error?: string
  } | null>(null)
  const [quoting, setQuoting] = useState(false)
  /** Why the review shows figures other than the ones confirmed. */
  const [requoted, setRequoted] = useState<string>()
  // Funds going into a vault need its terms accepted here, each time; a move out is the user's own
  // funds coming back. Kept by that vault: one provider's terms never stand for another's.
  const [acceptedFor, setAcceptedFor] = useState<string>()
  const accepted = termsRow !== undefined && acceptedFor === termsRow.id
  const termsNeeded = (direction === "in" || intoRow !== undefined) && !accepted
  const left = useRef(false)
  /** The move this sheet runs: its operation, and the cancel its build honors. */
  const [running, setRunning] = useState<{ operationId: string; cancel: AbortController }>()
  // The burn sequence seeds the burn's record just before the burn: past it a cancel is too late.
  const seeded = useStore(session.withdrawals.list, ({ records }) =>
    records.some((r) => r.operationId === running?.operationId),
  )
  const outcome = useProvingOutcome("savings")
  const busy = useUserFlowActive()
  const busyLabel = useBusyLabel()
  const unsponsored = useSponsoredActionBlock(phase === "confirm")
  const timing = useSavingsMoveTiming()

  const from = direction === "in" ? copy.main : copy.savings
  const intoSymbol = intoRow?.symbol
  const to =
    direction === "in" || (intoRow && intoSymbol === undefined)
      ? copy.savings
      : intoSymbol !== undefined
      ? fmt(copy.vaultName, { symbol: intoSymbol })
      : copy.main
  const available = direction === "in" ? wallet.main?.atomic ?? 0n : worth ?? 0n
  const availableKnown = direction === "in" ? wallet.readThisSession : position !== null
  const maxShares = position ? sharesBurnMax(position.shares, savingsCap) : undefined
  // MAX moving in stops at Main's withdrawal limit; moving out, at the per-burn share maximum.
  const maxValue =
    direction === "in"
      ? withdrawalMaxAtomic(available, txAmountCap) ?? 0n
      : position && worth !== undefined && maxShares !== undefined && position.shares > 0n
      ? (worth * maxShares) / position.shares
      : available
  // MAX shows the balance to the cent, rounded down; while it stands, the move takes the whole
  // balance, so a move out leaves no share behind and a move in none of the DAI past the cent.
  const maxAmount =
    availableKnown && maxValue > 0n ? floorToCents(maxValue, DEFAULT_DECIMALS) : undefined
  if (maxed && maxAmount !== undefined && maxAmount !== amount) setAmount(maxAmount)
  // What the burn removes: DAI moving in, shares moving out.
  const burnAtomic =
    maxed && maxAmount !== undefined
      ? direction === "in"
        ? maxValue
        : maxShares
      : valueAtomic === undefined
      ? undefined
      : direction === "in"
      ? valueAtomic
      : position && worth !== undefined
      ? sharesFor({ shares: position.shares, value: worth }, valueAtomic)
      : undefined
  // A move in pays its fee on top, so Savings receives what was typed; MAX has nothing on top.
  const feeOnTop = direction === "in" && !maxed
  const overspent = availableKnown && valueAtomic !== undefined && valueAtomic > available
  // A move out takes one vault's shares; past them, another vault that holds some may cover it.
  const heldElsewhere =
    direction === "out" && through.some((figures) => figures.line.id !== line?.id)
  // The limit a withdrawal of this burn meets: Main's on the DAI moving in, the per-burn maximum on
  // the shares moving out.
  const limitProblem =
    burnAtomic === undefined
      ? undefined
      : direction === "in"
      ? withdrawalLimitProblem(burnAtomic, txAmountCap)
      : sharesBurnLimitProblem(burnAtomic, savingsCap)
  // The lines are in the key: a quote of one route never prices another.
  const key =
    burnAtomic === undefined
      ? ""
      : `${line?.id}:${intoFigures?.line.id ?? direction}:${burnAtomic}:${feeOnTop ? "top" : "off"}`

  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (
      !key ||
      burnAtomic === undefined ||
      burnAtomic <= 0n ||
      overspent ||
      unworded ||
      assetDecimals === undefined
    ) {
      setPriced(null)
      setQuoting(false)
      return
    }
    const stale = new AbortController()
    setQuoting(true)
    const quoteOf = async (amount: bigint) => {
      if (!line || !session.moveQuote) throw new WalletError("invariant", "a move without Savings")
      if (intoFigures) {
        if (!session.vaultSwapQuote || !picked?.price)
          throw new WalletError("invariant", "a swap without its quote or its source's price")
        const quote = await session
          .vaultSwapQuote(line.id, intoFigures.line.id, amount)
          .read(stale.signal)
        return vaultSwapSheetQuote(amount, holdingUsd(amount, picked.price), quote, assetDecimals)
      }
      const quote = await session.moveQuote(line.id, direction, amount).read(stale.signal)
      return sheetQuote(direction, amount, quote, assetDecimals)
    }
    const priceMove = async () => {
      if (!feeOnTop) return quoteOf(burnAtomic)
      // Burn the shortfall on top until the net lands at the typed figure; fees can move between quotes.
      let gross = burnAtomic
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const result = await quoteOf(gross)
          if (result.net >= burnAtomic) return result
          gross += burnAtomic - result.net
        } catch (err) {
          const tips = tipsOf(err)
          if (tips === undefined) throw err
          gross = burnAtomic + tips
        }
      }
      throw new WalletError("savings.feeUnsettled")
    }
    // eslint-disable-next-line local/timer-in-view -- debt
    const timer = setTimeout(() => {
      priceMove()
        .then(
          (result) => {
            if (!stale.signal.aborted) setPriced({ key, quote: result })
          },
          (err: unknown) =>
            !stale.signal.aborted &&
            setPriced({
              key,
              error: (() => {
                const tips = tipsOf(err)
                const fee =
                  tips === undefined || direction === "in" || !position || worth === undefined
                    ? tips
                    : (tips * worth) / (position.shares || 1n)
                return fee === undefined
                  ? FEE_UNAVAILABLE_COPY
                  : fmt(copy.feeNotCovered, { fee: usdAtomic(fee) })
              })(),
            }),
        )
        .finally(() => !stale.signal.aborted && setQuoting(false))
    }, QUOTE_DEBOUNCE_MS)
    return () => {
      stale.abort()
      clearTimeout(timer)
    }
  }, [
    key,
    direction,
    burnAtomic,
    overspent,
    unworded,
    feeOnTop,
    session,
    line,
    picked,
    intoFigures,
    position,
    worth,
    assetDecimals,
  ])

  const current = priced?.key === key ? priced : null
  const quoted = current?.quote
  // Once priced, what Main burns is the quote's amount: the typed figure plus the fee on a move in.
  const feeOverspent =
    feeOnTop && availableKnown && quoted !== undefined && quoted.amount > available
  const grossLimitProblem =
    feeOnTop && quoted !== undefined
      ? withdrawalLimitProblem(quoted.amount, txAmountCap)
      : undefined
  // One problem shows at a time, the first that applies.
  const limitNotice =
    unworded || overspent || feeOverspent ? undefined : limitProblem ?? grossLimitProblem
  const shown = overspent
    ? copy.overspent
    : feeOverspent
    ? fmt(copy.feeOverspent, { amount: usdAtomic(quoted!.amount) })
    : limitNotice
    ? undefined
    : amountError(amount) || current?.error
  const problem: { text: string; testId?: string } | undefined = unworded
    ? { text: copy.noTerms, testId: "move-no-terms" }
    : overspent && heldElsewhere
    ? { text: copy.overVault, testId: "move-other-vault" }
    : shown
    ? { text: shown }
    : undefined
  const rate = row?.rate
  const payback =
    direction === "in" && quoted && rate !== undefined
      ? savingsPaybackYears(quoted.net, quoted.fee, rate)
      : undefined
  const slowPayback = payback !== undefined && payback > PAYBACK_WARNING_YEARS
  const intoRate = intoRow?.rate
  const gain =
    quoted && rate !== undefined && intoRate !== undefined
      ? savingsVaultSwapGain(quoted.net, quoted.fee, rate, intoRate)
      : undefined
  // A swap names both rates: what it gains, or that the vault it lands in earns less.
  const rateNote =
    !quoted || rate === undefined || intoRate === undefined
      ? undefined
      : !gain
      ? fmt(copy.switchNote.lower, { from: apyPercent(rate), to: apyPercent(intoRate) })
      : Number.isFinite(gain.paybackYears)
      ? fmt(copy.switchNote.higher, {
          from: apyPercent(rate),
          to: apyPercent(intoRate),
          amount: usdAtomicFloor(quoted.net),
          gain: usdAtomic(gain.yearly),
          fee: usdAtomic(quoted.fee),
          time: paybackLabel(gain.paybackYears),
        })
      : undefined
  const paybackLine =
    payback !== undefined && Number.isFinite(payback) && rate !== undefined && quoted?.fee
      ? fmt(slowPayback ? copy.payback.slow : copy.payback.line, {
          apy: apyPercent(rate),
          amount: usdAtomic(quoted.net),
          time: paybackLabel(payback),
          fee: usdAtomic(quoted.fee),
        })
      : undefined
  // Names a vault under Savings' side of the review; a swap heads each side with its vault.
  const vaultFact = (vault: typeof row) => {
    const vaultSwapping = intoRow !== undefined
    const named = [
      vault?.symbol,
      vaultSwapping ? undefined : vault?.words?.rateName,
      vault?.rate === undefined ? undefined : fmt(copy.rate, { apy: apyPercent(vault.rate) }),
    ]
      .filter((part) => part !== undefined)
      .join(copy.separator)
    return (
      <span className={styles.side}>
        <b>{vaultSwapping ? vaultName(vault) : copy.savings}</b>
        {named && <small>{named}</small>}
      </span>
    )
  }
  const savingsFact = vaultFact(row)
  const valid =
    line !== undefined &&
    !unworded &&
    burnAtomic !== undefined &&
    burnAtomic > 0n &&
    !overspent &&
    !feeOverspent &&
    !limitProblem &&
    !grossLimitProblem &&
    quoted !== undefined &&
    !quoting
  const typedUsd = usdFigure(String(Number.isFinite(parsed) ? parsed : 0))
  const figure = (value: bigint | undefined) =>
    quoting ? "…" : value === undefined ? "$--" : usdAtomicFloor(value)
  const exact = (value: bigint | undefined) =>
    quoting ? "…" : value === undefined ? "$--" : usdAtomic(value)

  // Both amount steps show these alike.
  const limitLine = limitNotice && (
    <LimitNotice
      operation="move"
      problem={limitNotice}
      maximum={maxAmount && usdFigureGrouped(maxAmount)}
      onUseMaximum={maxAmount ? () => setMaxed(true) : undefined}
    />
  )
  const protocolFee = (
    <ProtocolFeeNote
      fee={quoting ? undefined : quoted?.quote.withdrawalFee}
      beneficiary={quoted?.quote.feeBeneficiary}
    />
  )

  const run = async () => {
    if (!valid || quoted === undefined || !line) return
    outcome.start("building")
    setRequoted(undefined)
    setPhase("working")
    const operationId = moveOperationId()
    const cancel = new AbortController()
    setRunning({ operationId, cancel })
    try {
      const moves = await session.moveCommands?.ready()
      if (!moves) throw new WalletError("account.locked", "moves need a signed-in account")
      if (intoFigures) {
        const toId = intoFigures.line.id
        await moves.vaultSwap(
          line.id,
          toId,
          quoted.amount,
          operationId,
          quoted.quote,
          cancel.signal,
        )
      } else {
        const move = direction === "in" ? moves.add : moves.withdraw
        await move(line.id, quoted.amount, operationId, quoted.quote, cancel.signal)
      }
      outcome.finish()
      if (!left.current) onClose()
    } catch (e) {
      // A cancel taken after the burn went out stops nothing: what the burn then throws is shown.
      const cancelled = cancel.signal.aborted && failureCodeOf(e) === "aborted"
      if (cancelled || isPasskeyCancelled(e)) {
        outcome.cancel()
        setPhase("confirm")
        return
      }
      outcome.finish()
      if (e instanceof WalletError && e.code === "move.quoteChanged") {
        if (left.current) return
        const entry = intoFigures
          ? session.vaultSwapQuote?.(line.id, intoFigures.line.id, quoted.amount)
          : session.moveQuote?.(line.id, direction, quoted.amount)
        entry?.refresh()
        const now = entry && (await bestEffort("unknown", entry.read()))
        if (now && assetDecimals !== undefined) {
          const next = intoFigures
            ? vaultSwapSheetQuote(quoted.amount, quoted.value, now, assetDecimals)
            : sheetQuote(direction, quoted.amount, now, assetDecimals)
          setPriced({ key, quote: next })
          setRequoted(fmt(copy.quoteChanged, { fee: usdAtomic(next.fee) }))
        }
        setPhase("confirm")
        return
      }
      fireEvent("action_failed", { action: "savings:move", code: failureCode(e) })
      if (left.current) return
      showReportableError(e, "savings:move")
      setPhase("confirm")
    }
  }
  const leave = () => {
    left.current = true
    outcome.finish()
    onClose()
  }
  const dismiss =
    phase === "working" ? undefined : phase === "vault" ? () => setPhase("amount") : onClose
  // Out of a vault that can swap, the move picks where it lands.
  const routed = destinations.length > 0
  // The swap's amount step brings its own head.
  const widget = phase === "amount" && routed
  const title =
    phase === "vault" ? copy.title.vault : routed ? copy.title.route : copy.title[direction]
  const pickSource = (id: string) => {
    setChosen(id)
    // A destination the new source cannot swap into is dropped, not kept for later.
    if (into && !session.vaultSwapTargets.get().get(id)?.includes(into)) setInto(undefined)
    setMaxed(false)
    setMenu(undefined)
    setPhase("amount")
  }
  const pickDestination = (id: string) => {
    setInto(id === MAIN ? undefined : id)
    setMenu(undefined)
  }
  const assetChoice = (
    asset: TransferAsset,
    side: "from" | "to",
    items: readonly PickerItem[],
    selected: string | undefined,
    onPick: (id: string) => void,
  ): TransferAsset => ({
    ...asset,
    testId: `move-change-${side}`,
    onPick: () => setMenu((open) => (open === side ? undefined : side)),
    onDismiss: () => setMenu(undefined),
    menu:
      menu === side ? <PickerList selected={selected} onPick={onPick} items={items} /> : undefined,
  })
  const toItems: PickerItem[] = [
    {
      id: MAIN,
      icon: (
        <span className={styles.main} aria-hidden>
          {copy.mainInitial}
        </span>
      ),
      title: copy.main,
    },
    ...destinations.map((figures) => vaultPickerItem(holdingRow(figures, holdingCopy))),
  ]

  return (
    <Modal
      variant="bare"
      label={copy.label}
      className={phase === "confirm" ? "ww-deposit-warning ww-sheet--detail" : "ww-deposit-warning"}
      onClose={dismiss}
    >
      {phase !== "working" && (
        <>
          <div className="ww-deposit-warning__close">
            <TopNavIconButton icon="x" ariaLabel={copy.close} onClick={dismiss} />
          </div>
          {phase === "confirm" && (
            <span className="ww-deposit__connect-icon">
              <Icon name="earn" size={24} color="#fff" />
            </span>
          )}
          {!widget && (
            <GradientText size={24} weight={700}>
              {title}
            </GradientText>
          )}
        </>
      )}

      {widget && row && (
        <AmountStep
          title={title}
          send={{
            who: vaultName(row),
            testId: "move-from",
            ariaLabel: fmt(copy.amountFrom, { account: from }),
            value: amount,
            onChange: (text) => {
              setMaxed(false)
              setAmount(text)
            },
            note: `${copy.available} ${availableKnown ? usdAtomicFloor(available) : "—"}`,
            max: { onClick: () => setMaxed(true), disabled: !maxAmount },
            asset:
              choices.length > 1
                ? assetChoice(
                    vaultTransferAsset(row),
                    "from",
                    choices.map(vaultPickerItem),
                    row.id,
                    pickSource,
                  )
                : vaultTransferAsset(row),
          }}
          receive={{
            who: intoRow ? vaultName(intoRow) : copy.main,
            testId: "move-to",
            approx: true,
            value: quoted ? floorToCents(quoted.net, DEFAULT_DECIMALS) : "",
            fee:
              burnAtomic === undefined || current?.error !== undefined
                ? "none"
                : quoted
                ? { figure: usdAtomic(quoted.fee) }
                : "unknown",
            asset: assetChoice(
              intoRow ? vaultTransferAsset(intoRow) : mainTransferAsset(),
              "to",
              toItems,
              into ?? MAIN,
              pickDestination,
            ),
          }}
          errors={problem ? [problem] : []}
          notices={
            <>
              {limitLine}
              {protocolFee}
              {rateNote && <Warning tone={gain ? "info" : "warning"} title={rateNote} />}
            </>
          }
          button={{
            title: copy.review,
            disabled: !valid,
            onClick: () => {
              setMenu(undefined)
              setPhase("confirm")
            },
          }}
        />
      )}

      {phase === "amount" && !routed && (
        <>
          <div className="ww-fund__fields">
            <MoveVault row={row} choices={choices} onChange={() => setPhase("vault")} />
            <span className="ww-fund__label ww-withdraw__amount-label">
              <span>{fmt(copy.amountFrom, { account: from })}</span>
              <span>
                {copy.available} <b>{availableKnown ? usdAtomicFloor(available) : "—"}</b>
              </span>
            </span>
            <label className="ww-deposit__input ww-fund__amount">
              <span>
                <input
                  aria-label={fmt(copy.amountFrom, { account: from })}
                  inputMode="decimal"
                  autoFocus
                  data-autofocus
                  placeholder="$0.00"
                  value={amount}
                  onChange={(e) => {
                    setMaxed(false)
                    setAmount(decimalInput(e.target.value))
                  }}
                />
                <small>
                  {row?.symbol === undefined
                    ? typedUsd
                    : fmt(copy.assetUsd, { symbol: row.symbol, usd: typedUsd })}
                </small>
              </span>
              <span className="ww-withdraw__amount-side">
                <button
                  type="button"
                  className="zkm-btn-reset ww-withdraw__paste"
                  disabled={!maxAmount}
                  onClick={() => setMaxed(true)}
                >
                  {copy.max}
                </button>
              </span>
            </label>
            {limitLine}
            {problem && (
              <span className="ww-pay__error" data-testid={problem.testId}>
                {problem.text}
              </span>
            )}
            <div className="ww-sheet__facts">
              <DepositFact label={copy.l1Fee}>
                <b>{figure(quoted?.fee)}</b>
              </DepositFact>
              {protocolFee}
              <hr className="ww-divider" />
              {feeOnTop ? (
                <DepositFact label={fmt(copy.pays, { account: from })}>
                  <b>{figure(quoted?.value)}</b>
                </DepositFact>
              ) : (
                <DepositFact label={fmt(copy.receives, { account: to })}>
                  <b>≈ {figure(quoted?.net)}</b>
                </DepositFact>
              )}
            </div>
            {quoting && (
              <p
                className="ww-sheet__note"
                role="status"
                style={{ display: "flex", alignItems: "center", gap: 6 }}
              >
                <Spinner size={12} color="currentColor" /> {copy.gettingFee}
              </p>
            )}
            {rateNote && <Warning tone={gain ? "info" : "warning"} title={rateNote} />}
            {paybackLine &&
              (slowPayback ? (
                <Warning tone="warning" title={paybackLine} />
              ) : (
                <p className="ww-sheet__note">{paybackLine}</p>
              ))}
          </div>
          <PrimaryGradientButton
            title={copy.review}
            isDisabled={!valid}
            onClick={() => setPhase("confirm")}
            style={{ width: "100%", height: 48 }}
          />
        </>
      )}

      {phase === "vault" && <MoveVault row={row} choices={choices} onPick={pickSource} />}

      {phase === "confirm" && (
        <>
          <div className="ww-fund__fields">
            <div className="ww-sheet__facts">
              <DepositFact label={copy.from}>
                {direction === "in" ? <b>{from}</b> : savingsFact}
              </DepositFact>
              <DepositFact label={copy.to}>
                {direction === "in" || intoRow ? vaultFact(intoRow ?? row) : <b>{to}</b>}
              </DepositFact>
              <DepositFact label={copy.amount}>
                <b>{exact(feeOnTop ? quoted?.net : quoted?.value)}</b>
              </DepositFact>
              <DepositFact label={copy.l1Fee}>
                <b>{exact(quoted?.fee)}</b>
              </DepositFact>
              {protocolFee}
              <hr className="ww-divider" />
              {feeOnTop ? (
                <DepositFact label={fmt(copy.pays, { account: from })}>
                  <b>{exact(quoted?.value)}</b>
                </DepositFact>
              ) : (
                <DepositFact label={fmt(copy.receives, { account: to })}>
                  <b>≈ {figure(quoted?.net)}</b>
                </DepositFact>
              )}
              <DepositFact label={copy.estimatedTime}>
                <b>{moveEstimate(timing, Date.now())}</b>
              </DepositFact>
            </div>
            {(overspent || feeOverspent) && <span className="ww-pay__error">{copy.overspent}</span>}
            {current?.error && <span className="ww-pay__error">{current.error}</span>}
            {requoted && <Warning tone="warning" title={requoted} />}
            <p className="ww-sheet__note">{copy.keepOpen}</p>
            {intoRow && <p className="ww-sheet__note">{copy.earnedRestarts}</p>}
            {termsRow?.words && (
              <SavingsTermsAccept
                words={termsRow.words}
                accepted={accepted}
                onChange={(on) => setAcceptedFor(on ? termsRow.id : undefined)}
              />
            )}
          </div>
          <div className={styles.actions}>
            <SponsoredActionNotice reason={unsponsored} />
            <PrimaryGradientButton
              title={busy ? busyLabel : copy.confirm}
              isDisabled={!valid || busy || !!unsponsored || termsNeeded}
              onClick={run}
              style={{ width: "100%" }}
            />
          </div>
        </>
      )}

      {phase === "working" && (
        <OperationHandOff
          onLeave={leave}
          onCancel={running && !seeded ? () => running.cancel.abort() : undefined}
        />
      )}
    </Modal>
  )
}
