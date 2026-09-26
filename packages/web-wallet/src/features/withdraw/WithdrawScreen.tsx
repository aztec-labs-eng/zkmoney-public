import { useEffect, useState } from "react"
import { useLocation } from "react-router-dom"
import { getAddress, isAddress, type Address } from "viem"
import { ContactStorage, L1_PLACEHOLDER_NAME, useBalance } from "@obsidion/front-core"
import { GradientText, Icon, PrimaryGradientButton } from "@obsidion/web-ds"
import { getConfig } from "../../config/env"
import { fireEvent } from "../../lib/analytics"
import { shortAddr, tokenAmount } from "../../ui/format"
import { ScreeningNotice, useScreenedAddress } from "../../ui/screening"
import { useL1Wallet } from "../deposit/l1Wallet"
import {
  WithdrawPrivacyDisclaimer,
  isWithdrawPrivacyDisclaimerHidden,
} from "./WithdrawPrivacyDisclaimer"
import { isDesktopL1SubmitActive } from "../../platform/desktopBridge"
import { WithdrawToWalletModal } from "./WithdrawToWalletModal"
import {
  FEE_UNAVAILABLE_COPY,
  SwapFeeNote,
  useSwapSimulation,
  withdrawalFeeDisplay,
} from "./withdrawQuote"
import { useEthRecipientHasCode } from "./ethRecipientCheck"
import { WithdrawalAssetPicker } from "./WithdrawalAssetPicker"
import type { WithdrawalReceiveAsset } from "./withdrawAssets"
import ethIcon from "../../assets/deposit/ethereum.webp"
import connectIcon from "../../assets/deposit/eth-fill.svg"

export interface SavedL1Wallet {
  address: Address
  name: string
}

/** Most-recent L1 wallet contacts (saved recipients + deposit funders), tombstones hidden. */
export function useSavedL1Wallets(): SavedL1Wallet[] {
  const [wallets, setWallets] = useState<SavedL1Wallet[]>([])
  useEffect(() => {
    ContactStorage.get()
      .getEntries()
      .then((entries) => {
        const rows = entries
          .filter((e) => e.addressKind === "ethereum-l1" && !!e.l1Wallet)
          .filter((e) => {
            const w = e.l1Wallet!
            return !w.deletedAt || (w.lastUsedAt ?? 0) > w.deletedAt
          })
          .sort((a, b) => (b.l1Wallet!.lastUsedAt ?? 0) - (a.l1Wallet!.lastUsedAt ?? 0))
          .slice(0, 3)
          .map((e) => ({ address: e.address as Address, name: e.name }))
        setWallets(rows)
      })
      .catch(() => {})
  }, [])
  return wallets
}

/**
 * Withdraw to L1: name (optional) + recipient address — typed, pasted, picked from the connected
 * wallet, or picked from a saved L1 wallet — then amount → confirm → sponsored burn in
 * `WithdrawToWalletModal`, which hands the burn to the bell. Finalization is oxide's relayer; the
 * withdrawal's own rows track it through the same phases the Activity tab shows.
 */
