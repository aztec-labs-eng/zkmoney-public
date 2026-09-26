import { useEffect, useSyncExternalStore, type ReactNode } from "react"
import { erc20Abi, type Address, type Hex } from "viem"
import type { RegistrationKind } from "@obsidion/core/types"
import { Icon } from "@obsidion/web-ds"
import { getConfig } from "../../../config/env"
import { l1PublicClient } from "../../../config/oxideTuple"
import { showReportableError } from "../../../errors/errorModal"
import { shortAddr } from "../../../ui/format"
import { useCopy } from "../../../ui/hooks"
import { ScreeningNotice, useScreenedAddress } from "../../../ui/screening"
import { getL1Clients, useL1Wallet } from "../../deposit/l1Wallet"
import { reportRegistrationDepositShown } from "../registrationFunnel"
import connectIcon from "../../../assets/deposit/eth-fill.svg"

/** `0x4a88F2...3d6A9f`. The full address rides the copy button's label and title. */
function shorten(address: Address): string {
  return `${address.slice(0, 8)}...${address.slice(-6)}`
}

/**
 * Where to send: one ringed row, the address short enough to check against a wallet's own display
 * and one tap to copy in full. The live check sits at its right.
 */
export function DepositAddressRow({
  address,
  kind,
  note,
}: {
  address: Address
  /** The schedule the deposit this row asks for was quoted on; rides the funnel event. */
  kind?: RegistrationKind
  /** Small line under the row, right-aligned: when it was last checked, and the retry. */
  note?: ReactNode
}) {
  const { copied, copy } = useCopy()
  useEffect(() => {
    reportRegistrationDepositShown(address, kind)
  }, [address, kind])
  return (
    <>
      <div className="ww-send-to">
        <button
          type="button"
          className="zkm-btn-reset zkm-pressable ww-send-to__copy"
          aria-label={`Copy deposit address ${address}`}
          title={address}
          onClick={() => copy(address)}
        >
          <span className="ww-send-to__label">Send to</span>
          <span className="ww-send-to__value">{shorten(address)}</span>
          <span className="ww-send-to__icon" aria-live="polite">
            {copied ? (
              <Icon name="check-circle" size={16} color="var(--accent-green)" />
            ) : (
              <Icon name="copy" size={16} color="#fff" />
            )}
          </span>
        </button>
      </div>
      {note != null && <div className="ww-send-to__note">{note}</div>}
    </>
  )
}

interface PayTarget {
  address: Address
  token: Address
  chainId: number
  /** Base units; zero means the sender picks the amount. */
  total: bigint
}

/** The network warning, then the deposit screen's connect row. */
export function DepositPayBlock({
  note,
  ...target
}: PayTarget & {
  /** Sits above the row, where the design puts the network warning. */
  note?: ReactNode
}) {
  return (
    <>
      {note}
      <ConnectedWalletPay {...target} />
    </>
  )
}

// Session-scoped: closing a sheet or disconnecting must not forget an in-flight payment.
// The target, not the payer or quoted amount, owns the lock across both registration surfaces.
type Payment = { state: "sending" | "confirming" | "check" | "sent"; hash?: Hex }
const payments = new Map<string, Payment>()
const paymentListeners = new Set<() => void>()
function subscribePayments(listener: () => void) {
  paymentListeners.add(listener)
  return () => {
    paymentListeners.delete(listener)
  }
}
function setPayment(key: string, payment?: Payment) {
  if (payment) payments.set(key, payment)
  else payments.delete(key)
  paymentListeners.forEach((listener) => listener())
}

/**
 * The deposit screen's connect row: RainbowKit to connect, then one click transfers `total` from
 * the screened account. The sheet's own check spots the deposit landing.
 */
function ConnectedWalletPay({ address, token, chainId, total }: PayTarget) {
  const l1 = useL1Wallet({ expectedChainId: chainId })
  const { verdict, cleared, rescreen } = useScreenedAddress(l1.account, "deposit")
  const key = `${chainId}:${token.toLowerCase()}:${address.toLowerCase()}`
  const payment = useSyncExternalStore(subscribePayments, () => payments.get(key))
  const state = payment?.state ?? "idle"

  const pay = async () => {
    const current = payments.get(key)
    if (current && current.state !== "check") return
    if (!current && (!l1.account || !cleared || total <= 0n)) return
    let hash = current?.hash
    let failed = false
    setPayment(key, { state: hash ? "confirming" : "sending", hash })
    try {
      const config = getConfig()
      if (config.l1ChainId !== chainId) throw new Error("Switch to the registration network first.")
      const publicClient = l1PublicClient(config)
      if (!hash) {
        const { walletClient, account, chain } = await getL1Clients(chainId, l1.account!)
        hash = await walletClient.writeContract({
          address: token,
          abi: erc20Abi,
          functionName: "transfer",
          args: [address, total],
          account,
          chain,
        })
      }
      setPayment(key, { state: "confirming", hash })
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        onReplaced: ({ reason, transaction }) => {
          hash = transaction.hash
          failed = reason !== "repriced"
        },
      })
      failed ||= receipt.status !== "success"
      if (failed) throw new Error("The funding transaction failed or was replaced. Try again.")
      setPayment(key, { state: "sent", hash })
    } catch (e) {
      // An RPC error or timeout does not prove failure: recheck the same hash, never resend it.
      setPayment(key, hash && !failed ? { state: "check", hash } : undefined)
      showReportableError(e, "registration:fund")
    }
  }

  // ponytail: an open amount has no one-click send; the connected wallet pays the address by hand.
  const title =
    state === "sent"
      ? "Payment sent"
      : state === "sending"
      ? "Approve in your wallet…"
      : state === "confirming"
      ? "Confirming payment…"
      : state === "check"
      ? "Check payment status"
      : !l1.account
      ? "Connect your wallet"
      : total === 0n
      ? "Wallet connected"
      : `Pay from ${l1.walletName ?? "wallet"}`
  const subtitle = !l1.account
    ? "Use WalletConnect, Rainbow, or MetaMask"
    : total === 0n
    ? "Send any amount to the address above"
    : shortAddr(l1.account)
  const disabled =
    state !== "check" && (state !== "idle" || (!!l1.account && (!cleared || total === 0n)))
  return (
    <>
      <div className="ww-deposit__or">
        <hr className="ww-divider" />
        <span>or</span>
        <hr className="ww-divider" />
      </div>
      {l1.account && !cleared && (
        <ScreeningNotice
          verdict={verdict}
          checkingCopy="Checking your wallet…"
          blockedFallback="This wallet can't be used to pay. Connect a different one."
          errorCopy="Couldn't verify your wallet."
          onRetry={rescreen}
        />
      )}
      <button
        type="button"
        className="zkm-btn-reset zkm-pressable ww-deposit__connect"
        disabled={disabled}
        onClick={() => void (state === "check" || l1.account ? pay() : l1.connect())}
      >
        <span className="ww-deposit__connect-icon">
          <img src={connectIcon} alt="" width={24} height={24} />
        </span>
        <span className="ww-deposit__connect-text">
          <b>{title}</b>
          <span>{subtitle}</span>
        </span>
        <Icon name="chevron-right" size={16} color="var(--text-secondary)" />
      </button>
      {l1.account && state !== "sending" && (
        <button
          type="button"
          className="zkm-btn-reset ww-deposit__disconnect"
          onClick={l1.disconnect}
        >
          Disconnect
        </button>
      )}
    </>
  )
}
