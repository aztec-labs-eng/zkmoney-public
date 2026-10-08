import { useState, type ReactNode } from "react"
import type { Address } from "viem"
import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import type { Network, RegistrationKind } from "@obsidion/core/types"
import { Icon } from "@obsidion/web-ds"
import { formatDateLabel, formatTimeLabel } from "@obsidion/front-core"
import type { PaylinkSignupQuote } from "../paylink/paylinkSignupQuote"
import { OnboardingCard } from "./OnboardingCard"
import { BroadcastStatusRow } from "../broadcasts/BroadcastStatusRow"
import {
  DepositAddressRow,
  DepositPayBlock,
  registrationOverLimit,
  useRegistrationFunding,
} from "./steps/DepositAddress"
import { ADDRESS_RECHECK_NOTE, AddressCapacityPanel } from "../deposit/AddressCapacity"
import { CheckAgainPill, WaitingBlock } from "../deposit/WaitingBlock"
import { WalletAboutLimitsSheet } from "../limits/AboutLimitsSheet"
import { sourceFromTarget } from "../limits/capacitySources"
import { InfoButton } from "../limits/InfoButton"
import type { LimitsTopic } from "../limits/aboutLimitsView"
import {
  DepositTermsRows,
  formatDepositAmount,
  formatDepositDue,
  formatDepositSeen,
  fundingAssetsLabel,
} from "./steps/DepositTermsRows"
import { PaylinkSignupRows } from "./steps/PaylinkSignupRows"
import { depositTokensFor } from "../deposit/loadDepositFacts"
import ethIcon from "../../assets/deposit/ethereum.webp"

const PUBLISHING_NOTE = "Getting your fresh deposit address ready."

/** The caller's check of the registration, run from the pill under the address. */
export interface RegistrationCheck {
  /** When the registration was last checked, unix ms. */
  lastCheckedAt?: number
  busy: boolean
  onCheck: () => void
  /** Sits beside the pill: the claim's retry, when the caller offers one. */
  action?: ReactNode
}

