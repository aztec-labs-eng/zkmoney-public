import { Modal } from "../../ui/Modal"
import { useEffect, useRef, useState, type MutableRefObject } from "react"
import { Link } from "react-router-dom"
import { useDepositAdmission } from "../identity/admission"
import type { Address } from "viem"
import type { RegistrationKind } from "@obsidion/core/types"
import { useAztecContext, useScreener, type PendingRegistrationRecord } from "@obsidion/front-core"
import { readSweepEvents } from "@obsidion/sdk"
import {
  ConfirmationSheetDetailRow,
  StatusBadge,
  TopNavIconButton,
  type StatusBadgeStyle,
} from "@obsidion/web-ds"
import { getConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"
import {
  AddressRow,
  CopyableValue,
  DetectingRow,
  HashRow,
  l1TxUrl,
  whenLabel,
} from "../../ui/detailRows"
import { isDesktopL1SubmitActive } from "../../platform/desktopBridge"
import type { L1ExitStage } from "../deposit/sipaRecovery"
import { isGateCancelled, useCeremonyGate } from "../identity/ceremonyGate"
import { PasskeyRefusal, type RefusalState } from "../identity/PasskeyRefusal"
import { isPasskeyPolicyError, type PasskeyAttemptHandle } from "@obsidion/passkey-web"
import { GateStep } from "../identity/PhoneSteps"
import { reusePasskeyAccount } from "./oxideOnboarding"
import { failureCode, fireEvent } from "../../lib/analytics"
import { passkeyTelemetry } from "../../lib/passkeyTelemetry"
import { canManualRegistrationSweep, manualRegistrationSweep } from "./registrationSweep"
import type { RegistrationTerms, SweepDeductions } from "./registrationTerms"
import { registrationNeedsRefund, useRegistrationRefunded } from "./registrationQuoteRecovery"
import { DepositAddressRow, DepositPayBlock } from "./steps/DepositAddress"
import type { RegistrationFunding } from "./registrationFunding"

/** Where the registration stands once a deposit is at the address, in the feed's words. */
export function registrationDepositStatus(record: PendingRegistrationRecord): {
  label: string
  badge: StatusBadgeStyle
} {
  if (record.phase === "confirmed")
    return { label: "Registered, funds on the way", badge: "pending" }
  if (record.sweptAt !== undefined) return { label: "Confirming on-chain", badge: "pending" }
  if (record.phase === "funded" || record.fundedAt !== undefined) {
    return { label: `Registering @${record.tag}`, badge: "pending" }
  }
  return { label: "Deposit received, waiting for the sweep", badge: "pending" }
}

/** The sweep that emptied the SIPA, read from its own Sweep log when the record never stamped it. */
function useSweepTx(record: PendingRegistrationRecord) {
  const [txHash, setTxHash] = useState<string>()
  const sipa = record.sipaAddress
  const known = record.sweepTxHash
  useEffect(() => {
    if (known) return
    let live = true
    readSweepEvents(l1PublicClient(getConfig()) as never, sipa as never)
      .then((sweeps) => {
        const first = sweeps[0]
        if (live && first) setTxHash(first.txHash)
      })
      .catch((err) => console.warn("sweep read failed", err))
    return () => {
      live = false
    }
  }, [sipa, known])
  return known ?? txHash
}

/**
 * Registration-deposit detail, the registration counterpart of DepositDetailModal: the amount and
 * where the registration stands, over the same facts a deposit shows (funder, funding and sweep
 * transactions with explorer links, the address) plus the terms the claim carried. While the
 * address still needs funds, the pay QR and copyable address render right here.
 */
export function RegistrationDepositDetailModal({
  record,
  terms,
  funding,
  sweepFee,
  deductions,
  amount,
  deposited,
  feeLabel,
  cutLabel,
  pay,
  onClose,
}: {
  record: PendingRegistrationRecord
  terms: RegistrationTerms | null
  /** Undefined while the funding read is out; null when nothing reached the address. The gross row
   *  waits for a value. */
  funding?: RegistrationFunding | null
  /** The relayer's cut on a sweep, and the portal's. Undefined until they are known; the refund
   *  verdict waits on them rather than guessing. */
  sweepFee?: bigint
  deductions?: SweepDeductions
  /** Headline figure, as the feed row shows it: the credit the sweep produces. */
  amount: string
  /** What the sender actually put at the address (gross), when known. */
  deposited?: string
  /** The fee the deposit covers; an earned tag's says the tag price was waived. Absent until the
   *  schedule that prices it is known. */
  feeLabel?: string
  /** Portal cut that funds sponsored gas. */
  cutLabel?: string
  /** Set while the address still needs funds: renders the pay QR + address inline. */
  pay?: {
    token: Address
    chainId: number
    total: bigint
    tokenSymbol: string
    kind?: RegistrationKind
  }
  onClose: () => void
}) {
  const depositAdmitted = useDepositAdmission(record)
  const refunded = useRegistrationRefunded(record)
  const needsRefund = registrationNeedsRefund(
    record,
    terms,
    depositAdmitted || refunded,
    sweepFee,
    deductions?.fpcCut,
  )
  const status = needsRefund
    ? { label: "Refund needed for earned price", badge: "pending" as const }
    : registrationDepositStatus(record)
  const fundingTxHash = record.fundingTxHash ?? funding?.txHash
  const sweepTxHash = useSweepTx(record)
  // The manual sweep's passkey attempt: closing the modal is the user's cancel of it.
  const sweepAttempt = useRef<PasskeyAttemptHandle | undefined>(undefined)
  const close = () => {
    sweepAttempt.current?.userCancelled()
    onClose()
  }
  return (
    <Modal variant="bare" label="Registration deposit details" onClose={close}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 8,
        }}
      >
        <span className="zkm-type-title-md" style={{ color: "var(--text-primary)" }}>
          Registration deposit
        </span>
        <TopNavIconButton icon="x" ariaLabel="Close" onClick={close} />
      </div>
      <div style={{ textAlign: "center", padding: "16px 0 20px" }}>
        <div style={{ fontSize: 36, fontWeight: 700 }}>{amount}</div>
        <div style={{ marginTop: 10, display: "flex", justifyContent: "center" }}>
          <StatusBadge label={status.label} badgeStyle={status.badge} />
        </div>
      </div>
      <ConfirmationSheetDetailRow label="Name" value={`${record.tag}.zk.money`} />
      <ConfirmationSheetDetailRow label="Started" value={whenLabel(record.startTime)} />
      {record.fundedAt !== undefined && (
        <ConfirmationSheetDetailRow label="Deposit seen" value={whenLabel(record.fundedAt)} />
      )}
      {record.sweptAt !== undefined && (
        <ConfirmationSheetDetailRow label="Swept" value={whenLabel(record.sweptAt)} />
      )}
      {deposited === undefined ? (
        <DetectingRow label="Deposited" />
      ) : (
        <ConfirmationSheetDetailRow
          label="Deposited"
          value={<span data-testid="registration-detail-deposited">{deposited}</span>}
        />
      )}
      {feeLabel && (
        <ConfirmationSheetDetailRow
          label="Registration fee"
          value={<span data-testid="registration-detail-fee">{feeLabel}</span>}
        />
      )}
      {cutLabel && (
        <ConfirmationSheetDetailRow
          label="Gas sponsorship"
          value={<span data-testid="registration-detail-cut">{cutLabel}</span>}
        />
      )}
      {terms && terms.deadline > 0 && (
        <ConfirmationSheetDetailRow
          label="Reserved until"
          value={whenLabel(terms.deadline * 1000)}
        />
      )}
      <ConfirmationSheetDetailRow
        label="Deposit address"
        value={<CopyableValue text={record.sipaAddress} />}
      />
      {/* Where the funds came from identifies the deposit, so both rows hold their place
          until the Transfer log read lands. */}
      {funding ? (
        <AddressRow label="Funder" address={funding.from} />
      ) : (
        <DetectingRow label="Funder" />
      )}
      {fundingTxHash ? (
        <HashRow label="Funding transaction" hash={fundingTxHash} url={l1TxUrl(fundingTxHash)} />
      ) : (
        <DetectingRow label="Funding transaction" />
      )}
      {sweepTxHash && (
        <HashRow label="Sweep transaction" hash={sweepTxHash} url={l1TxUrl(sweepTxHash)} />
      )}
      {pay && !depositAdmitted && !needsRefund && (
        <div style={{ marginTop: 16 }}>
          <DepositAddressRow address={record.sipaAddress as Address} kind={pay.kind} />
          <DepositPayBlock
            address={record.sipaAddress as Address}
            token={pay.token}
            chainId={pay.chainId}
            total={pay.total}
          />
        </div>
      )}
      <p className="zkm-type-body-sm" style={{ color: "var(--text-secondary)", marginTop: 12 }}>
        The sweep registers the name and bridges what is left after the fee into this wallet.
      </p>
      {(depositAdmitted || refunded) && record.phase === "awaiting_deposit" && (
        <p className="zkm-type-body-sm" style={{ color: "var(--text-secondary)", marginTop: 12 }}>
          {needsRefund
            ? refunded
              ? "This deposit was recovered. Register again at the earned price."
              : "Your wallet is open. Recover this deposit before registering at the earned price. Do not send more to this address."
            : "Your deposit opened the wallet. Registration is still pending. Do not send another deposit."}{" "}
          <Link to={`/claim/${record.tag}?recovery=1`} onClick={onClose}>
            {needsRefund
              ? refunded
                ? "Register at earned price"
                : "Recover registration deposit"
              : "Check registration status"}
          </Link>
        </p>
      )}
      {!needsRefund && canManualRegistrationSweep(record) && (
        <ManualSweepAction record={record} attempt={sweepAttempt} />
      )}
    </Modal>
  )
}

