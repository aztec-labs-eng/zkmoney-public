import type { ReactNode } from "react"
import type { Address } from "viem"
import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import type { RegistrationKind } from "@obsidion/core/types"
import { Icon } from "@obsidion/web-ds"
import { formatDateLabel, formatTimeLabel } from "@obsidion/front-core"
import type { PaylinkSignupQuote } from "../paylink/paylinkSignupQuote"
import { OnboardingCard } from "./OnboardingCard"
import { DepositAddressRow, DepositPayBlock } from "./steps/DepositAddress"
import {
  DepositTermsRows,
  formatDepositAmount,
  formatDepositDue,
  formatDepositSeen,
} from "./steps/DepositTermsRows"
import { PaylinkSignupRows } from "./steps/PaylinkSignupRows"

export interface RegistrationSheetProps {
  /** Bare tag, rendered as the @tag pill. */
  tag: string
  /** Sheet heading. "Activate account" wherever a reservation is waiting on its deposit. */
  title: string
  /** How long the quoted amounts stand, unix seconds. Past it the quote is re-signed on resume. */
  deadline?: number
  /** State prose the design has no slot for: expired, wrong chain, queued. */
  note?: ReactNode
  /** What to send. The address half is absent until the claim returns one. */
  payment?: {
    chainLabel: string
    /** The deposit to ask for. Unknown while the schedule it is quoted on is still being settled. */
    total?: bigint
    fpcCut?: bigint
    fee?: bigint
    sweepFee?: bigint
    /** The least deposit the chain accepts; at or above it the sheet stops asking. */
    floor?: bigint
    /** No schedule is being read: the sheet asks the total alone, with no fee or balance rows. */
    scheduleUnavailable?: boolean
    /** The schedule this registration is quoted on. */
    kind: RegistrationKind
    tokenSymbol: string
    /** What the user may send: the settlement token and anything the sweep swaps into it. */
    fundingAssets: string
    tokenDecimals: number
    /** The reserved address, once the claim has published one. */
    address?: Address
    token?: Address
    chainId?: number
    /** Already at the address, in base units; drives the shortfall line. */
    received?: bigint
    /** The machine has the deposit: report rather than ask. */
    funded?: boolean
    /** "Checked just now · Check again · Retry", under the address. */
    checkNote?: ReactNode
  }
  /** Paylink-funded signup: split the note instead of asking for an L1 deposit. The quote is
   *  absent while the cut that prices it is unread. */
  settlement?: { quote?: PaylinkSignupQuote; tokenSymbol: string; tokenDecimals: number }
  /** Inline feedback under the payment block. */
  notices?: ReactNode
  /** Caller CTAs — deposit, enter-now, log out. */
  actions?: ReactNode
  /** Withheld while the gate is not dismissible: a queued user has nothing to close back to. */
  onClose?: () => void
  /** The onboarding card's wide frame, or the wallet's standard sheet sizing. */
  variant?: "onboarding" | "wallet"
}

/**
 * The one registration sheet (Figma 10788:26927 / 10788:27111). Every surface that shows a
 * reservation opens this: the terms step before the address exists, the pending step after it
 * does, and the Home hero. A fixed sheet whose card scrolls, so the close button always sits in
 * the same corner.
 */
export function RegistrationSheet({
  tag,
  title,
  deadline,
  note,
  payment,
  settlement,
  notices,
  actions,
  onClose,
  variant = "onboarding",
}: RegistrationSheetProps) {
  return (
    <OnboardingCard
      className={
        variant === "wallet" ? "ww-reg-sheet ww-reg-sheet--wallet" : "ww-modal--create ww-reg-sheet"
      }
      onClose={onClose}
    >
      <div className="ww-reg-sheet__card">
        <div className="ww-reg-sheet__head">
          <span className="ww-invite-modal-badge ww-invite-modal-badge--brand">
            <Icon name="wallet" size={32} color="#fff" />
          </span>
          <h2 className="ww-invite-modal-title ww-invite-modal-title--lg">{title}</h2>
          <span className="ww-tag-pill">
            <strong>@{tag}</strong>
            <span>.zk.money</span>
          </span>
          {deadline !== undefined && deadline > 0 && (
            <span className="ww-reserved-until">
              Reserved until {formatDateLabel(deadline * 1000)}, {formatTimeLabel(deadline * 1000)}
            </span>
          )}
        </div>

        {note && <p className="ww-reg-sheet__note">{note}</p>}

        {settlement ? (
          <PaylinkSettlementBlock {...settlement} />
        ) : (
          payment && <RegistrationSheetPayment {...payment} />
        )}

        {notices}
        {actions}
      </div>
    </OnboardingCard>
  )
}

