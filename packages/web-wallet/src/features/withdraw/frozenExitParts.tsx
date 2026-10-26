/**
 * The frozen exit's wallet route, its steps and their pieces. Free of this deployment's runtime, so
 * a Withdraw on another deployment can host them.
 */
import type { ReactNode } from "react"
import { formatUnits, isAddress, type Address, type Hex } from "viem"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import {
  ConfirmationSheetDetailRow,
  DoubleCheckIcon,
  GradientText,
  Icon,
  PrimaryGradientButton,
  Spinner,
  TextField,
} from "@obsidion/web-ds"
import { HashRow, l1TxUrl } from "../../ui/detailRows"
import { shortL1Addr, usdAtomicFloor } from "../../ui/format"
import { ScreeningNotice, type useScreenedAddress } from "../../ui/screening"
import type { L1ExitStage } from "../deposit/sipaRecovery"

/** Dollar figures: a Savings share at its price. */
export type FrozenExitSent = { refunded: bigint; hashes: Hex[] }
export type FrozenExitDone = FrozenExitSent & { left: bigint; to: Address }

export interface FrozenSourceFunds {
  /** Refundable now, in the portal's token units. */
  refundable: bigint
  /** The part of `refundable` held in payment links. */
  links: bigint
  /** Not refundable yet. */
  waiting: bigint
}

export interface FrozenFunds {
  main: FrozenSourceFunds
  /** Absent where Savings is not frozen. */
  savings?: FrozenSourceFunds
  /** The Savings scan failed; Main's still stands. */
  savingsFailed?: boolean
  /** What this browser's open payment links hold, which Main's `links` should match. */
  openLinks: bigint
}

const STEPS = 3
export const step = (n: number) => `OWN WALLET · STEP ${n} OF ${STEPS}`

/**
 * "How to send". With no `zkMoney`, its row is closed, as while the portal is frozen; a host where
 * the route runs passes it.
 */
export function HowToSend({
  zkMoney,
  selected = "wallet",
  onSelectWallet,
}: {
  zkMoney?: { onSelect: () => void; fee?: string; note?: string; disabled?: boolean }
  selected?: "zk-money" | "wallet"
  onSelectWallet?: () => void
}) {
  const closed = !zkMoney || zkMoney.disabled
  return (
    <div className="ww-frozen-exit__routes" role="radiogroup" aria-label="How to send">
      <span className="ww-frozen-exit__label">How to send</span>
      <button
        type="button"
        className="zkm-btn-reset ww-frozen-exit__route"
        role="radio"
        aria-checked={selected === "zk-money"}
        aria-disabled={closed || undefined}
        data-selected={selected === "zk-money" || undefined}
        disabled={closed}
        onClick={zkMoney?.onSelect}
      >
        <b>
          Pay from zk.money <span className="ww-frozen-exit__tag">Private</span>
          {zkMoney?.fee && <span className="ww-frozen-exit__fee">{zkMoney.fee}</span>}
        </b>
        <span>{zkMoney?.note ?? "Available after the upgrade"}</span>
      </button>
      <button
        type="button"
        className="zkm-btn-reset ww-frozen-exit__route"
        role="radio"
        aria-checked={selected === "wallet"}
        data-selected={selected === "wallet" || undefined}
        onClick={onSelectWallet}
      >
        <b>
          Pay from your wallet <span className="ww-frozen-exit__tag">Public</span>
        </b>
        <span>Your wallet pays the gas and receives the funds.</span>
      </button>
    </div>
  )
}