export interface RegistrationSheetProps {
  /** Bare tag, rendered as the @tag pill. */
  tag: string
  /** Sheet heading. "Activate account" wherever a reservation is waiting on its deposit. */
  title: string
  /** When the name's hold ends, unix ms. */
  reservedUntil?: number
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
    /** Picks what the user may send: the settlement token and anything the sweep swaps into it. */
    network: Network
    /** The funding tokens the sweep swaps into the settlement token; unset where none are. */
    swapAssets?: string
    tokenDecimals: number
    /** The reserved address, once the claim has returned one. */
    address?: Address
    /** The address's broadcast has not landed: its status shows under it until the ledger lands it. */
    publishing?: boolean
    token?: Address
    chainId?: number
    /** Already at the address, in base units; drives the shortfall line. */
    received?: bigint
    /** The token already at the address: a top-up stays in it, since balances are not summed. */
    receivedToken?: Address
    /** The machine has the deposit: report rather than ask. */
    funded?: boolean
    /** The waiting block under the address: the balance there, the last check, the pill. */
    check?: RegistrationCheck
  }
  /** Paylink-funded signup: split the note instead of asking for an L1 deposit. The quote is
   *  absent while the cut that prices it is unread. */
  settlement?: {
    quote?: PaylinkSignupQuote
    tokenSymbol: string
    tokenDecimals: number
    speed?: ReactNode
  }
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
  reservedUntil,
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
          {reservedUntil !== undefined && (
            <span className="ww-reserved-until">
              Reserved until {formatDateLabel(reservedUntil)}, {formatTimeLabel(reservedUntil)}
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
  address: reserved,
  publishing,
  token,
  chainId,
  chainLabel,
  network,
  received,
  receivedToken,
  funded,
  check,
  floor,
  ...terms
}: NonNullable<RegistrationSheetProps["payment"]>) {
  const { total, sweepFee, fpcCut, tokenSymbol, tokenDecimals, kind, scheduleUnavailable } = terms
  const address = reserved
  const free = kind === "earned_tag"
  // The relayer's sweep fee and the portal's cut are the network's, on every schedule: one figure.
  const funding = sweepFee === undefined || fpcCut === undefined ? undefined : sweepFee + fpcCut
  const fmt = (v: bigint) => formatDepositAmount(v, tokenDecimals)
  const due = (v: bigint) => formatDepositDue(v, tokenDecimals)
  const got = (v: bigint) => formatDepositSeen(v, tokenDecimals)
  const seen = received !== undefined && received > 0n ? received : undefined
  const remaining =
    seen !== undefined && total !== undefined && total > seen ? total - seen : undefined
  const overLimit = registrationOverLimit({
    token,
    chainId,
    decimals: tokenDecimals,
    askAtomic: total,
    scheduleFeeAtomic: terms.fee,
    fpcCutAtomic: fpcCut,
  })

  // Covered: the machine has what it needs, so the sheet stops asking and reports. A deposit at the
  // whole ask covers any floor the ask was priced to, so it reports while the floor is still unread;
  // below the ask an unknown floor is no verdict and the sheet keeps asking.
  const covered =
    seen !== undefined &&
    ((floor !== undefined && seen >= floor) || (total !== undefined && seen >= total))
  // Once nothing more is asked, the address's capacity is not read.
  const registration = useRegistrationFunding({
    address: funded || covered ? undefined : address,
    askAtomic: total,
    decimals: tokenDecimals,
    tokenSymbol,
  })
  const [aboutLimits, setAboutLimits] = useState<LimitsTopic>()
  if (funded || covered) {
    return (
      <>
        <div className="ww-deposit-panel ww-deposit-panel--funded">
          <Icon name="check-circle" size={20} color="var(--accent-green)" />
          <span>Deposit received{seen ? `: ${got(seen)}` : ""}. Confirming your name.</span>
        </div>
        {check && (
          <div className="ww-send-to__note">
            <CheckAgainPill
              checking={check.busy}
              onClick={check.onCheck}
              testId="deposit-check-again"
            />
            {check.action}
          </div>
        )}
      </>
    )
  }

  const warning = tokenSymbol !== WALLET_TOKEN_SYMBOL && (
    <p className="ww-reg-sheet__warn">
      <Icon name="info-circle" size={16} color="var(--text-secondary)" />
      <span>Your opening balance is set when your {tokenSymbol} arrives.</span>
    </p>
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
          {/* What and where, with logos, right under the ask: readers looked for it here. */}
          <span className="ww-reg-sheet__fund" data-testid="registration-sheet-funding">
            <span className="ww-reg-sheet__fund-row">
              <span className="ww-reg-sheet__fund-logos">
                {depositTokensFor(network).map((t) => (
                  <img key={t.symbol} src={t.icon} alt="" width={20} height={20} />
                ))}
              </span>
              {fundingAssetsLabel(network)}
            </span>
            <span className="ww-reg-sheet__fund-row">
              on <img src={ethIcon} alt="" width={20} height={20} /> {chainLabel}
            </span>
            <span className="ww-reg-sheet__fund-note">
              Other tokens or networks can&apos;t be recovered.
            </span>
          </span>
        </span>
      </p>

      <div className="ww-reg-sheet__details">
        {address && (
          <>
            <DepositAddressRow
              address={address}
              kind={kind}
              note={
                check && (
                  <WaitingBlock
                    line={
                      remaining
                        ? `${got(seen!)} of ${due(total!)} received · Send at least ${due(
                            remaining,
                          )} more`
                        : `Balance at this address: ${got(seen ?? 0n)}`
                    }
                    lastReadAt={check.lastCheckedAt}
                    checking={check.busy}
                    onCheck={check.onCheck}
                    action={check.action}
                  />
                )
              }
              overLimit={overLimit}
              capacityHold={registration.hold}
              capacityWarning={registration.capacityWarning}
            />
            {/* Safe to fund now: the ledger publishes it, and funds wait at the address until then. */}
            {publishing && (
              <div data-testid="registration-address-publishing">
                <BroadcastStatusRow address={address} fallback={PUBLISHING_NOTE} />
              </div>
            )}
            <AddressCapacityPanel
              view={registration.view}
              onRetry={registration.capacity.retry}
              onAboutLimits={() => setAboutLimits("capacity")}
            />
          </>
        )}
        <div className="ww-reg-sheet__amounts">
          <DepositTermsRows
            {...terms}
            networkLabel={chainLabel}
            limitInfo={
              <InfoButton label="About the deposit limit" onClick={() => setAboutLimits("limit")} />
            }
          />
        </div>
        {/* The pay block encodes a figure to send: it waits for one rather than naming a guess. */}
        {address && token && chainId !== undefined && total !== undefined ? (
          <DepositPayBlock
            address={address}
            token={token}
            chainId={chainId}
            total={remaining ?? total}
            heldToken={remaining !== undefined ? receivedToken : undefined}
            terms={remaining === undefined ? terms : undefined}
            overLimit={overLimit}
            funding={registration.funding}
            note={warning}
          />
        ) : (
          warning
        )}
      </div>
      {aboutLimits && (
        <WalletAboutLimitsSheet
          topic={aboutLimits}
          details={{
            capacity: address && <p className="ww-about-limits__note">{ADDRESS_RECHECK_NOTE}</p>,
          }}
          // Before the claim: no account yet, and the address will come from the active deployment.
          capacity={address ? sourceFromTarget(registration.capacity) : { kind: "active" }}
          account={!!address}
          onClose={() => setAboutLimits(undefined)}
        />
      )}
    </>
  )
}

function PaylinkSettlementBlock({
  quote,
  tokenSymbol,
  tokenDecimals,
  speed,
}: NonNullable<RegistrationSheetProps["settlement"]>) {
  return (
    <>
      <p className="ww-reg-sheet__summary">
        <Icon name="coins" size={20} color="#fff" />
        <span>
          The fees come out of the payment to register your tag; the remainder stays in your wallet.
          Registration can take up to 40 minutes.
        </span>
      </p>
      <div className="ww-reg-sheet__details">
        <div className="ww-reg-sheet__amounts">
          <PaylinkSignupRows
            quote={quote}
            tokenSymbol={tokenSymbol}
            tokenDecimals={tokenDecimals}
            speed={speed}
          />
        </div>
      </div>
    </>
  )
}
