import { useState, type ReactNode } from "react"
import { backupFundingQuote, untippedFunding, type BackupFundingQuote } from "@obsidion/front-core"
import { FactBox, InfoBox, SheetShell, type SheetAction } from "@obsidion/web-ds"
import { fmt } from "../../../../lib/fmt"
import { BroadcastStatusRow } from "../../../broadcasts/BroadcastStatusRow/BroadcastStatusRow"
import {
  BALANCE_TIP_BLOCKED_COPY,
  useSpeedChoice,
  useSpeedOutcome,
  type SpeedChoice,
  type SpeedOutcome,
} from "../../../withdraw/speedChoice"
import {
  etaLabel,
  SpeedCheckingPill,
  SpeedChoicePill,
} from "../../../withdraw/WithdrawalSpeedPicker"
import speedCopy from "../../../withdraw/WithdrawalSpeedPicker.copy"
import { costCopy } from "../../backupPasskeyCopy"
import type { BackupPayFacts, BackupScreenProps } from "../../backupScreen"
import {
  AddTracker,
  approveLabel,
  approverOf,
  dollars,
  minutes,
  retryAction,
} from "../AddTracker/AddTracker"
import copy from "./ApproveScreen.copy"

/** The fees the cost is made of, as the funding's Activity sheet names them. */
const feeRows = ({ fees }: BackupFundingQuote) =>
  typeof fees === "bigint"
    ? [{ label: costCopy.fees, value: dollars(fees) }]
    : [
        { label: costCopy.withdrawalFee, value: dollars(fees.withdrawal) },
        { label: costCopy.accountChangeFee, value: dollars(fees.accountChange) },
      ]

/** How long the first quote may take before the step goes on without it. */
const QUOTE_ANSWER_WITHIN_MS = 15_000

/**
 * A4: step 2 approves the backup and then pays for it, two prompts on one step (D3). C3 is a closed
 * approval prompt, shown on the step.
 */
export function ApproveScreen({ screen, actions }: BackupScreenProps<"approve">) {
  const approver = approverOf(screen)
  const approve = approveLabel(screen)
  const { failure, busy, pay } = screen
  const hero = failure ? "warning" : "key"
  const cancel: SheetAction | undefined = screen.canCancel
    ? { label: copy.cancel, onClick: actions.cancel, disabled: busy, testId: "backup-cancel" }
    : undefined
  const stays = screen.canCancel && <InfoBox title={copy.stays.title}>{copy.stays.body}</InfoBox>
  if (screen.progress.stage === "sign")
    return (
      <SheetShell
        hero={hero}
        title={approve}
        lead={failure?.kind === "declined" ? copy.closed : copy.lead}
        primary={{
          label: approve,
          onClick: actions.approve,
          loading: busy,
          testId: "backup-approve",
        }}
        secondary={cancel}
      >
        <AddTracker screen={screen} line={{ detail: copy.pick }} />
      </SheetShell>
    )
  if (pay)
    return (
      <PaySheet screen={screen} actions={actions} pay={pay} cancel={cancel}>
        {stays}
      </PaySheet>
    )
  // The driver publishes the deposit address, then reads what the payment needs.
  return (
    <SheetShell
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
      {stays}
    </SheetShell>
  )
}

/**
 * The payment, with a Standard/Faster choice that opens on Faster: the tip is small next to the
 * wait it saves, and the funding has to settle before the key is installed. The tip rides inside
 * the funding, so Faster is refused when the one-key account cannot fund both in one transfer; a
 * fit read that fails lets the tip through unchecked. While the funding goes out the figures keep
 * the choice it was priced with, so what they show is what the burn carries.
 */
function PaySheet({
  screen,
  actions,
  pay,
  cancel,
  children,
}: BackupScreenProps<"approve"> & {
  pay: BackupPayFacts
  cancel?: SheetAction
  children: ReactNode
}) {
  const busy = screen.busy || screen.sending === true
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
  const { proverTip } = outcome
  const waiting = choice.loading || (proverTip > 0n && !pay.fit?.done)
  // The chosen speed's tip rides in the withdrawal, so the figures are priced with it.
  const quote: BackupFundingQuote =
    proverTip > 0n
      ? backupFundingQuote({ ...pay.plan, fundingAmount: (base + proverTip).toString() })
      : pay
  const amount = dollars(quote.sent - quote.credited)
  const etaSeconds = offer
    ? proverTip > 0n
      ? offer.tippedEtaSeconds
      : offer.standardEtaSeconds
    : undefined
  const time =
    etaSeconds === undefined
      ? fmt(copy.pay.timeValue, { minutes: minutes(pay.takesMs) })
      : fmt(speedCopy.eta, { eta: etaLabel(etaSeconds) })
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
      hero={screen.failure ? "warning" : "key"}
      title={fmt(copy.pay.title, { approver: approverOf(screen) })}
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
          {
            label: copy.pay.cost,
            value: amount,
            hint: {
              label: copy.pay.breakdown,
              title: copy.pay.breakdown,
              rows: feeRows(quote),
              note: fmt(copy.pay.note, {
                sent: dollars(quote.sent),
                back: dollars(quote.credited),
              }),
            },
          },
          ...(speed ? [{ label: copy.pay.speed, value: speed }] : []),
          { label: copy.pay.time, value: time },
        ]}
      />
      {children}
    </SheetShell>
  )
}
