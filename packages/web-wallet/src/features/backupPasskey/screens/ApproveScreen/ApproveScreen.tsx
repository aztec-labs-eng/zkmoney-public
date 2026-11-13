import { useRef, useState, type Ref } from "react"
import {
  backupFundingQuote,
  untippedFunding,
  useStore,
  type BackupFundingQuote,
} from "@obsidion/front-core"
import { FactBox, KeyStatusRow, SheetCard, SheetShell, type SheetAction } from "@obsidion/web-ds"
import { fmt } from "../../../../lib/fmt"
import { useSession } from "../../../../session/session"
import { HIDDEN_BALANCE, usdAtomicFloor, usdFromCents } from "../../../../ui/format"
import { useDomLayoutEffect } from "../../../../ui/useDomEffect"
import { BroadcastStatusRow } from "../../../broadcasts/BroadcastStatusRow/BroadcastStatusRow"
import {
  BALANCE_TIP_BLOCKED_COPY,
  useSpeedChoice,
  useSpeedOutcome,
  type SpeedChoice,
  type SpeedOutcome,
} from "../../../withdraw/speedChoice"
import { SpeedCheckingPill, SpeedChoicePill } from "../../../withdraw/WithdrawalSpeedPicker"
import { addCost, feeSplit } from "../../backupCost"
import { costCopy, holdCopy } from "../../backupPasskeyCopy"
import type { BackupPayFacts, BackupScreenProps } from "../../backupScreen"
import { mainBalance } from "../../useBackupNudge"
import { AddTracker, approverOf, minutes, retryAction } from "../AddTracker/AddTracker"
import copy from "./ApproveScreen.copy"

/** The charges the fee, in cents, is made of, as the funding's Activity sheet names them. */
function feeRows({ fees }: BackupFundingQuote, fee: bigint) {
  if (typeof fees === "bigint") return [{ label: costCopy.fees, value: usdFromCents(fee) }]
  // The tip rides in the withdrawal.
  const [withdrawal, accountChange] = feeSplit(fee, fees.accountChange)
  return [
    { label: costCopy.withdrawalFee, value: usdFromCents(withdrawal) },
    { label: costCopy.accountChangeFee, value: usdFromCents(accountChange) },
  ]
}

/** How long the first quote may take before the step goes on without it. */
const QUOTE_ANSWER_WITHIN_MS = 15_000

/**
 * A4: step 2 approves the backup and then pays for it, two prompts on one step (D3). C3 is a closed
 * approval prompt, shown on the step.
 */
export function ApproveScreen({ screen, actions }: BackupScreenProps<"approve">) {
  const approver = approverOf(screen)
  const { failure, busy, pay } = screen
  const shown = screen.progress.stage === "sign" ? "sign" : pay ? "pay" : "ready"
  const sheet = useRef<HTMLDivElement>(null)
  // The card keeps its scroll when one of these sheets replaces another; each opens at its top.
  useDomLayoutEffect(() => {
    const card = sheet.current?.closest<HTMLElement>(".ww-modal")
    if (card) card.scrollTop = 0
  }, [shown])
  const hero = failure ? "warning" : "key"
  const cancel: SheetAction | undefined = screen.canCancel
    ? { label: copy.cancel, onClick: actions.askCancel, disabled: busy, testId: "backup-cancel" }
    : undefined
  if (shown === "sign")
    return (
      <SheetShell
        ref={sheet}
        hero={hero}
        title={copy.title}
        lead={failure?.kind === "declined" ? copy.closed : copy.lead}
        primary={{
          label: copy.confirm,
          onClick: actions.approve,
          loading: busy,
          testId: "backup-approve",
        }}
        secondary={cancel}
        note={copy.pick}
      >
        <SheetCard>
          <KeyStatusRow
            name={copy.passkey}
            detail={screen.approver ?? copy.unnamed}
            status="added"
          />
        </SheetCard>
        <AddTracker screen={screen} />
      </SheetShell>
    )
  if (pay)
    return <PaySheet ref={sheet} screen={screen} actions={actions} pay={pay} cancel={cancel} />
  // The driver publishes the deposit address, then reads what the payment needs.
  return (
    <SheetShell
      ref={sheet}
      hero={hero}
      title={copy.ready.title}
      lead={fmt(copy.ready.lead, { approver })}
      primary={
        failure
          ? retryAction(screen, actions)
          : { label: copy.ready.pay, onClick: actions.fund, disabled: true, loading: true }
      }
      secondary={cancel}
    >
      <AddTracker screen={screen} line={{ detail: copy.ready.detail }} />
      {screen.sipa && <BroadcastStatusRow address={screen.sipa.toLowerCase()} />}
    </SheetShell>
  )
}