export function WithdrawScreen() {
  const config = getConfig()
  const location = useLocation()
  // Prefill from contact-detail navigation; the form's own isAddress gate validates it.
  const prefill = (location.state ?? {}) as { recipient?: string; alias?: string }
  const [walletName, setWalletName] = useState(prefill.alias ?? "")
  const [recipient, setRecipient] = useState(prefill.recipient ?? "")
  const [receiveAsset, setReceiveAsset] = useState<WithdrawalReceiveAsset>("DAI")
  const [amountOpen, setAmountOpen] = useState(false)

  const { walletAsset } = useBalance()
  const saved = useSavedL1Wallets()
  // Connected-wallet pick — withdrawing back to the wallet you funded from is the common case,
  // and the injected provider already knows it.
  const l1 = useL1Wallet({ expectedChainId: config.l1ChainId, rpcUrl: config.l1RpcUrl })
  // The desktop launcher's Chrome profile carries no wallet extension, so there is nothing to
  // connect — the typed/saved paths remain.
  const bridgeMode = isDesktopL1SubmitActive()

  const validRecipient = isAddress(recipient)
  // The fee row states the same all-in figure the amount and confirm steps do, so switching the
  // receive asset here cannot promise the direct route's fee and then charge the swap route's floor.
  // A route that cannot be priced is closed here, before an amount is ever typed.
  const quote = useSwapSimulation({
    receiveAsset,
    recipient: validRecipient ? getAddress(recipient) : undefined,
    network: config.network,
  })
  const feeDisplay = withdrawalFeeDisplay(quote)
  const feeUnavailable = quote.status === "unavailable"
  const ethRecipientIsContract = useEthRecipientHasCode(recipient, receiveAsset === "ETH")
  // Screen the recipient once it parses as an address; typing and the picks all land here.
  const {
    verdict: screening,
    cleared: recipientCleared,
    rescreen,
  } = useScreenedAddress(validRecipient ? getAddress(recipient) : null, "withdraw", {
    debounceMs: 300,
  })

  useEffect(() => {
    fireEvent("withdraw_opened")
  }, [])

  // Connecting is itself a pick: fill the row, leaving anything typed or prefilled alone.
  const connected = l1.account
  useEffect(() => {
    if (!connected) return
    setRecipient((r) => r || connected)
    setWalletName((n) => n || l1.walletName || "")
  }, [connected])

  const [disclaimer, setDisclaimer] = useState(() => !isWithdrawPrivacyDisclaimerHidden())

  const pick = (wallet: SavedL1Wallet) => {
    setRecipient(wallet.address)
    setWalletName(wallet.name === L1_PLACEHOLDER_NAME ? "" : wallet.name)
  }

  const paste = () =>
    navigator.clipboard
      .readText()
      .then((text) => setRecipient(text.trim()))
      .catch(() => {})

  return (
    <div className="ww-panel ww-deposit ww-withdraw">
      <div className="ww-deposit__stealth">
        <GradientText size={24} weight={700}>
          Withdraw
        </GradientText>

        <div className="ww-deposit__fields">
          <p className="ww-withdraw__warning" role="note">
            Use a fresh withdrawal address each time. Withdrawing to the same Ethereum address
            repeatedly will link your withdrawals together.
          </p>
          <label className="ww-withdraw__field">
            <span>Wallet name (optional)</span>
            <span className="ww-withdraw__box">
              <input
                placeholder="e.g. Rainbow"
                value={walletName}
                onChange={(e) => setWalletName(e.target.value)}
              />
            </span>
          </label>
          <label className="ww-withdraw__field">
            <span>Address</span>
            <span className="ww-withdraw__box">
              <input
                placeholder="Enter or paste address"
                spellCheck={false}
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
              />
              {recipient ? (
                <button
                  type="button"
                  className="zkm-btn-reset ww-withdraw__clear"
                  aria-label="Clear address"
                  onClick={() => setRecipient("")}
                >
                  <Icon name="x" size={12} />
                </button>
              ) : (
                <button type="button" className="zkm-btn-reset ww-withdraw__paste" onClick={paste}>
                  Paste <Icon name="copy" size={12} />
                </button>
              )}
            </span>
          </label>
          {saved.length > 0 && (
            <div className="ww-withdraw__saved">
              <span className="ww-withdraw__saved-title">Saved wallets</span>
              {saved.map((w) => (
                <button
                  key={w.address}
                  type="button"
                  className="zkm-btn-reset zkm-pressable ww-withdraw__saved-row"
                  onClick={() => pick(w)}
                >
                  <Icon name="wallet" size={18} color="var(--text-secondary)" />
                  <b>{w.name}</b>
                  <span>{shortAddr(w.address)}</span>
                </button>
              ))}
            </div>
          )}
          {validRecipient && !recipientCleared && (
            <ScreeningNotice
              verdict={screening}
              checkingCopy="Checking address…"
              blockedFallback="This address can't receive withdrawals."
              errorCopy="Couldn't verify this address."
              onRetry={rescreen}
            />
          )}
          {ethRecipientIsContract && (
            <p className="ww-withdraw__warning" role="status">
              This address is a contract. The ETH route pays it with a plain transfer, and a
              contract that rejects ETH would leave the funds stuck at the swap escrow. Pick a
              different address, or receive USDC or USDT instead.
            </p>
          )}
          <div className="ww-deposit__facts">
            <WithdrawalAssetPicker value={receiveAsset} onChange={setReceiveAsset} />
            <div className="ww-deposit__fact">
              <span>Network</span>
              <b>
                <img src={ethIcon} alt="" width={16} height={16} />
                Ethereum (ERC20)
              </b>
            </div>
            <hr className="ww-divider" />
            <div className="ww-deposit__fact">
              <span>Fee</span>
              <b>
                {feeDisplay === undefined
                  ? "--"
                  : `${tokenAmount(feeDisplay)} ${walletAsset?.symbol ?? "zkUSD"}`}
              </b>
            </div>
            {receiveAsset === "DAI" ? (
              feeUnavailable && (
                <p className="ww-withdraw__warning" role="status">
                  {FEE_UNAVAILABLE_COPY}
                </p>
              )
            ) : (
              <SwapFeeNote state={quote} />
            )}
          </div>
          <PrimaryGradientButton
            title="Continue"
            isDisabled={!validRecipient || !recipientCleared || feeUnavailable}
            onClick={() => setAmountOpen(true)}
            style={{ width: "100%", height: 48 }}
          />
        </div>
      </div>

      {!bridgeMode && (
        <>
          <div className="ww-deposit__or">
            <hr className="ww-divider" />
            <span>or</span>
            <hr className="ww-divider" />
          </div>

          <button
            type="button"
            className="zkm-btn-reset zkm-pressable ww-deposit__connect"
            onClick={() => {
              if (!connected) return void l1.connect()
              setRecipient(connected)
              setWalletName(l1.walletName ?? "")
            }}
          >
            <span className="ww-deposit__connect-icon">
              <img src={connectIcon} alt="" width={24} height={24} />
            </span>
            <span className="ww-deposit__connect-text">
              <b>{l1.account ? "Use your connected wallet" : "Connect your wallet"}</b>
              <span>
                {l1.account
                  ? `${l1.walletName ?? "Wallet"} · ${shortAddr(l1.account)}`
                  : "Use WalletConnect, Rainbow, or MetaMask"}
              </span>
            </span>
            <Icon name="chevron-right" size={16} color="var(--text-secondary)" />
          </button>
          {l1.account && (
            <button
              type="button"
              className="zkm-btn-reset ww-deposit__disconnect"
              onClick={l1.disconnect}
            >
              Disconnect
            </button>
          )}
        </>
      )}

      {amountOpen && validRecipient && (
        <WithdrawToWalletModal
          recipient={getAddress(recipient)}
          walletName={walletName.trim() || undefined}
          receiveAsset={receiveAsset}
          onClose={() => setAmountOpen(false)}
          onDone={() => {
            setAmountOpen(false)
            setRecipient("")
            setWalletName("")
          }}
        />
      )}

      {disclaimer && <WithdrawPrivacyDisclaimer onClose={() => setDisclaimer(false)} />}
    </div>
  )
}
