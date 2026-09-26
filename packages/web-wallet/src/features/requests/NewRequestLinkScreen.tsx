import { Fr } from "@aztec/aztec.js/fields"
import {
  formatExpiryDuration,
  RequestLinkMintError,
  RequestStorage,
  useAssetContext,
  useAztecContext,
  useContractServiceContext,
  type MintedRequestLink,
} from "@obsidion/front-core"
import {
  AmountChipRow,
  Card,
  ConfirmationSheetDetailRow,
  CopyableLinkRow,
  DoubleCheckIcon,
  Icon,
  PrimaryGradientButton,
  ScreenNavBar,
  TextField,
} from "@obsidion/web-ds"
import { useEffect, useState } from "react"
import { renderSVG } from "uqr"
import { showReportableError } from "../../errors/errorModal"
import { fireEvent, requestAmountBucket } from "../../lib/analytics"
import { decimalInput, parseAmount, requestAmountLabel } from "../../ui/format"
import { requestShareText } from "./shareView"
import { useBack, useLinkSharing } from "../../ui/hooks"
import {
  DEPOSIT_STAGE_LABEL,
  getSipaDepositGateway,
  type DepositStage,
} from "../deposit/sipaGateway"
import { loadWalletIdentity } from "../identity/walletIdentity"
import { useTagPresentationPending } from "../onboarding/webRegistration"
import { useAwaitingDepositRecord } from "../onboarding/RegistrationDepositPrompt"
import { openActivationPrompt } from "../onboarding/activationPrompt"
import { createAndStoreRequestLink } from "./requestLinkCreation"
import { runUserFlow, useUserFlowActive } from "../provingGate"
import { runOperation } from "../operations/operations"

const MS_PER_DAY = 86_400_000

// Only the derivation stages are reachable here; "payment" reads better than "deposit" on a link.
const STAGE_LABEL: Record<DepositStage, string> = {
  ...DEPOSIT_STAGE_LABEL,
  resolving: "Deriving your payment address",
}

