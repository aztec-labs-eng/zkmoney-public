import { Modal } from "../../ui/Modal"
/**
 * The two exits from a deposit the relayer has not moved, behind one surface: finish the sweep
 * yourself (funds continue into the private balance, the deposit fee comes back) or recover
 * (`recoverERC20` sends them back out to an L1 address). A stuck deposit offers both, sweep first;
 * one no sweep can ever move offers recovery alone.
 *
 * In a browser the connected wallet both pays and is paid; in the desktop launcher there is no
 * injected wallet, so the paid address is typed and the transaction is approved on a helper page in
 * the user's default browser.
 */
import { useEffect, useRef, useState } from "react"
import { isAddress, type Address, type Hex } from "viem"
import { depositAmounts, useAztecContext, type SIPADepositRecord } from "@obsidion/front-core"
import {
  ConfirmationSheetDetailRow,
  DoubleCheckIcon,
  PrimaryGradientButton,
  Spinner,
  TextField,
  TopNavIconButton,
} from "@obsidion/web-ds"
import { getConfig, l1ChainFor } from "../../config/env"
import { showReportableError } from "../../errors/errorModal"
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
import { depositTokensFor } from "./loadDepositFacts"
import { recoverDeposit, type L1ExitStage, type RecoveryReason } from "./sipaRecovery"
import { selfSweep } from "./sipaSweep"
import { unsweepableCopy } from "./unsweepableCopy"

/** Which exit the user is running. */
type ExitAction = "sweep" | "recover"

const STAGE_LABEL: Record<ExitAction, Record<L1ExitStage, string>> = {
  sweep: {
    "signing": "Approve the sweep in your wallet",
    "awaiting-browser": "Approve the sweep in your browser",
    "confirming": "Waiting for L1 confirmation",
  },
  recover: {
    "signing": "Approve the recovery in your wallet",
    "awaiting-browser": "Approve the recovery in your browser",
    "confirming": "Waiting for L1 confirmation",
  },
}

const STUCK_COPY =
  "This deposit still looks sweepable, so a relayer may yet land it in your balance. Recovering races that sweep. If the sweep wins, the recovery stops before signing and nothing is lost."

const SWEEP_COPY =
  "No relayer has picked this deposit up. You can finish it yourself: the funds continue into your private balance, the network tip comes back to your wallet, and you pay only the gas. If a relayer sweeps first this transaction fails harmlessly."

const REGISTRATION_SWEEP_COPY =
  "No relayer has picked this deposit up. You can finish it yourself: the sweep registers your name, what is left after the fee continues into your private balance, and the network tip comes back to your wallet. If a relayer sweeps first this transaction fails harmlessly."

const RECOVER_SECONDARY_COPY = "Or send the funds back out to an Ethereum address instead."

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
  canSweep,
  onClose,
}: {
  record: SIPADepositRecord
  /** The recovery exit's grounds, or null when only the sweep is on offer. */
  reason: RecoveryReason | null
  canSweep: boolean
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
  const [action, setAction] = useState<ExitAction>(canSweep ? "sweep" : "recover")
  const [stage, setStage] = useState<L1ExitStage>()
  const [submitUrl, setSubmitUrl] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [txHash, setTxHash] = useState<Hex>()

  const typedValid = isAddress(destination)
  const target = bridgeMode ? (typedValid ? (destination as Address) : null) : l1.account
  // The paid address — the connected account or the typed destination — is screened like the
  // deposit source and withdrawal recipient are.
  const { verdict, cleared, rescreen } = useScreenedAddress(target, "deposit-exit")
  const gross = depositAmounts(record).grossDisplay
  const amount = `${gross} ${record.tokenSymbol}`
  const ready = !!target && (bridgeMode || !l1.wrongChain) && cleared
  const paidLabel = canSweep ? "Network tip to" : "Recovered to"
  // A deposit a sweep can still land on is waiting; an unsweepable one is in a permanent state.
  const waiting = canSweep || reason === "stuck"

  const submit = async (next: ExitAction) => {
    if (!ready) return
    setAction(next)
    setRefusal(undefined)
    setPhase("working")
    setStage(undefined)
    setNotice(undefined)
    setSubmitUrl(undefined)
    const elapsed = lapTimer()
    const opts = {
      destination: bridgeMode ? (destination as Address) : undefined,
      from: l1.account ?? undefined,
      onHelperOpened: setSubmitUrl,
      onStage: setStage,
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
      if (isGateCancelled(e) || isPasskeyCancelled(e) || isWalletRejection(e)) return
      const scope = next === "sweep" ? "deposit:self-sweep" : "deposit:recover"
      fireEvent("action_failed", { action: scope, code: failureCode(e) })
      if (isPasskeyPolicyError(e)) {
        setRefusal({ name: e.name, message: e.message })
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
    }
  }

  const title =
    phase === "done"
      ? action === "sweep"
        ? "Deposit on its way"
        : "Deposit recovered"
      : canSweep
      ? "Deposit taking too long"
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
          <p style={{ color: "var(--text-secondary)", fontSize: 13, lineHeight: 1.5, margin: 0 }}>
            {canSweep
              ? registration
                ? REGISTRATION_SWEEP_COPY
                : SWEEP_COPY
              : reason === "registration-quote"
              ? "This address uses the old registration price. Recover this deposit to your connected Ethereum wallet, then request a new address at the earned price. Recovery requires ETH for gas. Your zk.money wallet stays open."
              : reason === "unsweepable"
              ? unsweepableCopy(record, depositTokensFor(config.network)[0]?.symbol)
              : STUCK_COPY}
          </p>

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
            <PrimaryGradientButton
              title={l1.connecting ? "Connecting…" : "Connect wallet"}
              isLoading={l1.connecting}
              onClick={l1.connect}
            />
          ) : l1.wrongChain ? (
            <PrimaryGradientButton
              title={l1.connecting ? "Switching…" : `Switch to ${config.l1Chain.name}`}
              buttonStyle="dark"
              isLoading={l1.connecting}
              onClick={l1.switchNetwork}
            />
          ) : null}

          {target && !cleared && (
            <ScreeningNotice
              verdict={verdict}
              checkingCopy="Checking address…"
              blockedFallback="This address can't be used here. Use a different one."
              errorCopy="Couldn't verify this address."
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

          {canSweep && !refusal && (
            <PrimaryGradientButton
              title="Sweep now"
              isDisabled={!ready}
              onClick={() => void submit("sweep")}
            />
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
                isDisabled={!ready}
                onClick={() => void submit("recover")}
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
