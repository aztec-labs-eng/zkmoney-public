import { useState, type ReactNode } from "react"
import {
  GradientText,
  Icon,
  PrimaryGradientButton,
  Spinner,
  TopNavIconButton,
} from "@obsidion/web-ds"
import { Modal } from "../../ui/Modal"
import { StyledQr } from "../../ui/StyledQr"
import { usePhoneLayout } from "../../ui/usePhoneLayout"
import { useTabBoundOperation } from "../operations/operations"
import { BroadcastStatusRow } from "../broadcasts/BroadcastStatusRow"
import { tokenAmountLabel } from "./AddressLimits"
import type { DepositTokenOption } from "./loadDepositFacts"
import { WaitingBlock } from "./WaitingBlock"
import ethBadge from "../../assets/deposit/eth-fill.svg"

/** Creating: no address to show yet. Waiting: copied, watching the address. Spotted: funds seen. */
export type DepositSheetPhase = "creating" | "ready" | "waiting" | "spotted"

/** Why a spotted amount is not simply credited: over the per-transaction limit, or over what capacity takes now. */
export type DepositSpottedProblem = "limit" | "capacity"

/** The coin with its Ethereum badge, on the coin rows and the sheet header. */
export function CoinIcon({ token, size = 44 }: { token: DepositTokenOption; size?: number }) {
  return (
    <span className="ww-deposit-sheet__coin" style={{ width: size, height: size }}>
      <img src={token.icon} alt="" width={size} height={size} />
      <span className="ww-deposit-sheet__coin-badge">
        <img src={ethBadge} alt="" width={10} height={10} />
      </span>
    </span>
  )
}

/** One label and value line of the limits drawer. */
export function LimitsRow({
  label,
  value,
  info,
  action,
  testId,
}: {
  label: string
  value: ReactNode
  info?: ReactNode
  action?: ReactNode
  testId?: string
}) {
  return (
    <div className="ww-deposit-sheet__row">
      <span>
        {label}
        {info}
      </span>
      <b>
        <span data-testid={testId}>{value}</span>
        {action}
      </b>
    </div>
  )
}

/** `0x7b3E` and the last four stand out, the middle is muted; a short fixture address stays plain. */
function AddressText({ address }: { address: string }) {
  if (address.length < 14) return <>{address}</>
  return (
    <>
      <b>{address.slice(0, 6)}</b>
      {address.slice(6, -6)}
      <em>{address.slice(-6, -4)}</em>
      <b>{address.slice(-4)}</b>
    </>
  )
}

/**
 * The address for one coin, from its creation to the funds being spotted. The screen owns the
 * address, the balance reads and the phase; the sheet only shows them and asks for copies and reads.
 */