/** The wallet route's recipient and figures. */
export function FrozenWalletRoute(props: {
  bridgeMode: boolean
  wallet: ReactNode
  destination: string
  onDestination: (value: string) => void
  to: Address | null
  screening: ReturnType<typeof useScreenedAddress>
  /** Shown in place of the figures while they are not read. */
  status?: string
  funds?: FrozenFunds
  shareUsd: (shares: bigint) => bigint
  /** The Savings token, which Savings refunds pay out. */
  savingsSymbol: string
}) {
  const { bridgeMode, destination, to, screening, funds, shareUsd, savingsSymbol } = props
  const savings = funds?.savings
  const total = funds && funds.main.refundable + (savings ? shareUsd(savings.refundable) : 0n)
  const waiting = funds && funds.main.waiting + (savings ? shareUsd(savings.waiting) : 0n)
  // Open links this browser recorded that the refund found no escrow notes for.
  const missing =
    funds && funds.openLinks > funds.main.links ? funds.openLinks - funds.main.links : 0n
  return (
    <>
      <div className="ww-frozen-exit__to">
        <span className="ww-frozen-exit__label">Withdraw to</span>
        {bridgeMode ? (
          <TextField
            label="Your Ethereum address"
            placeholder="0x…"
            value={destination}
            onChange={props.onDestination}
            error={
              destination && !isAddress(destination)
                ? "That isn't a valid Ethereum address"
                : undefined
            }
          />
        ) : (
          props.wallet
        )}
        <span className="ww-frozen-exit__hint">
          {bridgeMode
            ? "Approve with this account in your browser. Funds return to the wallet that pays."
            : "Funds return to the wallet that pays."}
        </span>
      </div>
      {to && !screening.cleared && (
        <ScreeningNotice
          verdict={screening.verdict}
          checkingCopy="Checking address…"
          blockedFallback="This address can't be used here. Use a different one."
          errorCopy="Couldn't verify this address. Check your internet connection and retry."
          onRetry={screening.rescreen}
        />
      )}
      <div className="ww-frozen-exit__box">
        <ConfirmationSheetDetailRow
          label="Amount to send"
          value={props.status ?? usdAtomicFloor(total ?? 0n)}
        />
        {!!funds?.main.links && (
          <ConfirmationSheetDetailRow
            label="From payment links"
            value={usdAtomicFloor(funds.main.links)}
          />
        )}
        {!!savings?.refundable && (
          <ConfirmationSheetDetailRow
            label="From Savings"
            value={`${shares(savings.refundable)} ${savingsSymbol}`}
          />
        )}
        {!!missing && (
          <ConfirmationSheetDetailRow label="Not in this refund" value={usdAtomicFloor(missing)} />
        )}
        {funds?.savingsFailed && (
          <ConfirmationSheetDetailRow label="Savings" value="Couldn't check. Try again later." />
        )}
        {!!waiting && (
          <ConfirmationSheetDetailRow
            label="Not yet withdrawable"
            value={usdAtomicFloor(waiting)}
          />
        )}
        <ConfirmationSheetDetailRow label="Network fee" value="Gas in ETH, from your wallet" />
        {funds && (
          <ConfirmationSheetDetailRow
            label="You'll receive"
            value={
              [
                ...(funds.main.refundable
                  ? [`${usdAtomicFloor(funds.main.refundable)} in DAI`]
                  : []),
                ...(savings?.refundable ? [`${shares(savings.refundable)} ${savingsSymbol}`] : []),
              ].join(" + ") || usdAtomicFloor(0n)
            }
          />
        )}
      </div>
      {!!missing && (
        <span className="ww-frozen-exit__hint">
          The refund couldn't find some of your payment links. Contact support before you clear this
          browser's data.
        </span>
      )}
      <Banner
        tone="error"
        title="This cannot be undone"
        body="Funds leave zk.money for good once sent."
      />
    </>
  )
}

export function FrozenExitPreparing({
  sent,
  bridgeMode,
}: {
  sent?: FrozenExitSent
  bridgeMode: boolean
}) {
  return (
    <FrozenExitCard>
      <Banner
        tone="warning"
        title="Keep zk.money open"
        body="Leaving now restarts the withdrawal."
      />
      <Spinner size={40} />
      <Eyebrow>{step(2)}</Eyebrow>
      <Title>Preparing your withdrawal</Title>
      <Lead>
        We are building your proof on this device.{" "}
        {sent ? `${usdAtomicFloor(sent.refunded)} sent so far.` : "Nothing has moved yet."}
      </Lead>
      <p className="ww-sheet__note">
        Next, you approve the transfer in {bridgeMode ? "your browser" : "your wallet"}.
      </p>
    </FrozenExitCard>
  )
}

