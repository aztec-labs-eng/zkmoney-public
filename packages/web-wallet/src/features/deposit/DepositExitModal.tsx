import { Modal } from "../../ui/Modal"
/**
 * The two exits from a deposit the relayer has not moved, behind one surface: finish the sweep
 * yourself (funds continue into the private balance, the deposit fee comes back) or recover
 * (`recoverERC20` / `recoverETH` sends them back out to an L1 address). A stuck deposit offers both, sweep first;
 * one no sweep can ever move offers recovery alone.
 *
 * In a browser the connected wallet both pays and is paid; in the desktop launcher there is no
 * injected wallet, so the paid address is typed and the transaction is approved on a helper page in
 * the user's default browser.
 */
import { useEffect, useRef, useState } from "react"
import { isAddress, type Address, type Hex } from "viem"
import {
  depositAmounts,
  sipaSweepAllowed,
  useAztecContext,
  type SIPADepositRecord,
  type SipaFundingToken,
} from "@obsidion/front-core"
import {
  ConfirmationSheetDetailRow,
  DoubleCheckIcon,
  PrimaryGradientButton,
  Spinner,
  TextField,
  TopNavIconButton,
} from "@obsidion/web-ds"
import { getConfig, l1ChainFor } from "../../config/env"
import { showErrorModal, showReportableError } from "../../errors/errorModal"
import { failureCode, fireEvent, lapTimer } from "../../lib/analytics"
import { passkeyTelemetry } from "../../lib/passkeyTelemetry"
import { isDesktopL1SubmitActive } from "../../platform/desktopBridge"
import { HashRow, l1TxUrl, whenLabel } from "../../ui/detailRows"
import { useCopy } from "../../ui/hooks"
import { ScreeningNotice, useScreenedAddress } from "../../ui/screening"
import { isGateCancelled, useCeremonyGate } from "../identity/ceremonyGate"
import { PasskeyRefusal, type RefusalState } from "../identity/PasskeyRefusal"
import {
  isPasskeyCancelled,
  isPasskeyPolicyError,
  type PasskeyAttemptHandle,
} from "@obsidion/passkey-web"
import { GateStep } from "../identity/PhoneSteps"
import { reusePasskeyAccount } from "../onboarding/oxideOnboarding"
import {
  canManualRegistrationSweep,
  manualRegistrationSweep,
  registrationRecordForSipa,
} from "../onboarding/registrationSweep"
import { isWalletRejection, useL1Wallet } from "./l1Wallet"
import { recoverDeposit, type L1ExitStage, type RecoveryReason } from "./sipaRecovery"
import { AlreadySweptError, selfSweep, SweepRefusedError } from "./sipaSweep"
import { unsweepableCopy } from "./unsweepableCopy"
import {
  useWalletPrompt,
  useWalletPromptStall,
  WalletPromptNote,
  WalletPromptOpenError,
  type WalletPromptToken,
} from "./walletPrompt"
import { DepositProcessingNotice } from "./DepositProcessingNotice"
import { useSipaProcessing } from "./sipaProcessing"
import { heldDepositLine } from "./processingCopy"
import { PendingLimitsLink } from "../limits/AboutLimitsSheet"
import { depositTokensFor } from "./loadDepositFacts"

/** Which exit the user is running. */
type ExitAction = "sweep" | "recover"

const STAGE_LABEL: Record<ExitAction, Record<L1ExitStage, string>> = {
  sweep: {
    "signing": "Approve the sweep in your wallet",
    "awaiting-browser": "Approve the sweep in your browser",
    "confirming": "Waiting for Ethereum confirmation",
  },
  recover: {
    "signing": "Approve the recovery in your wallet",
    "awaiting-browser": "Approve the recovery in your browser",
    "confirming": "Waiting for Ethereum confirmation",
  },
}

const STUCK_COPY =
  "This deposit still looks sweepable, so a relayer may yet land it in your balance. Recovering races that sweep. If the sweep wins, the recovery stops before signing and nothing is lost."

const SWEEP_SUMMARY = "No relayer has picked this deposit up."

export const SELF_SWEEP_PRIVACY =
  "Sweeping it yourself is less private: it publicly links your Ethereum wallet to this deposit."

const SWEEP_GAS =
  "You pay its Ethereum network fee in ETH; your wallet shows the amount before you approve."

const SWEEP_SHARED =
  "It draws on the same shared network capacity as any other deposit, so it can't go through while capacity is insufficient. If a relayer sweeps first, your transaction fails and the deposit is unaffected."