export function DepositAddressSheet({
  token,
  chainName,
  phase,
  publishing = false,
  creatingNote,
  address,
  paymentUri,
  canCopy,
  copied,
  onCopy,
  balance,
  lastReadAt,
  checking,
  onCheck,
  funded,
  arriving,
  swapInto,
  limitNow,
  limits,
  capacityNote,
  arrivalMinutes,
  onPayWithWallet,
  walletLabel = "Pay with wallet",
  readError = false,
  problem,
  limitLabel,
  onOpenActivity,
  onClose,
}: {
  token: DepositTokenOption
  chainName: string
  phase: DepositSheetPhase
  /** The address's broadcast has not landed; the ledger is publishing it. */
  publishing?: boolean
  /** Why the address is not here yet, when it is not just slow. */
  creatingNote?: string
  address?: string
  /** The EIP-681 transfer URI the QR encodes; absent while nothing may be scanned. */
  paymentUri?: string
  canCopy: boolean
  copied: boolean
  onCopy: () => void
  /** The last balance read at the address. */
  balance: bigint
  lastReadAt?: number
  /** A balance read is out. */
  checking: boolean
  onCheck: () => void
  funded?: bigint
  /** What the spotted amount credits after the fee, as a `$` figure; absent for a swapped coin. */
  arriving?: string
  /** The settlement token a spotted amount is swapped into, when the coin is not it. */
  swapInto?: string
  /** The `$` figure that fits right now, on the limits row. */
  limitNow: string
  /** The limits drawer's rows. */
  limits: ReactNode
  /** Why capacity holds a deposit sent now: zero, short, or unreadable. */
  capacityNote?: string
  /** Minutes from spotted to credited; unknown until the chain's timing is read. */
  arrivalMinutes?: number
  /** The connected-wallet path: the sheet closes and the funding flow takes over. */
  onPayWithWallet?: () => void
  walletLabel?: string
  /** The last balance read failed. */
  readError?: boolean
  problem?: DepositSpottedProblem
  /** The per-transaction limit as a `$` figure, named when the spotted amount is over it. */
  limitLabel?: string
  onOpenActivity?: () => void
  onClose: () => void
}) {
  const phone = usePhoneLayout()
  // The bell's colors: gold while this page runs work that closing would lose, green when closing is safe.
  const tabBound = !!useTabBoundOperation()
  const [limitsOpen, setLimitsOpen] = useState(false)
  const { symbol, decimals } = token
  const copiedNow = copied && phase === "ready"
  const arrivalPhrase = arrivalMinutes === undefined ? "a few minutes" : `${arrivalMinutes} minutes`

  const title =
    phase === "creating"
      ? "Creating your address..."
      : phase === "ready"
      ? `Send ${symbol} to this address`
      : phase === "waiting"
      ? `Waiting for your ${symbol}`
      : `${tokenAmountLabel(funded ?? 0n, decimals, symbol)} spotted`
  const subtitle =
    phase === "creating"
      ? creatingNote ?? "Just a moment. You'll copy it into your exchange or wallet next."
      : phase === "ready"
      ? `Copy it into your exchange or wallet and send ${symbol} on Ethereum. Then wait, we'll tell you when it lands.`
      : phase === "waiting"
      ? `Send ${symbol} on Ethereum to the address below. It shows up here as soon as the network sees it.`
      : problem === "limit"
      ? `This deposit is over the ${
          limitLabel ?? "deposit"
        } limit, so it can't be credited as is. Recover it to an Ethereum address from Activity.`
      : problem === "capacity"
      ? `This deposit is over what the network can take right now. It's credited once capacity frees up, which can take longer than ${arrivalPhrase}.`
      : `Your funds are on their way to your private balance and should arrive in about ${arrivalPhrase}.`

  const showQr = !phone && !!paymentUri
  /** The address card; while waiting it also carries the live status, one card for one address. */
  const card = (live?: ReactNode) => (
    <div className={`ww-deposit-sheet__card${live ? " ww-deposit-sheet__card--live" : ""}`}>
      <span className="ww-deposit-sheet__pill">
        <span>Network</span>
        <b>{chainName}</b>
      </span>
      {phase === "creating"
        ? !phone && (
            <div className="ww-deposit-sheet__qr ww-deposit-sheet__qr--pulse" aria-hidden="true" />
          )
        : showQr && (
            <div className="ww-deposit-sheet__qr-wrap">
              <div
                className={`ww-deposit-sheet__qr${
                  phase === "waiting" ? " ww-deposit-sheet__qr--pulse" : ""
                }`}
                aria-label="Deposit address QR code"
              >
                <StyledQr value={paymentUri} icon={token.icon} />
              </div>
              {copiedNow && (
                <span className="ww-deposit-sheet__chip">
                  <span className="ww-deposit-sheet__chip-check">
                    <Icon name="check" size={10} color="#fff" strokeWidth={3} />
                  </span>
                  Copied
                </span>
              )}
            </div>
          )}
      {address ? (
        <button
          type="button"
          className="zkm-btn-reset ww-deposit-sheet__addr"
          data-testid="deposit-address"
          title={address}
          aria-label={copied ? "Address copied" : "Copy address"}
          disabled={!canCopy}
          onClick={onCopy}
        >
          <AddressText address={address} />
        </button>
      ) : (
        <span className="ww-deposit-sheet__hint">Waiting for address...</span>
      )}
      {publishing && address && <BroadcastStatusRow address={address} />}
      {live}
    </div>
  )

  return (
    <Modal
      variant="bare"
      label="Deposit address"
      className="ww-deposit-warning ww-deposit-sheet"
      onClose={onClose}
    >
      <div className="ww-deposit-warning__close">
        <TopNavIconButton icon="x" ariaLabel="Close" onClick={onClose} />
      </div>
      <div className="ww-deposit-sheet__head">
        {phase === "waiting" || phase === "creating" || publishing ? (
          <span className="ww-deposit-sheet__coin-spin" aria-busy="true">
            <span
              className={`ww-deposit-sheet__coin-ring ${tabBound ? "is-tab-bound" : "is-safe"}`}
            />
            <CoinIcon token={token} />
          </span>
        ) : phase === "spotted" ? (
          <Icon name="check" size={44} color="var(--accent-green)" strokeWidth={2.5} />
        ) : (
          <CoinIcon token={token} />
        )}
        <GradientText size={24} weight={700}>
          {title}
        </GradientText>
        <p className={phase === "creating" || phase === "ready" ? "" : "ww-deposit-sheet__sub--sm"}>
          {subtitle}
        </p>
      </div>

      {phase === "spotted" ? (
        <>
          <div
            className={`ww-deposit-sheet__status ${
              problem === "limit"
                ? "ww-deposit-sheet__status--held"
                : "ww-deposit-sheet__status--spotted"
            }`}
          >
            <span className="ww-deposit-sheet__dot" />
            <span className="ww-deposit-sheet__status-text">
              <b>
                {problem === "limit"
                  ? "Over the limit"
                  : problem === "capacity"
                  ? "Waiting for capacity"
                  : "Arriving in your balance"}
              </b>
              <span data-testid="deposit-arriving">
                {tokenAmountLabel(funded ?? 0n, decimals, symbol)} sent
                {problem === "limit"
                  ? " · recovery needed"
                  : `${arriving ? ` · ${arriving} arriving` : ""} · ${
                      problem === "capacity"
                        ? "once capacity frees up"
                        : arrivalMinutes === undefined
                        ? "a few min"
                        : `~${arrivalMinutes} min`
                    }`}
              </span>
              {swapInto && problem !== "limit" && (
                <span data-testid="deposit-swap-line">
                  Swapped to {swapInto} at the market rate, less the fee.
                </span>
              )}
            </span>
            {problem !== "limit" && <Spinner size={26} />}
          </div>
          <p className="ww-deposit-sheet__note">
            {problem === "limit"
              ? "Recovery sends the whole amount to an Ethereum address you choose. The deposit shows in Activity with a Recover button."
              : "You can close this screen. We'll notify you when the deposit arrives."}
          </p>
          <button
            type="button"
            className="zkm-btn-reset zkm-pressable ww-deposit__btn ww-deposit-sheet__ghost"
            onClick={problem === "limit" && onOpenActivity ? onOpenActivity : onClose}
          >
            {problem === "limit" && onOpenActivity ? "Open Activity" : "Close"}
          </button>
        </>
      ) : (
        <>
          {phase === "waiting"
            ? card(
                <WaitingBlock
                  line={`Balance at this address: $${tokenAmountLabel(balance, decimals, symbol)}`}
                  lastReadAt={lastReadAt}
                  readError={readError}
                  checking={checking}
                  onCheck={onCheck}
                />,
              )
            : card()}
          {capacityNote && phase !== "creating" && (
            <p className="ww-deposit-sheet__fine" role="alert" data-testid="deposit-capacity-note">
              {capacityNote}
            </p>
          )}
          {phase === "creating" ? (
            <PrimaryGradientButton
              title="Waiting..."
              isDisabled
              className="ww-deposit-sheet__cta"
              onClick={() => {}}
            />
          ) : phase === "ready" ? (
            <>
              <PrimaryGradientButton
                title={copiedNow ? "Address copied!" : "Copy address"}
                leadingIcon={copiedNow ? "check" : "file-copy"}
                isDisabled={!canCopy}
                onClick={onCopy}
                className="ww-deposit-sheet__cta"
                testId="deposit-copy"
              />
              {onPayWithWallet && (
                <button
                  type="button"
                  className="zkm-btn-reset ww-deposit-sheet__check"
                  disabled={!canCopy}
                  onClick={onPayWithWallet}
                  data-testid="deposit-pay-with-wallet"
                >
                  <Icon name="wallet" size={11} />
                  {walletLabel}
                </button>
              )}
            </>
          ) : (
            <>
              <button
                type="button"
                className="zkm-btn-reset zkm-pressable ww-deposit__btn ww-deposit-sheet__ghost ww-deposit-sheet__ghost--wide"
                onClick={onCopy}
              >
                {copied ? "Address copied!" : "Copy address again"}
              </button>
            </>
          )}
          {phase !== "waiting" && (
            <div className="ww-deposit-sheet__limits" data-testid="address-limits">
              <button
                type="button"
                className="zkm-btn-reset ww-deposit-sheet__limits-head"
                aria-expanded={limitsOpen}
                onClick={() => setLimitsOpen((o) => !o)}
              >
                <span>Limits and fees</span>
                <b>
                  Up to {limitNow} right now
                  <Icon name={limitsOpen ? "chevron-up" : "chevron-down"} size={12} />
                </b>
              </button>
              {limitsOpen && <div className="ww-deposit-sheet__limits-body">{limits}</div>}
            </div>
          )}
        </>
      )}
    </Modal>
  )
}
