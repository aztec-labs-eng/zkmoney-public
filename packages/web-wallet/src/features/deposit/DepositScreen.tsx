import { useCallback, useEffect, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import {
  SIPADepositStore,
  useAztecContext,
  useCachedRecords,
  useContractServiceContext,
} from "@obsidion/front-core"
import { GradientText, Icon, Spinner } from "@obsidion/web-ds"
import { getConfig } from "../../config/env"
import { runUserFlow, useUserFlowActive } from "../provingGate"
import { runOperation } from "../operations/operations"
import { showReportableError } from "../../errors/errorModal"
import { amountBucket, failureCode, fireEvent, lapTimer } from "../../lib/analytics"
import { useCopy } from "../../ui/hooks"
import { shortAddr, usdFigure } from "../../ui/format"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { useRegistrationEscalated, useTagPresentationPending } from "../onboarding/webRegistration"
import { buildErc20TransferUriWithoutAmount } from "../requests/eip681"
import { DepositFromWalletModal, type SentDeposit } from "./DepositFromWalletModal"
import { DepositQrSheet } from "./DepositQrSheet"
import { webStorage } from "../../platform/storage/WebStorageAdapter"
import { isDemoMode } from "../../dev/demoFlag"
import { DepositDetailModal } from "../../ui/screens/DepositDetailModal"
import {
  depositTokensFor,
  loadDepositDisplayFacts,
  type DepositDisplayFacts,
  type DepositTokenOption,
} from "./loadDepositFacts"
import { sentDepositRecord } from "./sentDepositRecord"
import { useL1Wallet } from "./l1Wallet"
import { readL1TokenBalance } from "./l1DepositTokenBalance"
import { isDesktopL1SubmitActive } from "../../platform/desktopBridge"
import { isOneTimeAddressWarningHidden, OneTimeAddressWarning } from "./OneTimeAddressWarning"
import {
  DepositPrivacyDisclaimer,
  isDepositPrivacyDisclaimerHidden,
} from "./DepositPrivacyDisclaimer"
import { getSipaDepositGateway, type DepositAddress, type DepositStage } from "./sipaGateway"
import ethIcon from "../../assets/deposit/ethereum.webp"
import connectIcon from "../../assets/deposit/eth-fill.svg"

const STAGE_LABEL: Partial<Record<DepositStage, string>> = {
  resolving: "Deriving your deposit address",
  broadcasting: "Publishing it to the network",
}

/** How often the address on screen is checked for a transfer nobody told us about. */
const FUNDING_POLL_MS = 10_000

/** Map raw errors to something a user can act on (esp. the stale-identity resolve revert). */
function friendlyError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  if (/UserNotFound|User not found/i.test(msg)) {
    return "This @tag isn't registered on the current network — your saved login is likely from a previous deployment. Clear site data and claim again."
  }
  return msg
}

/** The Fee row while the quote is still being read. */
export const QUOTE_PENDING = "Checking\u2026"

/** What to do when the fee read failed and the funding controls are held. */
export const FEE_UNAVAILABLE_NOTE = "Use Retry above to load the fee and continue."

/**
 * Deposit: generate a single-use SIPA address for THIS wallet's `<tag>.<ensDomain>` and hand it to
 * the user (copy / QR) or funds it from a connected wallet. Anything sent there is discovered and
 * credited automatically by the SIPA sync loop mounted in WalletGate.
 */