const SWEEP_DETAIL = `"Sweep now" sends it on from your Ethereum wallet, the same transaction a relayer would send: the funds continue into your private balance and the deposit fee comes back to your wallet as the network tip. ${SWEEP_SHARED}`

const REGISTRATION_SWEEP_DETAIL = `"Sweep now" sends it on from your Ethereum wallet: it registers your name, what is left after the fee continues into your private balance, and the network tip comes back to your wallet. ${SWEEP_SHARED}`

const RECOVER_SECONDARY_COPY = "Or send the funds back out to an Ethereum address instead."

const STRANDED_COPY =
  "Recovery sends this token, and any deposit token still at the address, out to an Ethereum address. It requires ETH for gas."

const UNSWEEPABLE_RECOVER_COPY =
  "Recovery sends the funds back out to an Ethereum address. It requires ETH for gas."

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

/** How long the deposit has been waiting: "12m" under the hour, "3h 05m" over it. */
export function waitedLabel(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000))
  const hours = Math.floor(minutes / 60)
  return hours ? `${hours}h ${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`
}

export function DepositExitModal({
  record,
  reason,
  canSweep: offered,
  sweepable = false,
  stranded,
  onClose,
}: {
  record: SIPADepositRecord
  /** The recovery exit's grounds, or null when only the sweep is on offer. */
  reason: RecoveryReason | null
  /** Whether the sheet opens with the sweep on offer. */
  canSweep: boolean
  /** A sweep could land but for capacity: a recovery sheet offers it once a read clears that. */
  sweepable?: boolean
  /** A token named in Settings, with its balance at the address; the sheet recovers it. */
  stranded?: { token: SipaFundingToken; balance: string }
  onClose: () => void
}) {
  const config = getConfig()
  const bridgeMode = isDesktopL1SubmitActive()
  const l1 = useL1Wallet({ expectedChainId: config.l1ChainId, rpcUrl: config.l1RpcUrl })
  const { obsidionWallet } = useAztecContext()
  const { copied, copy } = useCopy()
  // Routes the sweep action; see registrationRecordForSipa for why registration SIPAs differ.
  const registration = registrationRecordForSipa(record.sipaAddress)

  const [destination, setDestination] = useState("")
  const [phase, setPhase] = useState<"form" | "working" | "done">("form")
  const { gate, state: gateState, cancel: cancelGate } = useCeremonyGate()
  // Leaving the sheet ends a registration sign-in wherever it is, prompt or held key, before it
  // sweeps, and closes the passkey attempt it was reported as.
  const attemptRef = useRef<PasskeyAttemptHandle | undefined>(undefined)
  const op = useRef<AbortController | undefined>(undefined)
  useEffect(
    () => () => {
      attemptRef.current?.unmounted()
      cancelGate()
      op.current?.abort()
    },
    [cancelGate],
  )
  const [refusal, setRefusal] = useState<RefusalState>()
  const [action, setAction] = useState<ExitAction>(offered ? "sweep" : "recover")
  const [stage, setStage] = useState<L1ExitStage>()
  const [submitUrl, setSubmitUrl] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [txHash, setTxHash] = useState<Hex>()
  const [refused, setRefused] = useState<string>()
  const [nudged, setNudged] = useState(false)
  const prompt = useWalletPrompt()
  const stalled = useWalletPromptStall(phase === "working" && stage === "signing")
  // Back to the form; the transaction the wallet still holds is handled when it answers.
  const cancelPrompt = () => {
    prompt.cancel()
    setStage(undefined)
    setPhase("form")
  }
  const {
    state: processingState,
    shown: processing,
    capacityKey,
  } = useSipaProcessing(record.sipaAddress)
  // Capacity gates the sweep live; recovery never waits on it.
  const sweepBlocked = !sipaSweepAllowed(processingState)
  // Only a live state with no blocker counts; a swept or settled deposit has no state at all.
  const sweepCleared = sweepable && processingState !== undefined && !sweepBlocked
  const recoveryStarted = useRef(false)
  const [revealed, setRevealed] = useState(false)
  useEffect(() => {
    if (sweepCleared && phase === "form" && !recoveryStarted.current) setRevealed(true)
  }, [sweepCleared, phase])
  const canSweep = offered || revealed

  const typedValid = isAddress(destination)
  const target = bridgeMode ? (typedValid ? (destination as Address) : null) : l1.account
  // The paid address — the connected account or the typed destination — is screened like the
  // deposit source and withdrawal recipient are.
  const { verdict, cleared, rescreen } = useScreenedAddress(target, "deposit-exit")
  const gross = depositAmounts(record).grossDisplay
  const amount = stranded
    ? `${stranded.balance} ${stranded.token.symbol}`
    : `${gross} ${record.tokenSymbol}`
  const ready = !!target && (bridgeMode || !l1.wrongChain) && cleared
  // Held only for the wallet: the exits look disabled but a click says what to do first.
  const needsWallet = !bridgeMode && (!l1.account || l1.wrongChain)
  const heldClass = needsWallet ? "zkm-primary-btn--disabled" : undefined
  const press = (next: ExitAction) => (needsWallet ? setNudged(true) : void submit(next))
  const paidLabel = canSweep ? "Network tip to" : "Recovered to"
  // A deposit a sweep can still land on is waiting; an unsweepable one is in a permanent state.
  const waiting = canSweep || reason === "stuck"
  // The notice says no sweep can move it; the stuck copy says one may yet land.
  const permanent =
    processingState?.blocker?.kind === "ceiling" ||
    processingState?.blocker?.kind === "operation-cap"

  // Names the buttons a missing or mis-chained wallet holds disabled.
  const heldExits =
    canSweep && reason
      ? '"Sweep now" and "Recover to an Ethereum address" are'
      : canSweep
      ? '"Sweep now" is'
      : '"Recover" is'

  const submit = async (next: ExitAction) => {
    if (!ready) return
    if (prompt.openElsewhere) {
      setRefused(prompt.openElsewhere)
      return
    }
    if (next === "recover") recoveryStarted.current = true
    setAction(next)
    setRefusal(undefined)
    setRefused(undefined)
    setPhase("working")
    setStage(undefined)
    setNotice(undefined)
    setSubmitUrl(undefined)
    const elapsed = lapTimer()
    let request: WalletPromptToken | undefined
    const opts = {
      destination: bridgeMode ? (destination as Address) : undefined,
      from: l1.account ?? undefined,
      onHelperOpened: setSubmitUrl,
      // Confirming means the wallet answered; the slot frees before the receipt lands.
      onStage: (next: L1ExitStage) => {
        setStage(next)
        if (next === "confirming") prompt.settle(request)
      },
      stranded: stranded?.token,
    }
    // One passkey assertion recovers the keys the registration sweep re-derives and signs with.
    // The registration is re-read at submit: the detection tick can settle it (swept, failed_taken)
    // while the sheet is open, and a stale record would sign a doomed sweep.
    const runRegistrationSweep = async () => {
      if (!obsidionWallet) throw new Error("The wallet is still starting. Try again in a moment.")
      const reg = registrationRecordForSipa(record.sipaAddress)
      if (!reg || !canManualRegistrationSweep(reg)) {
        throw new Error(
          "This deposit's registration has moved on, so the sweep was stopped before signing. Close and reopen the deposit for its current options.",
        )
      }
      op.current?.abort()
      op.current = new AbortController()
      const signal = op.current.signal
      const signIn = passkeyTelemetry.begin({ ceremony: "unlock", flow: "deposit" })
      attemptRef.current = signIn
      const keys = await signIn.run((own) =>
        reusePasskeyAccount(obsidionWallet, reg.l2Address, undefined, gate, signal, own),
      )
      return manualRegistrationSweep(reg, { keys, ...opts, onNotice: setNotice })
    }
    try {
      request = prompt.begin()
      const hash =
        next === "recover"
          ? await recoverDeposit(record, opts)
          : registration
          ? await runRegistrationSweep()
          : await selfSweep(record, opts)
      setTxHash(hash)
      setPhase("done")
      // Reason and timing only — the paid address is as identifying as the deposit address.
      if (next === "sweep")
        fireEvent("deposit_self_swept", {
          duration_ms: elapsed(),
          reason: registration ? "registration" : "stuck",
        })
      else fireEvent("deposit_recovered", { duration_ms: elapsed(), reason: reason ?? "stuck" })
    } catch (e) {
      setPhase("form")
      if (e instanceof WalletPromptOpenError) {
        setRefused(e.message)
        return
      }
      if (prompt.cancelled(request)) return
      if (isGateCancelled(e) || isPasskeyCancelled(e) || isWalletRejection(e)) return
      const scope = next === "sweep" ? "deposit:self-sweep" : "deposit:recover"
      fireEvent("action_failed", { action: scope, code: failureCode(e) })
      if (isPasskeyPolicyError(e)) {
        setRefusal({ name: e.name, message: e.message })
        return
      }
      if (e instanceof SweepRefusedError) {
        setRefused(e.message)
        return
      }
      if (e instanceof AlreadySweptError) {
        onClose()
        showErrorModal({ title: "Deposit already swept", message: e.message })
        return
      }
      showReportableError(
        e,
        next === "sweep"
          ? registration
            ? "registration:sweep"
            : "deposit:sweep"
          : "deposit:recovery",
        {
          title: next === "sweep" ? "Sweep failed" : "Recovery failed",
        },
      )
    } finally {
      prompt.settle(request)
    }
  }

  const title =
    phase === "done"
      ? action === "sweep"
        ? "Deposit on its way"
        : "Deposit recovered"
      : canSweep
      ? "Deposit taking too long"
      : stranded
      ? `Recover ${stranded.token.symbol}`
      : "Recover deposit"

  return (
    <Modal
      variant="bare"
      label="Deposit recovery"
      onClose={phase === "working" ? undefined : onClose}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <span className="zkm-type-title-sm" style={{ color: "var(--text-primary)" }}>
          {title}
        </span>
        {phase !== "working" && <TopNavIconButton icon="x" ariaLabel="Close" onClick={onClose} />}
      </div>

      {phase === "form" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {refusal && (
            <PasskeyRefusal
              error={refusal}
              onRetry={() => void submit(action)}
              testId="deposit-refused"
              retryTestId="deposit-retry"
            />
          )}
          {processing && (
            <DepositProcessingNotice
              sipaAddress={record.sipaAddress}
              state={processing}
              symbol={depositTokensFor(config.network)[0]?.symbol ?? record.tokenSymbol}
              help={(detail) => (
                <PendingLimitsLink
                  sipaAddress={record.sipaAddress}
                  capacityKey={capacityKey}
                  settlementSymbol={
                    depositTokensFor(config.network)[0]?.symbol ?? record.tokenSymbol
                  }
                  detail={detail}
                />
              )}
            />
          )}
          <p style={{ color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.5, margin: 0 }}>
            {canSweep
              ? sweepBlocked
                ? SWEEP_SUMMARY
                : `${SWEEP_SUMMARY} You can sweep it yourself. ${SELF_SWEEP_PRIVACY}`
              : reason === "registration-quote"
              ? "This address uses the old registration price. Recover this deposit to your connected Ethereum wallet, then request a new address at the earned price. Recovery requires ETH for gas. Your zk.money wallet stays open."
              : reason === "unsweepable"
              ? unsweepableCopy(record)
              : stranded
              ? STRANDED_COPY
              : permanent
              ? UNSWEEPABLE_RECOVER_COPY
              : STUCK_COPY}
          </p>
          {canSweep && (
            <details className="ww-exit-more" data-testid="sweep-details">
              <summary>How "Sweep now" works</summary>
              <p>{registration ? REGISTRATION_SWEEP_DETAIL : SWEEP_DETAIL}</p>
            </details>
          )}

          {bridgeMode ? (
            <>
              <TextField
                label="Ethereum address"
                placeholder="0x…"
                autoFocus
                className="ww-autofocus"
                value={destination}
                onChange={setDestination}
                error={
                  destination && !typedValid ? "That isn't a valid Ethereum address" : undefined
                }
              />
              <span style={{ color: "var(--text-secondary)", fontSize: 12 }}>
                {canSweep
                  ? "This address receives the network tip, and the funds themselves if you recover instead. Anyone can submit the transaction, but only this address is paid, so check it carefully."
                  : "The funds will be sent to this address. Anyone can submit the transaction, but only this address receives the deposit, so check it carefully."}
              </span>
            </>
          ) : !l1.account ? (
            <>
              <PrimaryGradientButton
                title={l1.connecting ? "Connecting…" : "Connect wallet"}
                isLoading={l1.connecting}
                onClick={l1.connect}
              />
              <span
                style={{ color: "var(--text-secondary)", fontSize: 12 }}
                data-testid="exit-needs-wallet"
              >
                {heldExits} off until you connect an Ethereum wallet.
              </span>
            </>
          ) : l1.wrongChain ? (
            <>
              <PrimaryGradientButton
                title={l1.connecting ? "Switching…" : `Switch to ${config.l1Chain.name}`}
                buttonStyle="dark"
                isLoading={l1.connecting}
                onClick={l1.switchNetwork}
              />
              <span
                style={{ color: "var(--text-secondary)", fontSize: 12 }}
                data-testid="exit-needs-wallet"
              >
                {heldExits} off until you switch your wallet to {config.l1Chain.name}.
              </span>
            </>
          ) : null}

          {target && !cleared && (
            <ScreeningNotice
              verdict={verdict}
              checkingCopy="Checking address…"
              blockedFallback="This address can't be used here. Use a different one."
              errorCopy={
                bridgeMode
                  ? "Couldn't verify this address. Check your internet connection or try another address."
                  : "Couldn't verify this address. Check your internet connection or try another wallet."
              }
              onRetry={rescreen}
            />
          )}

          <div>
            <ConfirmationSheetDetailRow label="Amount" value={amount} />
            {waiting && (
              <>
                <ConfirmationSheetDetailRow label="Started" value={whenLabel(record.startTime)} />
                <ConfirmationSheetDetailRow
                  label="Waiting"
                  value={waitedLabel(Date.now() - record.startTime)}
                />
              </>
            )}
            <ConfirmationSheetDetailRow label="Deposit address" value={short(record.sipaAddress)} />
            <ConfirmationSheetDetailRow label={paidLabel} value={target ? short(target) : "—"} />
            <ConfirmationSheetDetailRow label="Network" value={l1ChainFor(config.l1ChainId).name} />
          </div>

          {nudged && needsWallet && (
            <p
              role="alert"
              className="ww-sheet__note"
              style={{ textAlign: "center" }}
              data-testid="exit-connect-first"
            >
              {l1.account
                ? `Switch your wallet to ${config.l1Chain.name} first.`
                : "Connect wallet first."}
            </p>
          )}
          {refused && (
            <p role="alert" className="ww-sheet__note" data-testid="deposit-sweep-refused">
              {refused}
            </p>
          )}
          {canSweep && !refusal && (
            <>
              <PrimaryGradientButton
                title="Sweep now"
                isDisabled={(!ready && !needsWallet) || sweepBlocked}
                className={heldClass}
                onClick={() => press("sweep")}
              />
              {sweepBlocked && (
                <p className="ww-exit-held" data-testid="sweep-held">
                  {heldDepositLine(processingState)}
                </p>
              )}
              <p className="ww-exit-gas" data-testid="sweep-gas">
                {SWEEP_GAS}
              </p>
            </>
          )}
          {reason && (
            <>
              {canSweep && (
                <p
                  style={{
                    color: "var(--text-secondary)",
                    fontSize: 13,
                    lineHeight: 1.5,
                    margin: 0,
                  }}
                >
                  {RECOVER_SECONDARY_COPY}
                </p>
              )}
              <PrimaryGradientButton
                title={
                  canSweep
                    ? "Recover to an Ethereum address"
                    : target
                    ? `Recover to ${short(target)}`
                    : "Recover"
                }
                buttonStyle={canSweep ? "dark" : undefined}
                isDisabled={!ready && !needsWallet}
                className={heldClass}
                onClick={() => press("recover")}
              />
            </>
          )}
        </div>
      )}

      {phase === "working" && gateState.kind === "awaiting-action" && (
        <GateStep
          state={gateState}
          onCancel={() => {
            attemptRef.current?.userCancelled()
            cancelGate()
          }}
        />
      )}
      {phase === "working" && gateState.kind !== "awaiting-action" && (
        <div style={{ padding: "24px 0" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Spinner size={20} />
            <span style={{ fontSize: 15 }}>
              {stage ? STAGE_LABEL[action][stage] : notice ?? "Preparing…"}
            </span>
          </div>
          {stalled && <WalletPromptNote walletName={l1.walletName} onCancel={cancelPrompt} />}
          {stage === "awaiting-browser" && submitUrl && (
            <p
              style={{
                color: "var(--text-secondary)",
                fontSize: 13,
                lineHeight: 1.5,
                margin: "12px 0 0 32px",
              }}
            >
              A page opened in your regular browser at{" "}
              <span style={{ fontFamily: "monospace" }}>{submitUrl}</span>. If nothing appeared,{" "}
              <span
                role="button"
                onClick={() => copy(submitUrl)}
                style={{ color: "var(--accent-green, #6c9)", cursor: "pointer" }}
              >
                {copied ? "copied" : "copy link"}
              </span>{" "}
              and open it there yourself.
            </p>
          )}
        </div>
      )}

      {phase === "done" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div style={{ textAlign: "center", padding: "16px 0 0" }}>
            <DoubleCheckIcon size={40} />
            <p
              style={{
                color: "var(--text-secondary)",
                fontSize: 14,
                lineHeight: 1.45,
                margin: "12px 0 0",
              }}
            >
              {action === "sweep"
                ? registration
                  ? `Your name is registering, and what is left of ${amount} after the fee is on its way into your private balance.`
                  : `${amount} is on its way into your private balance. It should arrive within a few minutes.`
                : `${amount} sent to ${target ? short(target) : "your wallet"}.`}
            </p>
          </div>
          {txHash && <HashRow label="Transaction ID" hash={txHash} url={l1TxUrl(txHash)} />}
          <PrimaryGradientButton title="Done" onClick={onClose} />
        </div>
      )}
    </Modal>
  )
}