/** What to send and where: the summary line, the address, the amounts, and the network warning. */
function RegistrationSheetPayment({
  address,
  token,
  chainId,
  chainLabel,
  fundingAssets,
  received,
  funded,
  checkNote,
  floor,
  ...terms
}: NonNullable<RegistrationSheetProps["payment"]>) {
  const { total, sweepFee, fpcCut, tokenSymbol, tokenDecimals, kind, scheduleUnavailable } = terms
  const free = kind === "earned_tag"
  // The relayer's sweep fee and the portal's cut are the network's, on every schedule: one figure.
  const funding = sweepFee === undefined || fpcCut === undefined ? undefined : sweepFee + fpcCut
  const fmt = (v: bigint) => formatDepositAmount(v, tokenDecimals)
  const due = (v: bigint) => formatDepositDue(v, tokenDecimals)
  const got = (v: bigint) => formatDepositSeen(v, tokenDecimals)
  const seen = received !== undefined && received > 0n ? received : undefined
  const remaining =
    seen !== undefined && total !== undefined && total > seen ? total - seen : undefined

  // Covered: the machine has what it needs, so the sheet stops asking and reports. A deposit at the
  // whole ask covers any floor the ask was priced to, so it reports while the floor is still unread;
  // below the ask an unknown floor is no verdict and the sheet keeps asking.
  const covered =
    seen !== undefined &&
    ((floor !== undefined && seen >= floor) || (total !== undefined && seen >= total))
  if (funded || covered) {
    return (
      <div className="ww-deposit-panel ww-deposit-panel--funded">
        <Icon name="check-circle" size={20} color="var(--accent-green)" />
        <span>Deposit received{seen ? `: ${got(seen)}` : ""}. Confirming your name.</span>
      </div>
    )
  }

  const warning = (
    <>
      <p className="ww-reg-sheet__warn">
        <Icon name="info-circle" size={16} color="var(--text-secondary)" />
        <span>
          Fund with {fundingAssets} on {chainLabel}. Other tokens or networks can&apos;t be
          recovered.
        </span>
      </p>
      {tokenSymbol !== WALLET_TOKEN_SYMBOL && (
        <p className="ww-reg-sheet__warn">
          <Icon name="info-circle" size={16} color="var(--text-secondary)" />
          <span>Your opening balance is set when your {tokenSymbol} arrives.</span>
        </p>
      )}
    </>
  )

  return (
    <>
      <p className="ww-reg-sheet__summary" data-testid="registration-sheet-summary">
        <Icon name="coins" size={20} color="#fff" />
        <span>
          {total === undefined ? (
            <>
              {free ? "The tag is free. " : ""}
              {seen !== undefined ? `${got(seen)} received. ` : ""}
              Confirming your deposit amount.
            </>
          ) : remaining ? (
            <>
              {got(seen!)} of {due(total)} received. Send at least <strong>{due(remaining)}</strong>{" "}
              more to the address below.
            </>
          ) : scheduleUnavailable ? (
            // No schedule, so no fee to name: the ask alone, and whether the tag is paid for.
            free ? (
              <>Send at least {due(total)} to activate your account. The tag is free.</>
            ) : (
              <>Send at least {due(total)} to claim your tag and activate your account.</>
            )
          ) : free ? (
            <>
              Send at least {due(total)} to activate your account. The tag is free
              {funding !== undefined && funding > 0n
                ? `, and ${fmt(funding)} is network funding`
                : ""}
              .
            </>
          ) : (
            <>Send at least {due(total)} to claim your tag and activate your account.</>
          )}
        </span>
      </p>

      <div className="ww-reg-sheet__details">
        {address && <DepositAddressRow address={address} kind={kind} note={checkNote} />}
        <div className="ww-reg-sheet__amounts">
          <DepositTermsRows {...terms} networkLabel={chainLabel} />
        </div>
        {/* The pay block encodes a figure to send: it waits for one rather than naming a guess. */}
        {address && token && chainId !== undefined && total !== undefined ? (
          <DepositPayBlock
            address={address}
            token={token}
            chainId={chainId}
            total={remaining ?? total}
            note={warning}
          />
        ) : (
          warning
        )}
      </div>
    </>
  )
}

function PaylinkSettlementBlock({
  quote,
  tokenSymbol,
  tokenDecimals,
}: NonNullable<RegistrationSheetProps["settlement"]>) {
  return (
    <>
      <p className="ww-reg-sheet__summary">
        <Icon name="coins" size={20} color="#fff" />
        <span>
          This payment covers your account. Network fees come out of the link; the rest lands in
          your wallet.
        </span>
      </p>
      <div className="ww-reg-sheet__details">
        <div className="ww-reg-sheet__amounts">
          <PaylinkSignupRows
            quote={quote}
            tokenSymbol={tokenSymbol}
            tokenDecimals={tokenDecimals}
          />
        </div>
        <p className="ww-reg-sheet__warn">
          <Icon name="info-circle" size={16} color="var(--text-secondary)" />
          <span>
            What is left of the link opens your wallet at once, and the sweep returns a little more
            once the name registers. The network fee covers the L1 sweep, both portal cuts and
            processing; the proving fee buys faster withdrawal proving.
          </span>
        </p>
      </div>
    </>
  )
}
