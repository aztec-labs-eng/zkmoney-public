import { Modal } from "../../ui/Modal"
import { useCallback, useEffect, useRef, useState } from "react"
import { formatUnits, getAddress, isAddress, parseUnits, type Address } from "viem"
import { DEFAULT_CONTRACTS, DEFAULT_DECIMALS } from "@obsidion/core/constants"
import type { Fr } from "@aztec/aztec.js/fields"
import type { AddressScreener } from "@obsidion/front-core"
import type { PaylinkL1Proof } from "@obsidion/sdk"
import { isPasskeyCancelled } from "@obsidion/passkey-web"
import { GradientText, Icon, PrimaryGradientButton, TopNavIconButton } from "@obsidion/web-ds"
import connectIcon from "../../assets/deposit/eth-fill.svg"
import ethIcon from "../../assets/deposit/ethereum.webp"
import { getConfig } from "../../config/env"
import { showReportableError } from "../../errors/errorModal"
import { isDesktopL1SubmitActive } from "../../platform/desktopBridge"
import { shortAddr, usdFigure } from "../../ui/format"
import { useProvingOutcome } from "../../ui/hooks"
import { useUserFlowActive } from "../provingGate"
import { ScreeningNotice, useScreenedAddress } from "../../ui/screening"
import { useL1Wallet } from "../deposit/l1Wallet"
import { useSavedL1Wallets, type SavedL1Wallet } from "../withdraw/WithdrawScreen"
import { WithdrawalAssetPicker } from "../withdraw/WithdrawalAssetPicker"
import { withdrawalReceiveAsset, type WithdrawalReceiveAsset } from "../withdraw/withdrawAssets"
import type { SwapCommit, SwapLeg, WithdrawStage } from "../withdraw/withdrawGateway"
import {
  FEE_UNAVAILABLE_COPY,
  swapFloorAtomic,
  useSwapSimulation,
  simulateSwapForTuple,
  type SimulateSwap,
  WithdrawalEstimate,
  withdrawalFeeDisplay,
  type WithdrawalQuoteState,
} from "../withdraw/withdrawQuote"
import { paylinkTuple } from "./paylinkSource"
import { fpcFundingCut } from "../fees/fpcFundingCut"
import { l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import type { PaymentLink } from "./types"
import { emailL1Caller, obtainEmailL1Proof, type EmailClaimStage } from "./emailClaim"
import { useBusyLabel } from "../operations/operations"
import { OperationHandOff } from "../operations/OperationHandOff"

/** What the caller needs to run `claimLinkToL1` once the user confirms. */
export interface ClaimToL1Choice {
  recipient: Address
  screener: AddressScreener
  walletName?: string
  /** DAI burns straight to the recipient; anything else routes through oxide's swap escrow. */
  receiveAsset: WithdrawalReceiveAsset
  /** Confirm-time swap quote, persisted for the detail sheet; absent on the direct route. */
  quote?: SwapCommit
  zkProof?: PaylinkL1Proof
  /** Email swap route: the leg the proof was bound to, planned before verification. */
  swap?: SwapLeg
}

/**
 * Claim a paylink straight to an external Ethereum wallet: the address form (connected wallet,
 * saved, or pasted) with the output asset and the fee breakdown, a review sheet, then the burn. The
 * amount is the whole escrow, so there is no amount step; the fee comes out of it. The passkey
 * ceremony is the last beat needing the user: past it `OperationHandOff` hands the burn to the
 * bell, as in `WithdrawToWalletModal`. A visitor signs no passkey, so theirs hands off once the
 * proof starts.
 *
 * An email link's zkJWT proof binds the executor and the payload paying the burn destination, and on
 * a swap route that is the escrow, whose address the plan fixes. So the swap leg is planned here,
 * before the Google popup, once per address and asset, and the burn pays the fee that plan was
 * quoted on. The binding is hashed ahead of the click too: the popup must open before any await.
 */
export function ClaimToL1Modal({
  link,
  ready,
  onClose,
  onHandOff,
  onConfirm,
  planSwap,
  onClaimInstead,
}: {
  link: PaymentLink
  /** The wallet can sign — the confirm CTA waits on it. */
  ready: boolean
  onClose: () => void
  /**
   * The burn went to the bell: the caller leaves this surface (transfers navigate away; the Home
   * prompt closes).
   */
  onHandOff: () => void
  /** Run the burn; the caller owns the promise so it outlives this modal. Resolves once mined. */
  onConfirm: (choice: ClaimToL1Choice, onStage: (stage: WithdrawStage) => void) => Promise<unknown>
  /** Plan the swap leg an email link binds its proof to, sized off the escrow note's amount. */
  planSwap: (
    recipient: Address,
    receiveAsset: WithdrawalReceiveAsset,
    quote: SwapCommit,
    amount: bigint,
  ) => Promise<SwapLeg | undefined>
  /** The fee-free route: claim into a zk.money account instead. */
  onClaimInstead?: () => void
}) {
  const busy = useUserFlowActive()
  const busyLabel = useBusyLabel()
  const config = getConfig()
  const l1 = useL1Wallet({ expectedChainId: config.l1ChainId, rpcUrl: config.l1RpcUrl })
  const saved = useSavedL1Wallets()
  const [recipient, setRecipient] = useState("")
  const [walletName, setWalletName] = useState("")
  const [receiveAsset, setReceiveAsset] = useState<WithdrawalReceiveAsset>("DAI")
  const [phase, setPhase] = useState<"recipient" | "confirm" | "working">("recipient")
  const [stage, setStage] = useState<WithdrawStage>("building")
  const cancelled = useRef(false)
  const left = useRef(false)
  const submitting = useRef(false)
  const attempt = useRef(0)
  const verifying = useRef(false)
  const emailAbort = useRef<AbortController | null>(null)
  const [emailStage, setEmailStage] = useState<EmailClaimStage>()
  const [emailError, setEmailError] = useState<string>()
  const [zkProof, setZkProof] = useState<PaylinkL1Proof>()
  const planned = useRef(false)
  // Editing the form cancels email verification, but an unchanged destination can retain its plan.
  const planningAttempt = useRef(0)
  const [swapLeg, setSwapLeg] = useState<{
    leg: SwapLeg
    quote: SwapCommit
    display: WithdrawalQuoteState
  }>()
  const [emailCaller, setEmailCaller] = useState<{ payee: Address; caller: Fr }>()
  const isEmail = link.flavor === "email"
  const valid = isAddress(recipient)
  const { screener, verdict, cleared, rescreen } = useScreenedAddress(
    valid ? getAddress(recipient) : null,
    "withdraw",
    { debounceMs: 300 },
  )

  useEffect(() => {
    emailAbort.current?.abort()
    attempt.current++
    planningAttempt.current++
    verifying.current = false
    planned.current = false
    setSwapLeg(undefined)
    setZkProof(undefined)
    setEmailStage(undefined)
    setEmailError(undefined)
    return () => {
      attempt.current++
      planningAttempt.current++
      emailAbort.current?.abort()
    }
  }, [recipient, receiveAsset, link.fragment, config.network, config.nodeUrl, config.l1ChainId])

  const verifyEmail = async () => {
    if (
      !caller ||
      !ready ||
      !confirmable ||
      !valid ||
      !cleared ||
      link.status !== "unclaimed" ||
      !amountAtomic ||
      directFeeUnknown ||
      belowDirectFloor ||
      verifying.current ||
      submitting.current
    )
      return
    const owned = ++attempt.current
    emailAbort.current?.abort()
    const controller = new AbortController()
    emailAbort.current = controller
    const isActive = () => attempt.current === owned
    verifying.current = true
    setEmailError(undefined)
    try {
      const proof = await obtainEmailL1Proof(
        caller,
        {
          paylinkType: DEFAULT_CONTRACTS.paylinkEmail,
          email: link.email,
          commitment: link.commitment,
        },
        (s) => {
          if (isActive()) setEmailStage(s)
        },
        isActive,
        controller.signal,
      )
      if (isActive()) setZkProof(proof)
    } catch (e) {
      if (isActive()) setEmailError(e instanceof Error ? e.message : "Email verification failed")
    } finally {
      if (isActive()) {
        verifying.current = false
        setEmailStage(undefined)
      }
    }
  }

  const outcome = useProvingOutcome("paylink-claim-l1")

  // No amount until the escrow note is read; the burn cannot be priced before then.
  const amountAtomic = link.amount ? parseUnits(link.amount, DEFAULT_DECIMALS) : undefined
  const receiveOption = withdrawalReceiveAsset(receiveAsset)
  const readSource = useCallback(async () => {
    if (!link.tokenAddress) throw new Error("The link token is not available yet")
    return paylinkTuple(link.tokenAddress)
  }, [link.tokenAddress])
  const simulateSourceSwap = useCallback<SimulateSwap>(
    async (args) => simulateSwapForTuple(args, await readSource()),
    [readSource],
  )
  const readSourceCut = useCallback(async () => {
    const tuple = await readSource()
    return fpcFundingCut(l1PublicClient(getConfig()), tuple.portal as Address)
  }, [readSource])
  const quote = useSwapSimulation({
    receiveAsset,
    amountAtomic,
    recipient: valid ? getAddress(recipient) : undefined,
    network: config.network,
    sourceKey: link.tokenAddress ?? "unresolved-paylink",
    simulate: simulateSourceSwap,
    readCut: readSourceCut,
  })
  // A planned leg fixes the escrow the proof binds to, so the sheet keeps showing the quote that
  // leg was planned on; a fresher simulation would show figures the burn does not commit to.
  const displayQuote = swapLeg?.display ?? quote
  const swapMinimumAtomic = swapFloorAtomic(displayQuote)
  const belowSwapFloor =
    !receiveOption.direct && amountAtomic !== undefined && amountAtomic <= swapMinimumAtomic
  const swapCommit =
    !receiveOption.direct && quote.status === "ready" && quote.fee && quote.estimate
      ? { relayerTip: quote.fee.swapRelayerTip, ...quote.estimate }
      : undefined
  const confirmable =
    receiveOption.direct || (isEmail ? swapLeg !== undefined : swapCommit !== undefined)

  // Who the burn pays: the recipient, or the planned escrow on a swap route.
  const emailPayee =
    isEmail && valid
      ? swapLeg?.leg.plan.escrow ?? (receiveOption.direct ? getAddress(recipient) : undefined)
      : undefined
  const caller = emailCaller && emailCaller.payee === emailPayee ? emailCaller.caller : undefined
  useEffect(() => {
    if (!emailPayee) return
    let live = true
    readSource()
      .then((tuple) =>
        emailL1Caller(requireTupleField(tuple, "plainWithdrawalExecutor") as Address, emailPayee),
      )
      .then((hashed) => {
        if (live) setEmailCaller({ payee: emailPayee, caller: hashed })
      })
      .catch((e) => {
        if (live) setEmailError(e instanceof Error ? e.message : "Email verification failed")
      })
    return () => {
      live = false
    }
  }, [emailPayee, readSource])

  // A failed plan stays failed until the address or asset changes: re-planning on every quote
  // refresh would loop on a persistent error.
  useEffect(() => {
    if (!isEmail || receiveOption.direct || !ready || !valid || !cleared || planned.current) return
    if (!swapCommit || belowSwapFloor || amountAtomic === undefined) return
    planned.current = true
    const owned = planningAttempt.current
    const commit = swapCommit
    planSwap(getAddress(recipient), receiveAsset, commit, amountAtomic)
      .then((leg) => {
        if (planningAttempt.current === owned && leg)
          setSwapLeg({ leg, quote: commit, display: quote })
      })
      .catch((e) => {
        if (planningAttempt.current === owned)
          setEmailError(e instanceof Error ? e.message : "Swap unavailable")
      })
  }, [
    isEmail,
    receiveOption.direct,
    ready,
    valid,
    cleared,
    swapCommit,
    quote,
    belowSwapFloor,
    amountAtomic,
    recipient,
    receiveAsset,
    planSwap,
  ])

  const leave = () => {
    left.current = true
    outcome.finish()
    onHandOff()
  }

  const run = async () => {
    if (
      !ready ||
      belowSwapFloor ||
      !confirmable ||
      !valid ||
      !cleared ||
      link.status !== "unclaimed" ||
      !amountAtomic ||
      directFeeUnknown ||
      belowDirectFloor ||
      submitting.current ||
      (isEmail && !zkProof)
    )
      return
    submitting.current = true
    outcome.start("building")
    setPhase("working")
    setStage("building")
    const cancellation = new Error("Cancelled")
    cancelled.current = false
    try {
      await onConfirm(
        {
          recipient: getAddress(recipient),
          screener,
          walletName: name,
          receiveAsset,
          quote: swapLeg?.quote ?? swapCommit,
          zkProof,
          swap: swapLeg?.leg,
        },
        (s) => {
          if (s === "proving" && cancelled.current) throw cancellation
          outcome.updateStage(s)
          setStage(s)
        },
      )
      outcome.finish()
      // A confirm that ran no operation (the claim was already running) has nothing to hand off.
      if (!left.current) onClose()
    } catch (e) {
      // Past the hand-off the caller's own surface reports the failure.
      if (left.current) return
      if (e === cancellation || isPasskeyCancelled(e)) {
        outcome.cancel()
        setPhase("confirm")
        return
      }
      outcome.finish()
      showReportableError(e, "paylink:claim-l1")
      setPhase("confirm")
    } finally {
      submitting.current = false
    }
  }
  // No dismissing mid-burn: the record is already seeded and the proof cannot be abandoned safely.
  const dismiss = () => {
    if (phase !== "working") {
      attempt.current++
      emailAbort.current?.abort()
      setZkProof(undefined)
      onClose()
    }
  }
  const backToForm = () => {
    attempt.current++
    emailAbort.current?.abort()
    verifying.current = false
    setZkProof(undefined)
    setEmailStage(undefined)
    setEmailError(undefined)
    setPhase("recipient")
  }

  const paste = () =>
    navigator.clipboard
      .readText()
      .then((text) => setRecipient(text.trim()))
      .catch(() => {})
  const pick = (w: SavedL1Wallet) => {
    setRecipient(w.address)
    setWalletName(w.name)
  }

  const name = walletName.trim() || undefined
  const destination = valid
    ? name
      ? `${name} · ${shortAddr(recipient)}`
      : shortAddr(recipient)
    : ""

  const directFeeAtomic = receiveOption.direct ? displayQuote.fee?.floorAtomic : undefined
  // The direct route cannot be confirmed before its fee is priced.
  const directFeeUnknown = receiveOption.direct && directFeeAtomic === undefined
  // The direct route's counterpart of `belowSwapFloor`.
  const belowDirectFloor =
    receiveOption.direct &&
    amountAtomic !== undefined &&
    directFeeAtomic !== undefined &&
    amountAtomic <= directFeeAtomic
  // What the direct route pays out.
  const received =
    amountAtomic !== undefined && directFeeAtomic !== undefined && amountAtomic > directFeeAtomic
      ? amountAtomic - directFeeAtomic
      : 0n
  const gross = link.amount ? usdFigure(link.amount) : undefined
  // What the button promises: the direct route's exact payout once its fee is priced, else the link
  // amount (the swap route's output is an estimate in another asset).
  const payout =
    receiveOption.direct && received > 0n ? usdFigure(formatUnits(received, DEFAULT_DECIMALS)) : gross
  const fee = withdrawalFeeDisplay(displayQuote)
  const needsEmailProof = isEmail && !zkProof
  let confirmTitle = payout ? `Confirm and claim ${payout}` : "Confirm and claim"
  // The direct route cannot state a figure before the fee is known; a read that failed for
  // good says so through the fee copy instead of waiting.
  const directFeePending = directFeeUnknown && displayQuote.status !== "unavailable"
  if (!ready || !amountAtomic || directFeePending) confirmTitle = "Connecting…"
  else if (emailStage) confirmTitle = "Verifying email…"
  else if (needsEmailProof) confirmTitle = "Verify email with Google"
  if (busy) confirmTitle = busyLabel

  const facts = (
    <div className="ww-deposit__facts">
      {receiveOption.direct ? (
        <div className="ww-deposit__fact">
          <span>You receive</span>
          <b>
            {amountAtomic && directFeeAtomic !== undefined
              ? usdFigure(formatUnits(received, DEFAULT_DECIMALS))
              : "…"}
          </b>
        </div>
      ) : (
        <WithdrawalEstimate receiveAsset={receiveAsset} state={displayQuote} />
      )}
      {link.memo && (
        <div className="ww-deposit__fact">
          <span>Note</span>
          <b>{link.memo}</b>
        </div>
      )}
      {phase === "confirm" && (
        <div className="ww-deposit__fact">
          <span>To</span>
          <b>{destination}</b>
        </div>
      )}
      {phase === "recipient" ? (
        <WithdrawalAssetPicker label="Token" value={receiveAsset} onChange={setReceiveAsset} />
      ) : (
        <div className="ww-deposit__fact">
          <span>Token</span>
          <b>
            <img src={receiveOption.icon} alt="" width={16} height={16} />
            {receiveOption.symbol}
          </b>
        </div>
      )}
      <div className="ww-deposit__fact">
        <span>Network</span>
        <b>
          <img src={ethIcon} alt="" width={16} height={16} />
          Ethereum
        </b>
      </div>
      <hr className="ww-divider" />
      <div className="ww-deposit__fact">
        <span>Network fee</span>
        <b>{fee ? usdFigure(fee) : "$--"}</b>
      </div>
      {receiveOption.direct && displayQuote.status === "unavailable" && (
        <p className="ww-withdraw__warning" role="status">
          {FEE_UNAVAILABLE_COPY}
        </p>
      )}
    </div>
  )

  return (
    <Modal
      variant="bare"
      label="Claim to an Ethereum wallet"
      className="ww-deposit-warning ww-fund"
      onClose={phase === "working" ? undefined : dismiss}
    >
      {phase !== "working" && (
        <>
          <div className="ww-deposit-warning__close">
            <TopNavIconButton icon="x" ariaLabel="Close" onClick={dismiss} />
          </div>
          <span className="ww-deposit__connect-icon">
            <Icon name="coins" size={24} color="#fff" />
          </span>
          <GradientText size={24} weight={700}>
            {phase === "confirm" ? "Review your claim" : "Claim to an Ethereum wallet"}
          </GradientText>
        </>
      )}

      {phase === "recipient" && (
        <>
          <div className="ww-fund__fields">
            <label className="ww-withdraw__field">
              <span>Claim manually</span>
              <span className="ww-withdraw__box">
                <input
                  placeholder="Paste an address"
                  spellCheck={false}
                  value={recipient}
                  onChange={(e) => {
                    setRecipient(e.target.value)
                    setWalletName("")
                  }}
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
            {facts}
            {belowSwapFloor && (
              <span className="ww-pay__error">
                This link holds too little to cover the swap fees
              </span>
            )}
            {!isDesktopL1SubmitActive() && (
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
                    if (!l1.account) return void l1.connect()
                    setRecipient(l1.account)
                    setWalletName((n) => n || l1.walletName || "")
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
              </>
            )}
            {valid && !cleared && (
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
            title={payout ? `Claim ${payout}` : "Claim"}
            isDisabled={!valid || !cleared}
            onClick={() => setPhase("confirm")}
            style={{ width: "100%", height: 48 }}
          />
          {onClaimInstead && (
            <button
              type="button"
              className="zkm-btn-reset ww-claim-l1__alt"
              onClick={onClaimInstead}
            >
              Claim to zk.money instead. No fee.
            </button>
          )}
        </>
      )}

      {phase === "confirm" && (
        <>
          <div className="ww-fund__fields">
            {facts}
            {belowSwapFloor ? (
              <span className="ww-pay__error">
                This link holds too little to cover the swap fees
              </span>
            ) : (
              <p className="ww-claim-l1__caption">
                Check the address. External claims can't be undone.
              </p>
            )}
          </div>
          {emailStage && (
            <p role="status" aria-live="polite">
              {emailStage === "signing-in"
                ? "Verify your email in the Google window"
                : "Proving your email — this can take a minute"}
            </p>
          )}
          {emailError && <p role="alert">{emailError}</p>}
          {belowDirectFloor && (
            <p role="alert">This link holds too little to cover the withdrawal fee.</p>
          )}
          {isEmail && zkProof && <p role="status">Email verified for this Ethereum address.</p>}
          <PrimaryGradientButton
            title={confirmTitle}
            isDisabled={
              busy ||
              !ready ||
              belowSwapFloor ||
              !confirmable ||
              !cleared ||
              link.status !== "unclaimed" ||
              !!emailStage ||
              (needsEmailProof && !caller) ||
              !amountAtomic ||
              directFeeUnknown ||
              belowDirectFloor
            }
            onClick={needsEmailProof ? verifyEmail : run}
            style={{ width: "100%", height: 48 }}
          />
          <button type="button" className="zkm-btn-reset ww-claim-l1__alt" onClick={backToForm}>
            Cancel
          </button>
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
