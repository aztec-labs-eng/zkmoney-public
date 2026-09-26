import { Modal } from "../../ui/Modal"
import { useRef, useState } from "react"
import { formatUnits, parseUnits, type Address } from "viem"
import { DEFAULT_DECIMALS, WITHDRAW_RELAYER_TIP } from "@obsidion/core/constants"
import {
  upsertSavedL1WalletContact,
  useAccountContext,
  useAssetContext,
  useAztecContext,
  useBalance,
  useContractServiceContext,
} from "@obsidion/front-core"
import { isPasskeyCancelled } from "@obsidion/passkey-web"
import { GradientText, Icon, PrimaryGradientButton, TopNavIconButton } from "@obsidion/web-ds"
import { chargedAmount } from "../deposit/DepositFromWalletModal"
import { showReportableError } from "../../errors/errorModal"
import { amountBucket, failureCode, fireEvent, lapTimer } from "../../lib/analytics"
import {
  amountError,
  decimalInput,
  floorToCents,
  parseAmount,
  shortAddr,
  usdFigure,
} from "../../ui/format"
import { useProvingOutcome } from "../../ui/hooks"
import { useUserFlowActive } from "../provingGate"
import { useBusyLabel } from "../operations/operations"
import { OperationHandOff } from "../operations/OperationHandOff"
import { ScreeningNotice, useScreenedAddress } from "../../ui/screening"
import { TeeSignerNotice } from "../../ui/TeeSignerNotice"
import { submitSponsoredWithdrawal, type WithdrawStage } from "./withdrawGateway"
import { getConfig } from "../../config/env"
import {
  FEE_UNAVAILABLE_COPY,
  swapFloorAtomic,
  SwapFeeNote,
  useSwapSimulation,
  WithdrawalEstimate,
  withdrawalFeeDisplay,
} from "./withdrawQuote"
import { withdrawalReceiveAsset, type WithdrawalReceiveAsset } from "./withdrawAssets"
import ethIcon from "../../assets/deposit/ethereum.webp"

const bigIntMax = (a: bigint, b: bigint) => (a > b ? a : b)

/**
 * Amount entry → confirmation → sponsored L2 burn to the given L1 recipient.
 *
 * The passkey ceremony is the last beat needing the user: the modal holds them through the prepare
 * and sign beats, then `OperationHandOff` closes it while the burn carries on under the bell, with
 * no cancel since the burn is away. Cancel is only honoured while
 * the burn is still building; past that the passkey sheet's own dismiss is the way out, and it fails
 * the withdrawal pre-mine. `onDone` fires once per burn: at the hand-off, or when it mines first.
 */
