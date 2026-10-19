import { useEffect, useState } from "react"
import { useNavigate } from "react-router-dom"
import { getAddress, isAddress, type Address } from "viem"
import {
  Card,
  GradientText,
  Icon,
  NumberedStepRow,
  PrimaryGradientButton,
  TopNavIconButton,
} from "@obsidion/web-ds"
import { fireEvent } from "../../lib/analytics"
import { shortL1Addr } from "../../ui/format"
import { useBack } from "../../ui/hooks"
import { Modal } from "../../ui/Modal"
import { ScreeningNotice, useScreenedAddress } from "../../ui/screening"
import { Warning } from "../../ui/Warning"
import { WithdrawToWalletModal } from "./WithdrawToWalletModal"
import { ETHERFI_VERDICT_COPY, useEtherfiAddressVerdict } from "./etherfiCheck"
import {
  ETHERFI_ASSETS_COPY,
  ETHERFI_CONTACT_NAME,
  ETHERFI_DEFAULT_ASSET,
  ETHERFI_RECEIVE_ASSETS,
  ETHERFI_SHARE_ADDRESS_URL,
  saveEtherfiAddress,
  useSavedEtherfiAddress,
} from "./etherfi"

/** How long the factory read waits before the address reads as unconfirmed. A public RPC can be slow. */
const VERDICT_WAIT_MS = 10_000

const STEPS = [
  "Open ether.fi Cash and go to Add funds, then Crypto, then Share address.",
  "Copy the Ethereum address it shows.",
  "Paste it below. Only USDC or USDT on Ethereum reach your Cash balance.",
] as const

/**
 * Withdrawal to an ether.fi Cash account, as a sheet over the method step: fetch the account's
 * deposit address from ether.fi, paste it, have ether.fi's factory confirm it, keep it for next
 * time, then hand it to `WithdrawToWalletModal` narrowed to the outputs ether.fi credits.
 */
