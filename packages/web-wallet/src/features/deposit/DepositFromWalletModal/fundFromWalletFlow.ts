/** The send-from-wallet sheet's flow: Send switches the wallet's chain when it must, then transfers. */
import type { Address, Hex } from "viem"
import type { Pace } from "@obsidion/core/cadence"
import {
  isHoldRefusal,
  memoryStore,
  type DepositAdmission,
  type PortalCapacityStore,
  type ReadonlyStore,
} from "@obsidion/front-core"
import { showReportableError } from "../../../errors/errorModal"
import { amountBucket, failureCode, fireEvent, lapTimer } from "../../../lib/analytics"
import {
  DesktopBridgeUpdateRequiredError,
  DesktopRecheckTimeoutError,
  DesktopSendOpenError,
  DesktopSendUnresolvedError,
} from "../../../platform/desktopBridge"
import { isWalletRejection, type L1Wallet } from "../../../session/l1Wallet"
import {
  WalletPromptOpenError,
  type WalletPrompt,
  type WalletPromptToken,
} from "../../../session/walletPrompt"
import type { ScreenFlow } from "../../../ui/useScreenFlow"
import type { DepositAddress, DepositTarget } from "../../sipa/depositTarget"
import type { DepositTokenOption } from "../../sipa/loadDepositFacts"
import { browserSubmission, holdEnds, type FundDepositParams } from "../fundDeposit"
import { FundingPreflightError, runFundingPreflight, UNKNOWN_CAPACITY } from "../fundingPreflight"
import { InsufficientL1BalanceError, type L1TokenBalance } from "../l1DepositTokenBalance"
import type { SentDeposit } from "./DepositFromWalletModal"
import {
  fundStart,
  fundTransition,
  type FundEvent,
  type FundState,
} from "./fundFromWalletTransition"
import type { FundStart } from "../depositStart"

/** How long a wallet that said it switched chains has to report the new chain. */
export const SWITCH_WAIT_MS = 60_000

/** What one Send transfers, as the latest render has it. */
export interface FundTransfer {
  /** What leaves the wallet, display units, fee included. */
  charged: string
  /** What lands, base units. */
  amountAtomic: bigint
  /** The portal's answer for this amount: a refused one sends nothing. */
  admission: DepositAdmission
}

export interface FundInputs {
  /** Every gate passes, the wallet's chain included. */
  canSubmit: boolean
  /** The send must switch the wallet's chain first. */
  wrongChain: boolean
  transfer?: FundTransfer
  account: Hex | null
  walletName: string | null
  /** The balance read the sheet shows. */
  balance?: L1TokenBalance
  deposit: DepositAddress
  token: DepositTokenOption
  fee?: string
  target?: DepositTarget["kind"]
  payee?: string
  /** Sandbox mints from the token's faucet first. */
  mint: boolean
  /** The row's capacity bucket, once its key is known. */
  capacity?: PortalCapacityStore
  onApproving: (submission: string) => Promise<void>
  onNotApproved: (submission: string) => void
  onSent: (sent: SentDeposit) => void
  onSendFailed: () => void
  onSendUnresolved: () => void
  onFeeChanged?: () => void
  onConfirmed?: () => void
}

export interface FundDeps {
  l1Wallet: Pick<L1Wallet, "view" | "switchNetwork">
  walletPrompt: WalletPrompt
  pace: Pace
  now: () => number
  /** The chain the transfer is sent on. */
  chainId: number
  fundDeposit: (params: FundDepositParams) => Promise<unknown>
  start?: FundStart
  /** The fee the sheet opened with. */
  fee?: string
  report?: typeof showReportableError
}

export interface FundFlow extends ScreenFlow {
  state: ReadonlyStore<FundState>
  review(fee: string | undefined): void
  back(): void
  /** The amount changed: the last send's note goes. */
  typed(): void
  /** Switches the wallet's chain when it must, then transfers. */
  send(): Promise<void>
  /** Back to the review; the transfer the wallet still holds is handled when it answers. */
  cancelPrompt(): void
}