export function WithdrawToWalletModal({
  recipient,
  walletName,
  receiveAsset,
  onClose,
  onDone,
}: {
  recipient: Address
  /** User label for the destination; saved with the contact on success. */
  walletName?: string
  /** Output choice: DAI burns straight to the recipient; anything else routes through oxide's
   *  swap escrow (see `submitSponsoredWithdrawal`). */
  receiveAsset: WithdrawalReceiveAsset
  onClose: () => void
  onDone: () => void
}) {
  const { obsidionWallet } = useAztecContext()
  const { obsidionAccount } = useAccountContext()
  const { tokenService } = useAssetContext()
  const { contractService } = useContractServiceContext()
  const { walletAsset, walletBalance, assetsLoaded } = useBalance()
  const { screener, verdict, cleared, rescreen } = useScreenedAddress(recipient, "withdraw")

  const [phase, setPhase] = useState<"amount" | "confirm" | "working">("amount")
  const [stage, setStage] = useState<WithdrawStage>("building")
  const [amount, setAmount] = useState("")
  const [failedOnce, setFailedOnce] = useState(false)
  const cancelled = useRef(false)
  const left = useRef(false)

  const outcome = useProvingOutcome("withdraw")

  const leave = () => {
    left.current = true
    outcome.finish()
    onDone()
  }

  const symbol = walletAsset?.symbol ?? "zkUSD"
  const parsed = parseAmount(amount)
  const receiveOption = withdrawalReceiveAsset(receiveAsset)
  const tipDisplay = formatUnits(WITHDRAW_RELAYER_TIP, DEFAULT_DECIMALS)
  // A swap simulation nets its own fees off its input, so it is priced on the burn — the typed
  // amount.
  const quoted = chargedAmount(amount, "0", DEFAULT_DECIMALS)
  const quote = useSwapSimulation({
    receiveAsset,
    amountAtomic: quoted !== undefined ? parseUnits(quoted, DEFAULT_DECIMALS) : undefined,
    recipient,
    network: getConfig().network,
  })
  const feeDisplay = withdrawalFeeDisplay(quote)
  // What the recipient loses to the fee on a direct route. A swap escrow takes its remaining fees
  // out of the burn itself, so only the withdrawal relayer tip comes off here.
  const chargeDisplay = receiveOption.direct ? feeDisplay : tipDisplay
  // The typed amount is what leaves the balance, so it is the burn. `charged` is its decimal-safe
  // parse: undefined for anything the burn would reject, which gates the exact-units comparisons
  // below that would otherwise throw on bad input.
  const charged = chargedAmount(amount, "0", DEFAULT_DECIMALS)
  const chargedAtomic = charged !== undefined ? parseUnits(charged, DEFAULT_DECIMALS) : undefined
  // The fee comes out of the burn; the recipient is paid what is left.
  const receivesAtomic =
    chargedAtomic !== undefined && chargeDisplay !== undefined
      ? bigIntMax(chargedAtomic - parseUnits(chargeDisplay, DEFAULT_DECIMALS), 0n)
      : undefined
  const receives =
    receivesAtomic !== undefined ? formatUnits(receivesAtomic, DEFAULT_DECIMALS) : undefined
  // A swap route must leave the escrow something to swap once the tips and the portal's FPC cut come
  // out, or the plan throws at submit. That floor is priced live, off the relayer's simulated gas.
  // A route that cannot be priced has no fee to charge and no tip to commit to, so it never
  // validates.
  const swapMinimumAtomic = receiveOption.direct ? 0n : swapFloorAtomic(quote)
  // The fee comes out of the burn, so a withdrawal at or below it would pay the recipient nothing.
  const chargeAtomic =
    chargeDisplay !== undefined ? parseUnits(chargeDisplay, DEFAULT_DECIMALS) : undefined
  const floorAtomic = bigIntMax(swapMinimumAtomic, chargeAtomic ?? 0n)
  const minimum = Math.max(1, Number(formatUnits(floorAtomic, DEFAULT_DECIMALS)))
  const valid =
    charged !== undefined &&
    chargeAtomic !== undefined &&
    parsed >= 1 &&
    parseUnits(amount, DEFAULT_DECIMALS) > floorAtomic &&
    quote.fee !== undefined
  // The tip the burn commits to is the one on screen: a swap confirms only off a settled simulation.
  const swapCommit =
    !receiveOption.direct && quote.status === "ready" && quote.fee && quote.estimate
      ? { relayerTip: quote.fee.swapRelayerTip, ...quote.estimate }
      : undefined
  const confirmable = receiveOption.direct || swapCommit !== undefined
  // Only a KNOWN shortfall blocks: a balance still loading reads 0 and would flag every amount.
  const overspent =
    assetsLoaded &&
    valid &&
    chargedAtomic !== undefined &&
    chargedAtomic > (walletAsset?.balanceAtomic ?? 0n)
  // The fee comes out of what is typed, so the whole balance can be withdrawn.
  const maxAmount = walletAsset
    ? floorToCents(walletAsset.balanceAtomic, DEFAULT_DECIMALS)
    : undefined
  const ready = !!(obsidionWallet && obsidionAccount && tokenService && contractService)
  const busy = useUserFlowActive()
  const busyLabel = useBusyLabel()
  const destination = walletName ? `${walletName} · ${shortAddr(recipient)}` : shortAddr(recipient)

  const run = async () => {
    if (!valid) return
    if (failedOnce) fireEvent("retry_clicked", { flow: "withdraw" })
    outcome.start("building")
    setPhase("working")
    setStage("building")
    const cancellation = new Error("Cancelled")
    cancelled.current = false
    fireEvent("withdraw_confirmed")
    const elapsed = lapTimer()
    try {
      // The confirm CTA gates on `ready`, so the four context values are present here.
      const record = await submitSponsoredWithdrawal(
        {
          wallet: obsidionWallet!,
          account: obsidionAccount!,
          tokenService: tokenService!,
          contractService: contractService!,
          screener,
        },
        recipient,
        charged,
        (s) => {
          // Only here. `submitting` lands after the burn has mined, and the gateway answers a
          // cancel by dropping the record — past this point that would erase a real withdrawal.
          if (s === "proving" && cancelled.current) throw cancellation
          outcome.updateStage(s)
          setStage(s)
        },
        walletName,
        receiveAsset,
        swapCommit,
      )
      outcome.finish()
      // The sponsored send resolves only after the L2 receipt, so submitted == L2 mined here;
      // duration spans confirm → mine (the prove-phase split rides tx_timing, flow "withdraw").
      if (record.phase !== "submitting") fireEvent("withdraw_submitted", {
        duration_ms: elapsed(),
        amount_bucket: amountBucket(BigInt(Math.floor(parsed)), 0),
      })
      void upsertSavedL1WalletContact({ address: recipient, name: walletName })
      if (!left.current) onDone()
    } catch (e) {
      if (e === cancellation || isPasskeyCancelled(e)) {
        outcome.cancel()
        setPhase("confirm")
        return
      }
      outcome.finish()
      fireEvent("action_failed", { action: "withdraw:submit", code: failureCode(e) })
      if (left.current) return
      showReportableError(e, "withdraw:submit")
      setFailedOnce(true)
      setPhase("confirm")
    }
  }

  // No dismissing mid-burn: the record is already seeded and the proof cannot be abandoned safely.
  const dismiss = () => {
    if (phase !== "working") onClose()
  }

  const breakdown = (
    <div className="ww-deposit__facts">
      {phase === "confirm" && (
        <>
          <div className="ww-deposit__fact">
            <span>To</span>
            <b>{destination}</b>
          </div>
          <div className="ww-deposit__fact">
            <span>Token</span>
            <b>{symbol}</b>
          </div>
          <div className="ww-deposit__fact">
            <span>Network</span>
            <b>
              <img src={ethIcon} alt="" width={16} height={16} />
              Ethereum (ERC20)
            </b>
          </div>
        </>
      )}
      <div className="ww-deposit__fact">
        <span>Receive as</span>
        <b>
          <img src={receiveOption.icon} alt="" width={16} height={16} />
          {receiveOption.symbol}
        </b>
      </div>
      {/* The direct route's "estimate" echoes the burn, which is the gross; its exact net is the
          You receive row below. Only a swapped payout needs an estimate. */}
      {!receiveOption.direct && <WithdrawalEstimate receiveAsset={receiveAsset} state={quote} />}
      <div className="ww-deposit__fact">
        <span>Total withdrawn</span>
        <b>{charged ? usdFigure(charged) : "$--"}</b>
      </div>
      <div className="ww-deposit__fact">
        <span>Fee</span>
        <b>{feeDisplay === undefined ? "$--" : `-${usdFigure(feeDisplay)}`}</b>
      </div>
      {receiveOption.direct ? (
        quote.status === "unavailable" && (
          <p className="ww-withdraw__warning" role="status">
            {FEE_UNAVAILABLE_COPY}
          </p>
        )
      ) : (
        <SwapFeeNote state={quote} amountAtomic={chargedAtomic} />
      )}
      <hr className="ww-divider" />
      {receiveOption.direct && (
        <div className="ww-deposit__fact">
          <span>You receive</span>
          <b>{valid && receives !== undefined ? usdFigure(receives) : "$--"}</b>
        </div>
      )}
    </div>
  )

  return (
    <Modal
      variant="bare"
      label="Withdraw"
      className="ww-deposit-warning ww-fund"
      onClose={phase === "working" ? undefined : onClose}
    >
      {phase !== "working" && (
        <>
          <div className="ww-deposit-warning__close">
            <TopNavIconButton icon="x" ariaLabel="Close" onClick={dismiss} />
          </div>
          <span className="ww-deposit__connect-icon">
            <Icon name="tray-withdraw" size={24} color="#fff" />
          </span>
          <div>
            <GradientText size={24} weight={700}>
              Withdraw
            </GradientText>
            <div className="ww-fund__addr">{destination}</div>
          </div>
          <TeeSignerNotice />
        </>
      )}

      {phase === "amount" && (
        <>
          <div className="ww-fund__fields">
            <span className="ww-fund__label ww-withdraw__amount-label">
              <span>
                Available: <b>${walletBalance}</b>
              </span>
            </span>
            <label className="ww-deposit__input ww-fund__amount">
              <span>
                <input
                  aria-label="Amount"
                  inputMode="decimal"
                  autoFocus
                  data-autofocus
                  placeholder={`Minimum ${usdFigure(String(minimum))}`}
                  value={amount}
                  onChange={(e) => setAmount(decimalInput(e.target.value))}
                />
                <small>${valid ? parsed : 0}</small>
              </span>
              <span className="ww-withdraw__amount-side">
                <button
                  type="button"
                  className="zkm-btn-reset ww-withdraw__paste"
                  onClick={() => maxAmount && setAmount(maxAmount)}
                >
                  MAX
                </button>
                <span className="ww-deposit__pill">{symbol}</span>
              </span>
            </label>
            {overspent && <span className="ww-pay__error">Balance not enough</span>}
            {amountError(amount) && <span className="ww-pay__error">{amountError(amount)}</span>}
            {breakdown}
            {!cleared && (
              <ScreeningNotice
                verdict={verdict}
                checkingCopy="Checking address…"
                blockedFallback="This address can't receive withdrawals."
                errorCopy="Couldn't verify this address."
                onRetry={rescreen}
              />
            )}
          </div>
          <PrimaryGradientButton
            title="Withdraw funds"
            isDisabled={!valid || overspent || !cleared}
            onClick={() => setPhase("confirm")}
            style={{ width: "100%", height: 48 }}
          />
        </>
      )}

      {phase === "confirm" && (
        <>
          <div className="ww-fund__fields">
            {breakdown}
            {/* Reachable when the balance lands after continue — the CTA is dead without this. */}
            {overspent && <span className="ww-pay__error">Balance not enough</span>}
          </div>
          <PrimaryGradientButton
            title={busy ? busyLabel : ready ? "Confirm withdrawal" : "Connecting…"}
            isDisabled={!ready || !valid || overspent || !confirmable || busy}
            onClick={run}
            style={{ width: "100%", height: 48 }}
          />
        </>
      )}

      {phase === "working" && (
        <OperationHandOff
          onLeave={leave}
          onCancel={
            stage === "building"
              ? () => {
                  cancelled.current = true
                }
              : undefined
          }
        />
      )}
    </Modal>
  )
}