/**
 * The payment from Main Account, as its fee, the hold that comes back and their total. Its
 * Standard/Faster choice opens on Faster: the tip is small next to the wait it saves, and the
 * funding has to settle before the key is installed. The tip rides inside the funding, so Faster is
 * refused when the one-key account cannot fund both in one transfer; a fit read that fails lets the
 * tip through unchecked. While the funding goes out the figures keep the choice it was priced
 * with, so what they show is what the burn carries.
 */
function PaySheet({
  screen,
  actions,
  pay,
  cancel,
  ref,
}: BackupScreenProps<"approve"> & {
  pay: BackupPayFacts
  cancel?: SheetAction
  ref: Ref<HTMLDivElement>
}) {
  const busy = screen.busy || screen.sending === true
  const session = useSession()
  const balance = useStore(session.balances.view, mainBalance)
  const hidden = useStore(session.device, (s) => s.hideBalances)
  const base = untippedFunding(pay.plan)
  const live = useSpeedChoice({
    active: !busy,
    amount: base,
    initialSpeed: "faster",
    answerWithinMs: QUOTE_ANSWER_WITHIN_MS,
  })
  const covers = live.offer && pay.fit?.fits ? pay.fit.fits(base + live.offer.proverTip) : undefined
  const liveOutcome = useSpeedOutcome(live, covers, BALANCE_TIP_BLOCKED_COPY)
  // The choice the send was priced with, shown until the funding is out or the send failed.
  const [sent, setSent] = useState<{ choice: SpeedChoice; outcome: SpeedOutcome }>()
  const { choice, outcome } = busy && sent ? sent : { choice: live, outcome: liveOutcome }
  const { offer } = choice
  // A sheet opened while a send is out has no choice of its own: the plan holds that send's tip.
  const proverTip = screen.sending && !sent ? BigInt(pay.plan.proverTip ?? 0) : outcome.proverTip
  const waiting = choice.loading || (proverTip > 0n && !pay.fit?.done)
  // The tip rides in the withdrawal. A plan saved by a send that never went out carries that send's
  // tip, so the price starts from the untipped funding.
  const quote = backupFundingQuote({ ...pay.plan, fundingAmount: (base + proverTip).toString() })
  const cost = addCost(quote)
  const amount = usdFromCents(cost.total)
  const account =
    balance === undefined
      ? copy.pay.account
      : fmt(copy.pay.accountBalance, { balance: hidden ? HIDDEN_BALANCE : usdAtomicFloor(balance) })
  // The whole wait, from paying to the backup installed, at the speed the tip buys.
  const etaSeconds = pay.eta && (proverTip > 0n ? pay.eta.tipped : pay.eta.standard)
  const time =
    etaSeconds === undefined
      ? undefined
      : fmt(copy.pay.timeValue, { minutes: minutes(etaSeconds * 1000) })
  const speed = offer ? (
    <SpeedChoicePill
      value={choice.speed}
      onChange={choice.setSpeed}
      faster={offer}
      settled={choice.settled}
      fasterBlocked={outcome.blocked}
      disabled={busy}
      label={copy.pay.speed}
    />
  ) : choice.loading ? (
    <SpeedCheckingPill />
  ) : undefined
  return (
    <SheetShell
      ref={ref}
      hero={screen.failure ? "warning" : "key"}
      title={copy.pay.title}
      lead={copy.pay.lead}
      primary={{
        label: fmt(copy.pay.pay, { amount }),
        onClick: () => {
          setSent({ choice, outcome })
          actions.fund(proverTip)
        },
        loading: busy,
        disabled: waiting,
        testId: "backup-fund-continue",
      }}
      secondary={cancel}
    >
      <AddTracker screen={screen} line={{ detail: fmt(copy.pay.detail, { amount }) }} />
      <FactBox
        facts={[
          { label: copy.pay.from, value: account },
          {
            label: copy.pay.fee,
            value: usdFromCents(cost.fee),
            hint: {
              label: copy.pay.breakdown,
              title: copy.pay.breakdown,
              rows: feeRows(quote, cost.fee),
            },
          },
          {
            label: holdCopy.label,
            value: fmt(holdCopy.value, { amount: usdFromCents(cost.hold) }),
          },
          { label: copy.pay.total, value: amount },
          ...(speed ? [{ label: copy.pay.speed, value: speed }] : []),
          ...(time ? [{ label: copy.pay.time, value: time }] : []),
        ]}
      />
    </SheetShell>
  )
}
