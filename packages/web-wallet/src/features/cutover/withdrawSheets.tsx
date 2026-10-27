/** The withdrawal's sheets: the destination (Figma 392:2145) and the review (392:2317, 392:3064, 400:1998). */
import type { ReactNode } from "react"
import { isAddress } from "viem"
import { Icon, PrimaryGradientButton, TextField } from "@obsidion/web-ds"
import { ScreeningNotice, type useScreenedAddress } from "../../ui/screening"
import { destinationCopy, reviewCopy } from "./cutoverCopy"
import {
  Badge,
  Banner,
  CutoverSheet,
  DetailsCard,
  Lead,
  SheetTitle,
  TextButton,
  WhatHappensNext,
  type DetailRow,
} from "./parts"

type Screening = ReturnType<typeof useScreenedAddress>

function ScreeningLine({ screening }: { screening: Screening }) {
  if (screening.cleared) return null
  return (
    <ScreeningNotice
      verdict={screening.verdict}
      checkingCopy="Checking address…"
      blockedFallback="This address can't be used here. Use a different one."
      errorCopy="Couldn't verify this address. Check your internet connection and retry."
      onRetry={screening.rescreen}
    />
  )
}

/** W3: the address the funds go to, checked and ticked before Continue opens. */
export function DestinationSheet(props: {
  address: string
  onAddress: (value: string) => void
  checked: boolean
  onChecked: (value: boolean) => void
  screening: Screening
  onContinue: () => void
  onClose: () => void
}) {
  const value = props.address.trim()
  const valid = isAddress(value)
  return (
    <CutoverSheet
      label={destinationCopy.title}
      testId="cutover-destination"
      onClose={props.onClose}
    >
      <SheetTitle>{destinationCopy.title}</SheetTitle>
      <Lead>{destinationCopy.subtitle}</Lead>
      <div className="ww-cutover__field">
        <TextField
          label={destinationCopy.label}
          placeholder="0x…"
          value={props.address}
          onChange={props.onAddress}
          error={value && !valid ? destinationCopy.invalid : undefined}
        />
      </div>
      {valid && (
        <div className="ww-cutover__valid" role="status">
          <Icon name="shield-check" size={18} />
          <span>
            <b>{destinationCopy.valid}</b>
            {destinationCopy.validBody}
          </span>
        </div>
      )}
      {valid && <ScreeningLine screening={props.screening} />}
      <label className="ww-cutover__check">
        <input
          type="checkbox"
          checked={props.checked}
          data-testid="cutover-address-checked"
          onChange={(e) => props.onChecked(e.target.checked)}
        />
        <span>{destinationCopy.check}</span>
      </label>
      <PrimaryGradientButton
        title={destinationCopy.continue}
        isDisabled={!valid || !props.checked || !props.screening.cleared}
        testId="cutover-destination-continue"
        onClick={props.onContinue}
      />
    </CutoverSheet>
  )
}

export interface ReviewFigures {
  total: string
  spendable: string
  savings: string
  /** "-$0.35" from the amount, or "~$1.65" in ETH. */
  fee: string
  receive: string
}

/**
 * W4 and F1 Review: the figures, then the passkey. E2, when the wallet's gas is more than the
 * balance, makes the upgrade the primary and the withdrawal the quiet choice.
 */
export function ReviewSheet(props: {
  route: "zk-money" | "wallet"
  /** The lead under the title: the address, or where the gas comes from. */
  lead: ReactNode
  figures: ReviewFigures
  /** Notes under the figures, such as what is already sent. */
  notes?: ReactNode
  screening?: Screening
  /** The wallet's gas is more than the balance. */
  lowBalance?: boolean
  /** The connected wallet's name, for the steps. */
  wallet?: string
  /** A figure could not be read: the primary reads them again. */
  failed?: boolean
  disabled?: boolean
  onConfirm: () => void
  onRetry: () => void
  onUpgrade: () => void
  onClose: () => void
}) {
  const { figures } = props
  const rows: DetailRow[] = [
    { label: reviewCopy.spendable, value: figures.spendable },
    { label: reviewCopy.savings, value: figures.savings },
    {
      label: reviewCopy.fee,
      value: figures.fee,
      ...(props.route === "wallet" ? { note: reviewCopy.feeNote } : {}),
    },
    { label: reviewCopy.receive, value: figures.receive },
  ]
  return (
    <CutoverSheet label={reviewCopy.title} testId="cutover-review" onClose={props.onClose}>
      <Badge icon="key" />
      <SheetTitle>{reviewCopy.title}</SheetTitle>
      <Lead>{props.lowBalance ? reviewCopy.lowBody : props.lead}</Lead>
      <DetailsCard header={{ label: reviewCopy.withdrawing, value: figures.total }} rows={rows} />
      {props.notes}
      {props.screening && <ScreeningLine screening={props.screening} />}
      {props.lowBalance ? (
        <Banner
          tone="warn"
          title={reviewCopy.lowBanner.title}
          body={reviewCopy.lowBanner.body(figures.fee, figures.total)}
        />
      ) : (
        <WhatHappensNext
          title={reviewCopy.next}
          eyebrow={reviewCopy.nextEyebrow}
          steps={
            props.route === "wallet"
              ? reviewCopy.walletSteps(props.wallet ?? "your wallet")
              : reviewCopy.zkMoneySteps
          }
        />
      )}
      {props.failed ? (
        <PrimaryGradientButton title={reviewCopy.retry} onClick={props.onRetry} />
      ) : props.lowBalance ? (
        <div className="ww-cutover__actions">
          <PrimaryGradientButton
            title={reviewCopy.upgradeInstead}
            testId="cutover-upgrade-instead"
            onClick={props.onUpgrade}
          />
          <TextButton
            disabled={props.disabled}
            testId="cutover-confirm-withdraw"
            onClick={props.onConfirm}
          >
            {reviewCopy.withdrawAnyway(figures.total)}
          </TextButton>
        </div>
      ) : (
        <PrimaryGradientButton
          title={reviewCopy.button}
          isDisabled={props.disabled}
          testId="cutover-confirm-withdraw"
          onClick={props.onConfirm}
        />
      )}
    </CutoverSheet>
  )
}