export function WithdrawEtherfiScreen() {
  const navigate = useNavigate()
  const close = useBack("/withdraw")
  const saved = useSavedEtherfiAddress()
  const [query, setQuery] = useState("")
  // Entering a new address over a saved one.
  const [replacing, setReplacing] = useState(false)
  const [keep, setKeep] = useState(true)
  const [chosen, setChosen] = useState<Address>()

  useEffect(() => {
    fireEvent("withdraw_opened", { method: "etherfi" })
  }, [])

  const usingSaved = !!saved && !replacing
  const raw = usingSaved ? saved : query.trim()
  const target = raw && isAddress(raw) ? getAddress(raw) : null
  const screened = useScreenedAddress(target, "withdraw", { debounceMs: 300 })
  const verdict = useEtherfiAddressVerdict(target, VERDICT_WAIT_MS)
  const copy =
    verdict.kind === "confirmed" || verdict.kind === "rejected" || verdict.kind === "unknown"
      ? ETHERFI_VERDICT_COPY[verdict.kind]
      : undefined

  const type = (value: string) => setQuery(value)
  const paste = () =>
    navigator.clipboard
      .readText()
      .then((text) => type(text.trim()))
      .catch(() => {})
  const go = () => {
    if (!target) return
    if (!usingSaved && keep) void saveEtherfiAddress(target, saved ?? undefined)
    setChosen(target)
  }

  if (chosen) {
    return (
      <WithdrawToWalletModal
        recipient={chosen}
        walletName={ETHERFI_CONTACT_NAME}
        receiveAsset={ETHERFI_DEFAULT_ASSET}
        receiveAssets={ETHERFI_RECEIVE_ASSETS}
        assetNote={`ether.fi Cash credits ${ETHERFI_ASSETS_COPY}.`}
        onClose={() => setChosen(undefined)}
        onDone={() => navigate("/")}
      />
    )
  }

  return (
    <Modal
      variant="bare"
      label="Withdraw to ether.fi"
      className="ww-deposit-warning"
      onClose={close}
    >
      <div className="ww-deposit-warning__close">
        <TopNavIconButton icon="x" ariaLabel="Close" onClick={close} />
      </div>
      <div className="ww-sheet__title" style={{ gap: 10 }}>
        <GradientText size={24} weight={700}>
          Withdraw to ether.fi
        </GradientText>
        <small>Funds land in your ether.fi Cash balance. {ETHERFI_ASSETS_COPY} for now.</small>
      </div>
      <div className="ww-fund__fields">
        {saved === undefined ? null : usingSaved ? (
          <Card>
            <div className="ww-withdraw__saved">
              <div className="ww-deposit__actions" style={{ borderRadius: 8 }}>
                <span
                  className="ww-deposit__connect"
                  style={{ flex: 1, paddingBlock: 12, background: "none" }}
                >
                  <span className="ww-deposit__connect-icon" style={{ width: 44, height: 44 }}>
                    <Icon name="bank" size={20} color="#fff" />
                  </span>
                  <span className="ww-deposit__connect-text">
                    <b>{ETHERFI_CONTACT_NAME}</b>
                    <span>{shortL1Addr(saved)}</span>
                  </span>
                </span>
                <button
                  type="button"
                  className="zkm-btn-reset"
                  style={{ paddingRight: 12 }}
                  onClick={() => setReplacing(true)}
                >
                  Change
                </button>
              </div>
            </div>
          </Card>
        ) : (
          <>
            <div className="ww-deposit__fields">
              {STEPS.map((step, i) => (
                <NumberedStepRow key={step} index={i + 1}>
                  {step}
                </NumberedStepRow>
              ))}
            </div>
            <a
              className="zkm-btn-reset zkm-pressable ww-deposit__connect ww-withdraw__howto"
              href={ETHERFI_SHARE_ADDRESS_URL}
              target="_blank"
              rel="noreferrer"
            >
              <span className="ww-deposit__connect-icon">
                <Icon name="bank" size={22} color="#fff" />
              </span>
              <span className="ww-deposit__connect-text">
                <b>Get your ether.fi address</b>
                <span>Opens ether.fi Cash in a new tab</span>
              </span>
              <Icon name="share-box" size={16} color="var(--text-secondary)" />
            </a>
            <label className="ww-withdraw__field">
              <span>ether.fi Cash address</span>
              <span className="ww-withdraw__box">
                <input
                  aria-label="ether.fi Cash address"
                  placeholder="Paste the address from ether.fi"
                  spellCheck={false}
                  data-autofocus
                  value={query}
                  onChange={(e) => type(e.target.value)}
                />
                {query ? (
                  <button
                    type="button"
                    className="zkm-btn-reset ww-withdraw__clear"
                    aria-label="Clear address"
                    onClick={() => type("")}
                  >
                    <Icon name="x" size={12} />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="zkm-btn-reset ww-withdraw__paste"
                    onClick={paste}
                  >
                    Paste <Icon name="copy" size={12} />
                  </button>
                )}
              </span>
            </label>
            {query.trim() && !target && (
              <span className="ww-pay__error">That isn't an Ethereum address.</span>
            )}
            <label className="ww-sheet__fact" style={{ cursor: "pointer" }}>
              <span>Save as my ether.fi address</span>
              <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} />
            </label>
          </>
        )}
        {target && verdict.kind === "checking" && (
          <span className="ww-fund__label">Checking with ether.fi…</span>
        )}
        {copy && (
          <Warning
            title={copy.title}
            tone={copy.tone}
            role={copy.tone === "error" ? "alert" : "status"}
          >
            <p>{copy.body}</p>
          </Warning>
        )}
        {target && !screened.cleared && (
          <ScreeningNotice
            verdict={screened.verdict}
            checkingCopy="Checking address…"
            blockedFallback="This address can't receive withdrawals."
            errorCopy="Couldn't verify this address. Check your internet connection or try another address."
            onRetry={screened.rescreen}
          />
        )}
      </div>
      <PrimaryGradientButton
        title="Continue"
        isDisabled={
          !target || !screened.cleared || verdict.kind === "checking" || verdict.kind === "rejected"
        }
        onClick={go}
        style={{ width: "100%", height: 48 }}
      />
    </Modal>
  )
}