export function FrozenExitApprove({
  stage,
  sent,
  bridgeMode,
}: {
  stage: L1ExitStage
  sent?: FrozenExitSent
  bridgeMode: boolean
}) {
  const where = bridgeMode ? "your browser" : "your wallet"
  const confirming = stage === "confirming"
  return (
    <FrozenExitCard>
      <Eyebrow>{step(3)}</Eyebrow>
      <Title>{`Approve the transfer in ${where}`}</Title>
      <Lead>Approve the transfer in {where}. Waiting for Ethereum confirmation.</Lead>
      <ol className="ww-frozen-exit__box ww-frozen-exit__steps">
        <Step state="done" label="Proof ready" />
        <Step state={confirming ? "done" : "active"} label={`Approve in ${where}`} />
        <Step state={confirming ? "active" : "todo"} label="Confirmed on Ethereum" />
      </ol>
      {sent && <p className="ww-sheet__note">{usdAtomicFloor(sent.refunded)} sent so far.</p>}
      <p className="ww-sheet__note">Keep zk.money open until funds are sent.</p>
    </FrozenExitCard>
  )
}

export function FrozenExitDoneCard({
  done,
  onClose,
}: {
  done: FrozenExitDone
  onClose: () => void
}) {
  const url = done.hashes.length === 1 ? l1TxUrl(done.hashes[0]) : undefined
  return (
    <FrozenExitCard>
      <DoubleCheckIcon size={40} />
      <Title>{`${usdAtomicFloor(done.refunded)} withdrawn`}</Title>
      <Lead>
        Sent to {shortL1Addr(done.to)}.
        {done.left > 0n &&
          ` ${usdAtomicFloor(done.left)} can't be withdrawn yet. Come back later to withdraw it.`}
      </Lead>
      <div className="ww-frozen-exit__box ww-frozen-exit__address">
        <span>To</span>
        <code>{done.to}</code>
      </div>
      {url ? (
        <PrimaryGradientButton
          title="View transaction"
          onClick={() => window.open(url, "_blank", "noopener")}
          style={{ width: "100%", height: 48 }}
        />
      ) : (
        <HashRows hashes={done.hashes} />
      )}
      <TextButton onClick={onClose}>Close</TextButton>
    </FrozenExitCard>
  )
}

/** sUSDS share count, to two decimals. */
const shares = (amount: bigint) => Number(formatUnits(amount, DEFAULT_DECIMALS)).toFixed(2)

export function FrozenExitCard({ children }: { children: ReactNode }) {
  return (
    <div className="ww-panel ww-deposit ww-withdraw" data-testid="frozen-exit">
      <div className="ww-deposit__stealth">
        <div className="ww-deposit__fields ww-frozen-exit">{children}</div>
      </div>
    </div>
  )
}

export const Eyebrow = ({ children }: { children: ReactNode }) => (
  <span className="ww-frozen-exit__eyebrow">{children}</span>
)

export const Title = ({ children }: { children: string }) => (
  <GradientText size={28} weight={700}>
    {children}
  </GradientText>
)

export const Lead = ({ children }: { children: ReactNode }) => (
  <p className="ww-frozen-exit__lead">{children}</p>
)

export const TextButton = ({ children, onClick }: { children: string; onClick: () => void }) => (
  <button type="button" className="zkm-btn-reset ww-frozen-exit__back" onClick={onClick}>
    {children}
  </button>
)

export const HashRows = ({ hashes }: { hashes: Hex[] }) => (
  <>
    {hashes.map((hash) => (
      <HashRow key={hash} label="Transaction ID" hash={hash} url={l1TxUrl(hash)} />
    ))}
  </>
)

export function Banner({
  tone,
  title,
  body,
}: {
  tone: "warning" | "error" | "success"
  title: string
  body: string
}) {
  return (
    <div className="ww-withdraw__warning" data-tone={tone} role="note">
      <span className="ww-withdraw__warning-head">
        <Icon name="shield-exclamation" size={16} />
        {title}
      </span>
      <div className="ww-withdraw__warning-body">
        <p>{body}</p>
      </div>
    </div>
  )
}

export function Step({ state, label }: { state: "done" | "active" | "todo"; label: string }) {
  return (
    <li className="ww-frozen-exit__step" data-state={state}>
      {state === "done" ? (
        <Icon name="check" size={16} />
      ) : state === "active" ? (
        <Spinner size={16} />
      ) : (
        <span className="ww-frozen-exit__dot" />
      )}
      {label}
    </li>
  )
}