const SWEEP_STAGE_LABELS: Record<L1ExitStage, string> = {
  "signing": "Waiting for your wallet…",
  "awaiting-browser": "Finish in your browser…",
  "confirming": "Confirming…",
}

/**
 * The small escape hatch: submit the registration sweep yourself instead of waiting for a relayer.
 * One passkey assertion recovers the keys; manual skips the relayer, never the fee.
 */
export function ManualSweepAction({
  record,
  attempt,
}: {
  record: PendingRegistrationRecord
  /** This action's passkey attempt, held where the modal's close can mark it. */
  attempt: MutableRefObject<PasskeyAttemptHandle | undefined>
}) {
  const { obsidionWallet } = useAztecContext()
  const screener = useScreener()
  const { gate, state: gateState, cancel: cancelGate } = useCeremonyGate()
  // Closing the modal is the user's cancel: a sign-in still short of its keys must not go on to
  // sweep, whether it is at a prompt or adopting the key this tab already holds. The close has
  // already marked that cancel; any other removal is only an unmount.
  const op = useRef<AbortController | undefined>(undefined)
  useEffect(
    () => () => {
      attempt.current?.unmounted()
      cancelGate()
      op.current?.abort()
    },
    [attempt, cancelGate],
  )
  const [stage, setStage] = useState<"idle" | "destination" | "passkey" | L1ExitStage>("idle")
  const [destination, setDestination] = useState("")
  const [notice, setNotice] = useState<string>()
  const [error, setError] = useState<string>()
  const [refusal, setRefusal] = useState<RefusalState>()
  const busy = stage !== "idle" && stage !== "destination"

  const run = async () => {
    setError(undefined)
    setNotice(undefined)
    setRefusal(undefined)
    if (isDesktopL1SubmitActive() && stage !== "destination") {
      setStage("destination")
      return
    }
    if (!obsidionWallet) {
      setError("The wallet is still starting. Try again in a moment.")
      return
    }
    try {
      setStage("passkey")
      op.current?.abort()
      op.current = new AbortController()
      const signal = op.current.signal
      const signIn = passkeyTelemetry.begin({ ceremony: "unlock", flow: "deposit" })
      attempt.current = signIn
      const keys = await signIn.run((own) =>
        reusePasskeyAccount(obsidionWallet, record.l2Address, undefined, gate, signal, own),
      )
      const opts = isDesktopL1SubmitActive() ? { destination: destination as Address } : {}
      // The paid address (typed destination or the connected account) is only known once the
      // channel resolves, so it is screened at submit rather than in the form.
      await manualRegistrationSweep(record, {
        keys,
        ...opts,
        screen: (a) => screener.screen(a),
        onStage: setStage,
        onNotice: setNotice,
      })
      setStage("idle")
    } catch (err) {
      setStage("idle")
      if (isGateCancelled(err)) return
      fireEvent("action_failed", { action: "registration_deposit", code: failureCode(err) })
      if (isPasskeyPolicyError(err)) {
        setRefusal({ name: err.name, message: err.message })
        return
      }
      setError(err instanceof Error ? err.message.split("\n")[0] : "The sweep didn't go through.")
    }
  }

  if (gateState.kind === "awaiting-action") {
    return (
      <GateStep
        state={gateState}
        onCancel={() => {
          attempt.current?.userCancelled()
          cancelGate()
        }}
      />
    )
  }

  return (
    <div style={{ marginTop: 10, textAlign: "center" }}>
      {stage === "destination" && (
        <input
          className="ww-manual-sweep__destination"
          placeholder="Ethereum address for the network tip"
          value={destination}
          onChange={(e) => setDestination(e.target.value)}
        />
      )}
      {!refusal && (
        <button
          type="button"
          className="zkm-btn-reset ww-deposit-actions__link"
          data-testid="manual-sweep"
          onClick={() => void run()}
          disabled={busy || (stage === "destination" && !destination)}
        >
          {busy
            ? stage === "passkey"
              ? notice ?? "Confirm your passkey…"
              : SWEEP_STAGE_LABELS[stage as L1ExitStage]
            : "Sweep manually"}
        </button>
      )}
      {refusal && (
        <PasskeyRefusal
          error={refusal}
          onRetry={() => void run()}
          testId="manual-sweep-refused"
          retryTestId="manual-sweep-retry"
        />
      )}
      {error && (
        <p
          className="zkm-type-body-sm"
          data-testid="manual-sweep-error"
          style={{ color: "var(--accent-red, #e5484d)", marginTop: 6 }}
        >
          {error}
        </p>
      )}
    </div>
  )
}