/** Create a serverless request link, persist its status row, then offer QR/copy/share. */
export function NewRequestLinkScreen() {
  const back = useBack("/")
  const identity = loadWalletIdentity()
  const claiming = useTagPresentationPending()
  // The link names the tag as payee: a name still waiting for its deposit cannot be paid yet.
  const awaitingActivation = useAwaitingDepositRecord() !== null
  const { rollupAddress, obsidionWallet } = useAztecContext()
  const { contractService } = useContractServiceContext()
  const { tokenService } = useAssetContext()

  const [amount, setAmount] = useState("")
  const [note, setNote] = useState("")
  const [expirationDays, setExpirationDays] = useState("7")
  const [busy, setBusy] = useState(false)
  const otherFlow = useUserFlowActive() && !busy
  const [stage, setStage] = useState<DepositStage>()
  const [error, setError] = useState<string>()
  const [result, setResult] = useState<MintedRequestLink>()
  const { copied, copy, share } = useLinkSharing(
    result?.url,
    "Payment request",
    result ? requestShareText(result.row.amount) : undefined,
  )

  const parsedAmount = amount.trim() ? parseAmount(amount) : 0
  const validAmount = !amount.trim() || (Number.isFinite(parsedAmount) && parsedAmount >= 0)
  const parsedDays = Number(expirationDays)
  const validDays = Number.isInteger(parsedDays) && parsedDays >= 1 && parsedDays <= 365
  // One list for both the CTA state and the runtime guard, so a new dependency can't be added to
  // only half of them; the bundle is also what narrows the optionals for `create`.
  const deps =
    identity?.handle &&
    !claiming &&
    !awaitingActivation &&
    rollupAddress &&
    tokenService &&
    obsidionWallet &&
    contractService
      ? { handle: identity.handle, rollupAddress, tokenService, obsidionWallet, contractService }
      : null
  const ready = !!deps

  // The deps connect async with no failure signal, so "Connecting…" alone is a dead end on a
  // flaky network. Past the timeout the CTA turns into a retry (reload — the contexts expose no
  // reconnect). A registering tag is legitimate waiting, not a stall.
  const [connectTimedOut, setConnectTimedOut] = useState(false)
  useEffect(() => {
    if (ready || claiming || awaitingActivation) {
      setConnectTimedOut(false)
      return
    }
    const timer = setTimeout(() => setConnectTimedOut(true), 15_000)
    return () => clearTimeout(timer)
  }, [ready, claiming, awaitingActivation])
  const showRetry = !ready && !claiming && !awaitingActivation && connectTimedOut

  const create = async () => {
    // Enter in the amount field can fire this while a mint is already deriving a SIPA.
    if (!deps || !validDays || busy || otherFlow) return
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
          amountInput: amount,
          noteInput: note,
          durationMs: parsedDays * MS_PER_DAY,
          now: Date.now(),
          sipaAddress: address,
        },
        RequestStorage.get(),
      )
      setResult(minted)
      fireEvent("request_created", {
        source: "link",
        amount_bucket: requestAmountBucket(minted.row.amount),
      })
    } catch (cause) {
      const message =
        cause instanceof RequestLinkMintError
          ? "Enter a valid amount, or leave it blank for an any-amount link."
          : "The request link wasn't created — try again."
      setError(message)
      if (!(cause instanceof RequestLinkMintError)) {
        showReportableError(cause, "request-link:create", { message })
      }
    } finally {
      setBusy(false)
      setStage(undefined)
    }
  }

  const createTitle = awaitingActivation
    ? "Activate account"
    : claiming
      ? "Tag still registering…"
    : otherFlow
      ? "Another transaction in progress…"
    : busy
      ? (STAGE_LABEL[stage ?? "resolving"] ?? "Creating request link")
      : ready
        ? "Create request link"
        : showRetry
          ? "Retry connection"
          : "Connecting…"

  return (
    <div className="ww-flow">
      <ScreenNavBar title="Request funds by paylink" onLeading={back} />

      {!result && (
        <>
          <Card radius={16} padding={16} style={{ marginTop: 24 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <Icon name="shield-check" size={22} color="var(--accent-cyan)" />
              <div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>Private by default</div>
                <div style={{ color: "var(--text-secondary)", fontSize: 12, marginTop: 2 }}>
                  The request lives in the link. No funds move until someone pays you.
                </div>
              </div>
            </div>
          </Card>

          <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 16 }}>
            <TextField
              label="Amount (optional)"
              placeholder="Any amount"
              inputMode="decimal"
              autoFocus
              value={amount}
              onChange={(v) => setAmount(decimalInput(v))}
              error={validAmount ? undefined : "Enter a valid amount or leave it blank."}
              onSubmit={() => ready && validAmount && validDays && void create()}
            />
            <AmountChipRow
              values={[10, 25, 50]}
              selectedValue={amount.trim() && validAmount ? parsedAmount : undefined}
              onSelect={(value) => setAmount(String(value))}
            />
            <TextField
              label="Note (optional)"
              placeholder="What's this for?"
              value={note}
              onChange={setNote}
            />
            <TextField
              label="Expires after"
              placeholder="7"
              inputMode="numeric"
              value={expirationDays}
              onChange={setExpirationDays}
              trailing={<span style={{ color: "var(--text-secondary)", fontSize: 13 }}>days</span>}
              error={validDays ? undefined : "Choose between 1 and 365 days."}
            />
            <div style={{ display: "flex", gap: 8 }}>
              {[7, 30].map((days) => (
                <button
                  key={days}
                  type="button"
                  className="zkm-btn-reset zkm-pressable"
                  style={{
                    flex: 1,
                    padding: "10px 14px",
                    borderRadius: "var(--radius-12)",
                    color: "var(--text-primary)",
                    background:
                      parsedDays === days ? "var(--gradient-brand)" : "var(--surface-card)",
                  }}
                  onClick={() => setExpirationDays(String(days))}
                >
                  {days} days
                </button>
              ))}
            </div>
            {error && <div style={{ color: "var(--accent-pink)", fontSize: 13 }}>{error}</div>}
            {showRetry && (
              <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>
                Still connecting — check your connection, then retry.
              </div>
            )}
            {awaitingActivation && (
              <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>
                Request links become available once your account is activated.
              </div>
            )}
            {claiming && (
              <div style={{ color: "var(--text-secondary)", fontSize: 13 }}>
                Request links become available once your @tag finishes registering.
              </div>
            )}
          </div>

          <div style={{ marginTop: "auto", padding: "24px 0" }}>
            <PrimaryGradientButton
              title={createTitle}
              isLoading={busy}
              isDisabled={
                awaitingActivation || showRetry
                  ? false
                  : !ready || !validAmount || !validDays || otherFlow
              }
              onClick={() =>
                awaitingActivation
                  ? openActivationPrompt()
                  : showRetry
                    ? location.reload()
                    : void create()
              }
            />
          </div>
        </>
      )}

      {result && (
        <>
          <div style={{ textAlign: "center", padding: "36px 0 20px" }}>
            <DoubleCheckIcon size={40} />
            <h1 style={{ fontSize: 26, fontWeight: 700, margin: "16px 0 4px" }}>
              Request link created
            </h1>
            <div style={{ color: "var(--text-secondary)", fontSize: 14 }}>
              Share this link with anyone you want to request money from.
            </div>
          </div>

          <Card radius={20} padding={16} style={{ alignSelf: "center" }}>
            <div
              aria-label="Payment request QR code"
              style={{ width: 220, height: 220, borderRadius: 12, overflow: "hidden" }}
              dangerouslySetInnerHTML={{ __html: renderSVG(result.url) }}
            />
          </Card>

          <CopyableLinkRow
            url={result.url}
            copied={copied}
            style={{ marginTop: 16 }}
            onCopy={() => void copy()}
          />

          <Card radius={16} padding={16} style={{ marginTop: 16 }}>
            <ConfirmationSheetDetailRow
              label="Amount"
              value={requestAmountLabel(result.row.amount)}
            />
            {result.note && <ConfirmationSheetDetailRow label="Note" value={result.note} />}
            <ConfirmationSheetDetailRow
              label="Expires in"
              value={formatExpiryDuration(parsedDays * MS_PER_DAY)}
            />
          </Card>

          <div
            style={{
              marginTop: "auto",
              padding: "24px 0",
              display: "flex",
              flexDirection: "column",
              gap: 12,
            }}
          >
            <PrimaryGradientButton title="Share link" onClick={() => void share()} />
            <PrimaryGradientButton
              title={copied ? "Copied!" : "Copy link"}
              buttonStyle="dark"
              onClick={() => void copy()}
            />
          </div>
        </>
      )}
    </div>
  )
}