export function DepositScreen() {
  const navigate = useNavigate()
  const handle = loadWalletIdentity()?.handle
  // The gate is effectful, not cosmetic: while the registration is unconfirmed, deriving and
  // publishing a deposit address for a name that may be lost must not happen at all.
  const claiming = useTagPresentationPending()
  const escalated = useRegistrationEscalated()
  const { obsidionWallet } = useAztecContext()
  const { contractService } = useContractServiceContext()
  const gateway = getSipaDepositGateway()
  const { l1ChainId, l1RpcUrl, network, oxideProfile } = getConfig()
  const manifestUrl = oxideProfile.manifestUrl

  const [deposit, setDeposit] = useState<DepositAddress>()
  const [stage, setStage] = useState<DepositStage>()
  // Covers the gap between the click and the first gateway stage event, so a second click can't
  // buy a second derivation.
  const [generating, setGenerating] = useState(false)
  const busy = useUserFlowActive()
  const l1 = useL1Wallet({ expectedChainId: l1ChainId, rpcUrl: l1RpcUrl })
  // Desktop launcher: no wallet extension, the transfer is approved in the default browser.
  const bridgeMode = isDesktopL1SubmitActive()
  const canFund = bridgeMode || !!l1.account
  // The one-time-address warning fronts every copy / QR until the user checks "Don't show this
  // again" and confirms. "Got it" continues to the QR when that was the intent, otherwise dismisses.
  const [warning, setWarning] = useState<"copy" | "qr">()
  const [showQr, setShowQr] = useState(false)
  const [fundOpen, setFundOpen] = useState(false)
  // A funding click made while disconnected, waiting on the wallet the picker is asking for.
  const [fundOnConnect, setFundOnConnect] = useState(false)
  // After the wallet broadcasts a deposit the detail sheet tracks it: a client-side `funding` view
  // until event discovery creates the store record, then that record as it advances.
  const [sent, setSent] = useState<SentDeposit>()
  const depositStore = useMemo(() => SIPADepositStore.get(webStorage), [])
  const { records } = useCachedRecords(depositStore)
  const stored = sent
    ? records.find((r) => r.sipaAddress.toLowerCase() === sent.address.toLowerCase())
    : undefined
  const tokens = depositTokensFor(network)
  const [token, setToken] = useState<DepositTokenOption>(tokens[0])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [disclaimer, setDisclaimer] = useState(() => !isDepositPrivacyDisclaimerHidden())
  const [facts, setFacts] = useState<DepositDisplayFacts>()
  const [factsFailed, setFactsFailed] = useState(false)
  const [factsAttempt, setFactsAttempt] = useState(0)
  const fee = facts?.fee
  const manifestToken = facts?.token
  const sentRecord = sent ? sentDepositRecord(sent, stored, l1ChainId, facts) : undefined
  const { copied, copy } = useCopy()
  // Without the fee nothing may be funded: the wallet path would charge amount + 0 while the sweep
  // still takes the real fee. Show/Copy/Deposit stay disabled until it loads.
  const quoteFailed = fee == null && factsFailed
  const quoteLoading = fee == null && !factsFailed
  const reloadFacts = () => setFactsAttempt((n) => n + 1)

  useEffect(() => {
    fireEvent("deposit_sheet_opened")
  }, [])

  // Both halves of the quote are per-deployment immutables, so the read is redone only on Retry
  // and when the deployment behind it changes.
  useEffect(() => {
    let stale = false
    setFactsFailed(false)
    void loadDepositDisplayFacts()
      .then((next) => {
        if (!stale) setFacts(next)
      })
      .catch((e) => {
        if (stale) return
        console.warn("[deposit] fee quote failed:", e)
        fireEvent("action_failed", { action: "deposit:facts", code: failureCode(e) })
        setFactsFailed(true)
      })
    return () => {
      stale = true
    }
  }, [factsAttempt, l1RpcUrl, l1ChainId, manifestUrl])

  // Dev demo: the fixture address stands in for a derived one. `import.meta.env.DEV` is a
  // build-time literal, so a production build drops this body and the dynamic import with it.
  useEffect(() => {
    if (!import.meta.env.DEV || !isDemoMode() || claiming || deposit || !handle) return
    let stale = false
    void import("../../dev/demoDeposit")
      .then(({ demoDepositAddress }) => {
        if (!stale) setDeposit(demoDepositAddress(handle))
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [claiming, deposit, handle])

  // A pooled pre-broadcast address costs nothing to show — no proof, no passkey, the sponsored
  // slot was spent at fill time — so it appears on open. Popping consumes the entry, so the next
  // open shows a different address, same as clicking Generate.
  useEffect(() => {
    if (claiming || deposit || generating || !handle || !obsidionWallet || !contractService) return
    let stale = false
    gateway
      .pooledDepositAddress(obsidionWallet, contractService, handle)
      .then((pooled) => {
        if (!pooled || stale) return
        setDeposit(pooled)
        fireEvent("deposit_address_shown", { pooled: true })
      })
      // An empty pool is not an error — the Generate button below is the fallback.
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [claiming, deposit, generating, handle, obsidionWallet, contractService, gateway])

  // The fallback stays behind a click: an empty-pool derivation costs an in-browser proof and one
  // sponsored-broadcast slot, and a first-ever publish batches the account-setup passkey
  // assertion, which browsers only honour inside a live user-activation window.
  const resolveAddress = useCallback((): Promise<boolean> => {
    if (!handle || !obsidionWallet || !contractService) return Promise.resolve(false)
    setGenerating(true)
    const elapsed = lapTimer()
    const stageLap = lapTimer()
    let sawResolving = false
    fireEvent("address_resolve_started", { fresh: false })
    const onStage = (next: DepositStage) => {
      if (next === "resolving") sawResolving = true
      fireEvent("deposit_resolve_stage", { stage: next, prev_stage_ms: stageLap() })
      setStage(next)
    }
    // Wait out a live publish before showing. Funds at an unpublished SIPA are not lost, but the
    // relayer will not sweep until the broadcast lands — and a failed publish leaves the user
    // looking at an address nobody is watching. The gate covers the derive too, so a refill proof
    // cannot start under it; only the proof runs as an operation.
    return runUserFlow(async () => {
      const next = await gateway.depositAddress(obsidionWallet, contractService, handle, {
        fresh: false,
        onStage,
      })
      fireEvent("address_resolve_succeeded", {
        duration_ms: elapsed(),
        cached: !sawResolving,
        fresh: false,
      })
      const { publish } = next
      if (publish) {
        const publishLap = lapTimer()
        const operationId = `deposit_${crypto.randomUUID()}`
        try {
          await runOperation({ operationId, flow: "deposit", summary: "Deposit address" }, () =>
            publish({ operationId, saveHash: true }),
          )
          fireEvent("address_published", { duration_ms: publishLap() })
        } catch (e) {
          fireEvent("address_publish_failed", {
            duration_ms: publishLap(),
            code: failureCode(e),
          })
          throw e
        }
      }
      setDeposit({ address: next.address, name: next.name })
      fireEvent("deposit_address_shown", { pooled: false })
      return true
    })
      .catch((e) => {
        fireEvent("address_resolve_failed", { duration_ms: elapsed(), code: failureCode(e) })
        showReportableError(e, "deposit:resolve", { message: friendlyError(e) })
        return false
      })
      .finally(() => {
        setGenerating(false)
        setStage(undefined)
      })
  }, [gateway, handle, obsidionWallet, contractService])

  /** Open the funding sheet. Funding needs the address the user is shown, so derive one first. */
  const beginFunding = useCallback(() => {
    if (fee == null) return
    if (deposit) return setFundOpen(true)
    if (!generating) void resolveAddress().then((ok) => ok && setFundOpen(true))
  }, [fee, deposit, generating, resolveAddress])

  // `l1.connect` only opens the wallet picker; the account lands renders later, so the click that
  // asked to fund would otherwise stop at "Wallet connected" and need a second one. A picker that
  // closes without a wallet takes the click with it, so a wallet connecting on its own later does
  // not find it waiting. A successful pick cannot close the picker ahead of its account: wagmi
  // stores the connection before RainbowKit reacts to it.
  useEffect(() => {
    if (!fundOnConnect) return
    if (canFund) {
      setFundOnConnect(false)
      beginFunding()
    } else if (!l1.pickerOpen) {
      setFundOnConnect(false)
    }
  }, [fundOnConnect, canFund, l1.pickerOpen, beginFunding])

  const ready = !!deposit && !generating && fee != null
  const qrToken = token.address ?? manifestToken

  // A third-party send leaves no local trace, and the sync loop's own funding read drops to a
  // five-minute lane once the address is ten minutes old — too slow for a screen someone is
  // watching. Leaving is the whole signal: the deposit shows itself in the activity feed.
  useEffect(() => {
    // The connected-wallet path is tracked by its own detail sheet, not by leaving.
    if (!deposit || !qrToken || fundOpen || sent) return
    // The demo's fake L1 reports a balance for every address, which would read as
    // an instant external send.
    if (import.meta.env.DEV && isDemoMode()) return
    let cancelled = false
    // Terminal: overlapping slow reads can both settle funded before the navigation unmounts us.
    let funded = false
    // ponytail: only the picked token is watched; funding in another one still lands via the
    // sync loop's own read, just without closing the screen.
    const timer = setInterval(() => {
      void readL1TokenBalance(qrToken, deposit.address)
        .then((balance) => {
          if (cancelled || funded || balance === 0n) return
          funded = true
          fireEvent("deposit_funded", {
            funding: "external",
            amount_bucket: amountBucket(balance, token.decimals),
          })
          navigate("/")
        })
        .catch((e) => {
          if (!cancelled) console.warn("[deposit] funding poll failed:", e)
        })
    }, FUNDING_POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [deposit, qrToken, fundOpen, sent, navigate, token.decimals])

  // The warning gates first use: the clipboard is written on "Got it", not before.
  const copyAddress = () => {
    if (isOneTimeAddressWarningHidden()) void copy(deposit!.address)
    else setWarning("copy")
  }

  const showQrCode = () => {
    if (isOneTimeAddressWarningHidden()) setShowQr(true)
    else setWarning("qr")
  }

  return (
    <div className="ww-panel ww-deposit">
      <div className="ww-deposit__stealth">
        <GradientText size={24} weight={700}>
          Deposit
        </GradientText>

        {claiming ? (
          <div className="ww-deposit__note" style={{ width: "auto" }}>
            Your @tag is still being claimed — deposit addresses become available once it settles.{" "}
            {escalated ? "This is taking longer than usual." : "This usually takes about a minute."}{" "}
            {/* Web has no background re-sign — the claim page owns the status check. */}
            <button
              type="button"
              className="zkm-btn-reset ww-deposit__link"
              onClick={() => navigate(handle ? `/claim/${handle}` : "/claim")}
            >
              Check on your claim
            </button>
          </div>
        ) : (
          <>
            <div className="ww-deposit__fields">
              <div className="ww-deposit__facts">
                <div className="ww-deposit__fact">
                  <span>Token</span>
                  <button
                    type="button"
                    className="zkm-btn-reset ww-deposit__pill"
                    aria-expanded={pickerOpen}
                    onClick={() => setPickerOpen((o) => !o)}
                  >
                    <img src={token.icon} alt="" width={16} height={16} />
                    {token.symbol}
                    <Icon name={pickerOpen ? "chevron-up" : "chevron-down"} size={16} />
                  </button>
                  {pickerOpen && (
                    <div className="ww-deposit__picker">
                      {tokens.map((t) => (
                        <button
                          key={t.symbol}
                          type="button"
                          className="zkm-btn-reset ww-deposit__picker-row"
                          aria-selected={t === token}
                          onClick={() => {
                            setToken(t)
                            setPickerOpen(false)
                          }}
                        >
                          <img src={t.icon} alt="" width={30} height={30} />
                          <span>
                            <b>{t.symbol}</b>
                            <small>1 {t.symbol} ≈ $1</small>
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
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
                  {quoteFailed ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                      <b>Unavailable</b>
                      <button
                        type="button"
                        className="zkm-btn-reset ww-deposit__link"
                        data-testid="deposit-facts-retry"
                        onClick={reloadFacts}
                      >
                        Retry
                      </button>
                    </span>
                  ) : (
                    <b data-testid="deposit-fee">
                      {fee ? usdFigure(fee) : quoteLoading ? QUOTE_PENDING : "—"}
                    </b>
                  )}
                </div>
                {quoteFailed && (
                  <p
                    className="ww-deposit__note"
                    data-testid="deposit-fee-unavailable"
                    style={{ width: "100%", textAlign: "left" }}
                  >
                    {FEE_UNAVAILABLE_NOTE}
                  </p>
                )}
              </div>
              <div className="ww-deposit__input">
                <span>Deposit address</span>
                {deposit ? (
                  <button
                    type="button"
                    className="zkm-btn-reset ww-deposit__addr"
                    data-testid="deposit-address"
                    disabled={!ready}
                    onClick={copyAddress}
                    title={deposit.address}
                  >
                    {shortAddr(deposit.address)}
                    <Icon name={copied ? "check" : "copy"} size={16} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="zkm-btn-reset zkm-pressable ww-deposit__generate"
                    disabled={generating || busy || fee == null}
                    onClick={resolveAddress}
                  >
                    {generating ? <Spinner size={12} /> : "Generate"}
                  </button>
                )}
              </div>
            </div>

            <div className="ww-deposit__actions">
              <button
                type="button"
                className={["zkm-btn-reset ww-deposit__btn", ready ? "zkm-pressable" : ""]
                  .filter(Boolean)
                  .join(" ")}
                disabled={!ready}
                onClick={showQrCode}
              >
                Show <Icon name="qr-code" size={24} />
              </button>
              <button
                type="button"
                className={["zkm-btn-reset ww-deposit__btn", ready ? "zkm-pressable" : ""]
                  .filter(Boolean)
                  .join(" ")}
                disabled={!ready}
                onClick={copyAddress}
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>

            <p className="ww-deposit__note">
              {generating
                ? STAGE_LABEL[stage ?? "resolving"] ?? "Publishing it to the network"
                : "Each time you open this screen, a new address is created. Use it only once for higher privacy."}
            </p>
          </>
        )}
      </div>

      <div className="ww-deposit__or">
        <hr className="ww-divider" />
        <span>or</span>
        <hr className="ww-divider" />
      </div>

      <button
        type="button"
        className="zkm-btn-reset zkm-pressable ww-deposit__connect"
        disabled={fee == null}
        onClick={() => {
          if (!canFund) {
            setFundOnConnect(true)
            return void l1.connect()
          }
          beginFunding()
        }}
      >
        <span className="ww-deposit__connect-icon">
          <img src={connectIcon} alt="" width={24} height={24} />
        </span>
        <span className="ww-deposit__connect-text">
          <b>
            {canFund
              ? bridgeMode
                ? "Deposit from your browser"
                : "Wallet connected"
              : "Connect your wallet"}
          </b>
          <span>
            {l1.account
              ? shortAddr(l1.account)
              : bridgeMode
              ? "Approve the transfer in your browser"
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

      {fundOpen && deposit && canFund && (
        <DepositFromWalletModal
          l1={l1}
          deposit={deposit}
          token={token}
          fee={fee}
          onClose={() => setFundOpen(false)}
          onSent={(next) => {
            setFundOpen(false)
            setSent(next)
            // The address was spent; the next visit derives a fresh one.
            setDeposit(undefined)
          }}
          onSendFailed={() => setSent(undefined)}
        />
      )}

      {sentRecord && <DepositDetailModal record={sentRecord} onClose={() => setSent(undefined)} />}

      {disclaimer && (
        <DepositPrivacyDisclaimer handle={handle} onClose={() => setDisclaimer(false)} />
      )}

      {warning && (
        <OneTimeAddressWarning
          symbol={token.symbol}
          onClose={() => setWarning(undefined)}
          onGotIt={() => {
            if (warning === "qr") setShowQr(true)
            else if (deposit) void copy(deposit.address)
            setWarning(undefined)
          }}
        />
      )}

      {showQr && deposit && qrToken && (
        <DepositQrSheet
          address={deposit.address}
          paymentUri={buildErc20TransferUriWithoutAmount({
            token: qrToken,
            chainId: l1ChainId,
            to: deposit.address,
          })}
          copied={copied}
          onCopy={() => void copy(deposit.address)}
          onClose={() => setShowQr(false)}
        />
      )}
    </div>
  )
}
