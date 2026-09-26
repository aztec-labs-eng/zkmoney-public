import { Fr } from "@aztec/aztec.js/fields"
import {
  RequestLinkMintError,
  RequestStorage,
  useAssetContext,
  useAztecContext,
  useContractServiceContext,
  type MintedRequestLink,
} from "@obsidion/front-core"
import {
  ConfirmationSheetDetailRow,
  GradientText,
  Icon,
  PrimaryGradientButton,
  TextField,
} from "@obsidion/web-ds"
import { useState } from "react"
import { showReportableError } from "../../errors/errorModal"
import { decimalInput, usdBalance } from "../../ui/format"
import { Modal } from "../../ui/Modal"
import {
  DEPOSIT_STAGE_LABEL,
  getSipaDepositGateway,
  type DepositStage,
} from "../deposit/sipaGateway"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { useTagPresentationPending } from "../onboarding/webRegistration"
import { createAndStoreRequestLink } from "../requests/requestLinkCreation"
import { parseRequestAmount } from "./receiveView"
import { runUserFlow, useUserFlowActive } from "../provingGate"
import { runOperation } from "../operations/operations"

const MS_PER_DAY = 86_400_000

/** The modal has no expiry control; every link gets the flow's standard window. */
const DEFAULT_EXPIRY_DAYS = 7

// Only the derivation stages are reachable here; "payment" reads better than "deposit" on a link.
const STAGE_LABEL: Record<DepositStage, string> = {
  ...DEPOSIT_STAGE_LABEL,
  resolving: "Deriving your payment address",
}

/**
 * Request-via-paylink modal (ULT-671 flow 1): amount + note form, then a review card whose
 * "Create paylink" mints the link with no proving. The minted link is handed to `onCreated`
 * for the Share step.
 */
export function RequestPaylinkModal({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (minted: MintedRequestLink) => void
}) {
  const identity = loadWalletIdentity()
  const claiming = useTagPresentationPending()
  const { rollupAddress, obsidionWallet } = useAztecContext()
  const { contractService } = useContractServiceContext()
  const { tokenService } = useAssetContext()

  const [step, setStep] = useState<"form" | "review">("form")
  const [amount, setAmount] = useState("")
  const [note, setNote] = useState("")
  const [busy, setBusy] = useState(false)
  const otherFlow = useUserFlowActive() && !busy
  const [stage, setStage] = useState<DepositStage>()
  const [error, setError] = useState<string>()

  // A blank amount is an any-amount link: the payer names the figure. Only a non-empty amount that
  // does not parse blocks.
  const anyAmount = !amount.trim()
  const parsedAmount = anyAmount ? 0 : parseRequestAmount(amount)
  const amountError = !anyAmount && parsedAmount === null ? "Enter an amount above $0." : undefined

  // One list for both the CTA state and the runtime guard, so a new dependency can't be added to
  // only half of them; the bundle is also what narrows the optionals for `create`.
  const deps =
    identity?.handle &&
    !claiming &&
    rollupAddress &&
    tokenService &&
    obsidionWallet &&
    contractService
      ? { handle: identity.handle, rollupAddress, tokenService, obsidionWallet, contractService }
      : null

  const create = async () => {
    if (!deps || parsedAmount === null || busy || otherFlow) return
    setBusy(true)
    setStage(undefined)
    setError(undefined)
    try {
      const token = await deps.tokenService.fetchTokenInformation()
      // The gate covers the derive too, so a refill proof cannot start under it.
      const { address } = await runUserFlow(async () => {
        const next = await getSipaDepositGateway().depositAddress(
          deps.obsidionWallet,
          deps.contractService,
          deps.handle,
          { fresh: true, onStage: setStage },
        )
        // The link is written only once the address is live, so the broadcast's hash is not saved
        // and the operation stays tab-bound until it lands.
        const { publish } = next
        if (publish) {
          const operationId = `request-link_${crypto.randomUUID()}`
          await runOperation({ operationId, flow: "request-link", summary: "Request link" }, () =>
            publish({ operationId }),
          )
        }
        return next
      })
      const minted = await createAndStoreRequestLink(
        {
          requestId: Fr.random().toString(),
          requesterTag: deps.handle,
          requesterAddress: identity?.address,
          tokenAddress: token.address,
          tokenDecimals: token.decimals,
          tokenSymbol: token.symbol,
          networkId: deps.rollupAddress,
          baseUrl: location.origin,
          amountInput: anyAmount ? "" : String(parsedAmount),
          noteInput: note,
          durationMs: DEFAULT_EXPIRY_DAYS * MS_PER_DAY,
          now: Date.now(),
          sipaAddress: address,
        },
        RequestStorage.get(),
      )
      onCreated(minted)
    } catch (cause) {
      const message =
        cause instanceof RequestLinkMintError
          ? "Enter an amount above $0."
          : "The paylink wasn't created — try again."
      setError(message)
      if (!(cause instanceof RequestLinkMintError)) {
        showReportableError(cause, "request-link:create", { message })
      }
    } finally {
      setBusy(false)
      setStage(undefined)
    }
  }

  const createTitle = claiming
    ? "Tag still registering…"
    : otherFlow
    ? "Another transaction in progress…"
    : busy
    ? STAGE_LABEL[stage ?? "resolving"] ?? "Creating paylink"
    : deps
    ? "Create paylink"
    : "Connecting…"

  return (
    <Modal variant="create" label="Request via paylink" onClose={busy ? undefined : onClose}>
      <div className="ww-create-modal__body">
        <div className="ww-create-modal__head">
          <span className="ww-create-modal__badge">
            <Icon name="link" size={32} color="#fff" />
          </span>
          <GradientText size={24} weight={700}>
            Request via paylink
          </GradientText>
        </div>

        {step === "form" ? (
          <>
            <TextField
              label="Amount (optional)"
              placeholder="Any amount"
              inputMode="decimal"
              autoFocus
              value={amount}
              onChange={(v) => setAmount(decimalInput(v))}
              error={amountError}
              onSubmit={() => parsedAmount !== null && setStep("review")}
            />
            <TextField
              label="Add note (optional)"
              placeholder="e.g. pizza dinner"
              value={note}
              onChange={setNote}
            />
            <PrimaryGradientButton
              title="Request funds"
              isDisabled={parsedAmount === null}
              onClick={() => setStep("review")}
            />
          </>
        ) : (
          <>
            <div className="ww-review-card">
              <ConfirmationSheetDetailRow label="Type" value="Receive" />
              <ConfirmationSheetDetailRow
                label="Amount"
                value={anyAmount ? "Any amount" : usdBalance(String(parsedAmount ?? 0))}
              />
              {note.trim() && <ConfirmationSheetDetailRow label="Note" value={note.trim()} />}
            </div>
            {error && <div style={{ color: "var(--accent-pink)", fontSize: 13 }}>{error}</div>}
            {claiming && (
              <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>
                Paylinks become available once your @tag finishes registering.
              </div>
            )}
            <PrimaryGradientButton
              title={createTitle}
              isLoading={busy}
              isDisabled={!deps || busy || otherFlow}
              onClick={() => void create()}
            />
          </>
        )}
      </div>
    </Modal>
  )
}