export function openFundFlow(deps: FundDeps, latest: () => FundInputs): FundFlow {
  const { l1Wallet, walletPrompt: prompt, pace, now, chainId } = deps
  const report = deps.report ?? showReportableError
  const state = memoryStore<FundState>(fundStart(deps.start, deps.fee))
  const dispatch = (event: FundEvent) => state.set(fundTransition(state.get(), event))
  let ended = new AbortController().signal

  /** True once the wallet reports `chainId`; false at the deadline or when the sheet goes. */
  const reached = async () => {
    const waiting = new AbortController()
    const check = () => l1Wallet.view.get().chainId === chainId && waiting.abort()
    const off = l1Wallet.view.subscribe(check)
    const quit = () => waiting.abort()
    ended.addEventListener("abort", quit)
    check()
    const deadline = now() + SWITCH_WAIT_MS
    while (!waiting.signal.aborted && now() < deadline)
      await pace.wait(deadline - now(), waiting.signal)
    off()
    ended.removeEventListener("abort", quit)
    return l1Wallet.view.get().chainId === chainId
  }

  const run = async () => {
    const inputs = latest()
    const { canSubmit, transfer, deposit, token, payee, capacity } = inputs
    if (!canSubmit || !transfer || transfer.admission.problem) return
    if (prompt.openElsewhere()) {
      return dispatch({ type: "failed", at: "ready", note: { error: new WalletPromptOpenError() } })
    }
    dispatch({ type: "depositing", from: inputs.account })
    const elapsed = lapTimer()
    // Once the transfer is broadcast the caller owns the UI; this sheet is gone.
    let submitted = false
    let approving: string | undefined
    let request: WalletPromptToken | undefined
    try {
      request = prompt.begin()
      await deps.fundDeposit({
        target: deposit,
        amountDisplay: transfer.charged,
        from: inputs.account ?? undefined,
        walletName: inputs.walletName ?? undefined,
        tokenSymbol: token.symbol,
        token: { address: token.address, decimals: token.decimals, settlesIn: token.settlesIn },
        mint: inputs.mint,
        record: !payee,
        onStage: (stage) => dispatch({ type: "stage", stage }),
        onBrowserSubmit: (url) => dispatch({ type: "browser", url }),
        beforeApprove: (submission) => {
          approving = submission
          return latest().onApproving(submission)
        },
        // A payer's hold is saved before the wallet prompt: the page may close before the hash.
        beforeSend: payee
          ? () => {
              approving = browserSubmission()
              return latest().onApproving(approving)
            }
          : undefined,
        preflight: (fresh) =>
          runFundingPreflight({
            store: capacity,
            required: transfer.admission.required,
            unknownCapacity: UNKNOWN_CAPACITY,
            shownFee: inputs.fee,
            freshFee: inputs.target ? inputs.fee : fresh.feeDisplay,
          }),
        onSubmitted: (txHash) => {
          submitted = true
          prompt.settle(request)
          latest().onSent({
            address: deposit.address,
            txHash,
            amount: transfer.charged,
            tokenSymbol: token.symbol,
            tokenAddress: token.address as Address,
            tokenDecimals: token.decimals,
            walletName: inputs.walletName ?? undefined,
            walletAddress: inputs.account ?? undefined,
          })
        },
      })
      latest().onConfirmed?.()
      fireEvent("deposit_funded", {
        duration_ms: elapsed(),
        funding: "wallet",
        amount_bucket: amountBucket(transfer.amountAtomic, token.decimals),
        ...(inputs.target === "registration" && { registration: true }),
      })
    } catch (e) {
      if (e instanceof WalletPromptOpenError)
        return dispatch({ type: "failed", at: "ready", note: { error: e } })
      if (approving && !submitted && holdEnds(approving, e)) latest().onNotApproved(approving)
      if (!submitted && (prompt.cancelled(request) || isWalletRejection(e)))
        return dispatch({ type: "failed", at: "ready" })
      fireEvent("action_failed", { action: "deposit:send", code: failureCode(e) })
      if (submitted) {
        latest().onSendFailed()
        return report(e, "deposit:confirm")
      }
      if (e instanceof InsufficientL1BalanceError) {
        const shortfall = { balance: e.balance, over: inputs.balance }
        return dispatch({ type: "failed", at: "form", shortfall })
      }
      // Stopped before any transfer: the form shows why.
      if (isHoldRefusal(e)) return dispatch({ type: "failed", at: "form", note: { code: e.code } })
      // Stopped before any transfer: the review shows the new fee.
      if (e instanceof FundingPreflightError && e.reason === "quote-changed") {
        latest().onFeeChanged?.()
        return dispatch({ type: "failed", at: "ready", feeChanged: true })
      }
      // Stopped before any transfer: the form shows the new capacity.
      if (
        e instanceof FundingPreflightError ||
        e instanceof DesktopRecheckTimeoutError ||
        e instanceof DesktopBridgeUpdateRequiredError ||
        e instanceof DesktopSendOpenError
      )
        return dispatch({ type: "failed", at: "form", note: { error: e } })
      if (e instanceof DesktopSendUnresolvedError) return latest().onSendUnresolved()
      dispatch({ type: "failed", at: "ready" })
      report(e, "deposit:send")
    } finally {
      prompt.settle(request)
    }
  }

  return {
    state: state.readonly,
    start(signal) {
      ended = signal
    },
    review: (fee) => dispatch({ type: "review", fee }),
    back: () => dispatch({ type: "back" }),
    typed: () => dispatch({ type: "typed" }),
    async send() {
      if (!latest().wrongChain) return run()
      dispatch({ type: "switching" })
      if (!(await l1Wallet.switchNetwork(chainId)))
        return dispatch({ type: "switchEnded", stuck: false })
      if (ended.aborted) return
      dispatch({ type: "switched" })
      const landed = await reached()
      if (ended.aborted) return
      dispatch({ type: "switchEnded", stuck: !landed })
      if (landed) await run()
    },
    cancelPrompt() {
      prompt.cancel()
      dispatch({ type: "cancelled" })
    },
  }
}
