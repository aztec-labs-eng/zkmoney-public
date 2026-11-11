/** The registration pay row's payment: its run, the hold before the wallet prompt, and the saves. */
import { bestEffort, WalletError } from "@obsidion/core/errors"
import { erc20Abi, formatUnits, type Address, type Hex } from "viem"
import type { Config } from "wagmi"
import {
  isHoldRefusal,
  memoryStore,
  registrationAt,
  registrationPayment,
  submissionGone,
  unresolvedSendState,
  type RegistrationPayRun,
  type SubmittedTx,
} from "@obsidion/front-core"
import { l1ChainFor } from "../../../../config/env"
import type { PageFacts } from "../../../../session/pageChain"
import { l1PublicClient } from "../../../../config/oxideTuple"
import { errorCopy } from "../../../../errors/catalog"
import { showErrorModal, showReportableError } from "../../../../errors/errorModal"
import { fmt } from "../../../../lib/fmt"
import {
  getL1Clients,
  isWalletDisconnect,
  isWalletRejection,
  isWrongNetwork,
} from "../../../../session/l1Wallet"
import type { Session } from "../../../../session/session"
import { FundingPreflightError, runFundingPreflight } from "../../../deposit/fundingPreflight"
import { readL1DepositTokenBalance } from "../../../deposit/l1DepositTokenBalance"
import { WalletPromptOpenError } from "../../../../session/walletPrompt"
import type { WalletPromptToken } from "../../../../session/walletPrompt"
import type { DepositTokenOption } from "../../../sipa/loadDepositFacts"
import type { PayTarget } from "./DepositAddress"
import copy from "./DepositAddress.copy"
import { L1_RECEIPT_POLL_MS } from "../../../sipa/l1ExitChannels"

/** The row's own run, the check's refusal, and whether the confirmation is open. */
interface PayState {
  run?: { stage: RegistrationPayRun; hash?: Hex }
  /** The last check refused this payment; nothing was sent. */
  refusal?: string
  confirming: boolean
}

/** What the row's render knows that the flow reads at a command. */
export type PayInputs = PayTarget & {
  account: Address | null
  wagmi: Config
  cleared: boolean
  feeToken: DepositTokenOption
  tokens: DepositTokenOption[]
  pick: DepositTokenOption
}

/** What the flow calls out to: the configured chain, balances, and the connected wallet. */
export const PAY_IO = {
  /** The configured chain's client; a row on another chain refuses. */
  chain(chainId: number, { config }: PageFacts) {
    if (config.l1ChainId !== chainId) throw new WalletError("deposit.switchNetwork")
    return l1PublicClient(config)
  },
  balance: readL1DepositTokenBalance,
  clients: getL1Clients,
}

/**
 * `total` (fee-token base units) in `pick`'s base units, rounded up so a coarser token never
 * underpays. The ask sits above the floor by more than the sweep swap's slippage, so parity holds.
 */
export function pickedAmount(
  total: bigint,
  feeDecimals: number,
  pick: { decimals: number },
): bigint {
  const scale = 10n ** BigInt(Math.max(feeDecimals - pick.decimals, 0))
  return (total + scale - 1n) / scale
}

/** The registration pay row of one mount. A payment outlives the row: its saves land after it goes. */
export function openRegistrationPayFlow(session: Session, latest: () => PayInputs, io = PAY_IO) {
  const state = memoryStore<PayState>({ confirming: false })
  const set = (patch: Partial<PayState>) => state.set({ ...state.get(), ...patch })

  const pay = async () => {
    const i = latest()
    const { address, chainId, total, ask = total, overLimit, funding, account, cleared, pick } = i
    const { run } = state.get()
    const record = registrationAt(session.registrations.view.get().records, address)
    const hold = unresolvedSendState(session.unresolvedSends.view.get())
    const row = registrationPayment(address, record, hold, run?.stage)
    if (row !== "idle" && row !== "check") return
    let hash = row === "check" ? run?.hash ?? record?.submittedFunding?.txHash : undefined
    let saved = hash === record?.submittedFunding?.txHash ? record?.submittedFunding : undefined
    if (!hash && (overLimit || !funding.canFund || !account || !cleared || total <= 0n)) return
    const openElsewhere = session.page.walletPrompt.openElsewhere()
    if (!hash && openElsewhere) {
      set({ refusal: openElsewhere })
      return
    }
    const amount = pickedAmount(total, i.feeToken.decimals, pick)
    let failed = false
    let request: WalletPromptToken | undefined
    const submission = crypto.randomUUID()
    const clearHold = () => session.unresolvedSends.apply({ type: "cleared", only: { submission } })
    set({ refusal: undefined })
    set({ run: { stage: hash ? "confirming" : "checking", hash } })
    try {
      const publicClient = io.chain(chainId, session.page)
      // Replaced or dropped, it never lands; an address holding the ask means a replacement paid it.
      const learned = (tx: SubmittedTx) =>
        bestEffort(
          "unknown",
          session.registrations.apply(address, { type: "fundingSubmitted", tx }),
        )
      if (saved && (await submissionGone(publicClient, saved, learned, Date.now()))) {
        const held = await Promise.all(
          i.tokens.map((t) => io.balance(address, t.address, session.page)),
        )
        if (held.some((b, n) => b.raw >= pickedAmount(ask, i.feeToken.decimals, i.tokens[n]))) {
          set({ run: { stage: "sent", hash } })
          return
        }
        await session.registrations.apply(address, {
          type: "submissionFailed",
          txHash: saved.txHash,
        })
        set({ run: undefined })
        return
      }
      if (!hash) {
        const balance = await io.balance(account!, pick.address, session.page)
        if (balance.raw < amount) {
          set({ run: undefined })
          set({
            refusal: fmt(copy.pay.lowBalance, {
              held: balance.display,
              needed: formatUnits(amount, balance.decimals),
              symbol: balance.symbol,
            }),
          })
          return
        }
        // A new read of the address's own bucket right before the wallet prompt. It reserves nothing.
        const { store, admission } = funding
        if (!store || !admission || admission.problem)
          throw new FundingPreflightError("capacity", copy.capacityUnconfirmed)
        await runFundingPreflight({ store, required: admission.required })
        // Saved before the wallet is asked: after a reload, the wallet may still send it.
        await session.unresolvedSends.apply({
          type: "held",
          send: { address, at: Date.now(), submission },
        })
        request = session.page.walletPrompt.begin()
        set({ run: { stage: "sending" } })
        const { walletClient, account: from, chain } = await io.clients(i.wagmi, chainId, account!)
        hash = await walletClient.writeContract({
          address: pick.address,
          abi: erc20Abi,
          functionName: "transfer",
          args: [address, amount],
          account: from,
          chain,
        })
        session.page.walletPrompt.settle(request)
        const at = Date.now()
        const sent = await bestEffort("unknown", publicClient.getTransaction({ hash }))
        saved = { txHash: hash, at, from: sent?.from, nonce: sent?.nonce }
        // A known hash replaces the hold; if it cannot be saved, the hold stays.
        const event = { type: "fundingSubmitted", tx: saved } as const
        if (await bestEffort("unknown", session.registrations.apply(address, event)))
          void bestEffort("unknown", clearHold())
      }
      set({ run: { stage: "confirming", hash }, confirming: false })
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        pollingInterval: session.page.pace.foreignMs(L1_RECEIPT_POLL_MS),
        onReplaced: ({ reason, transaction }) => {
          hash = transaction.hash
          failed = reason !== "repriced"
        },
      })
      failed ||= receipt.status !== "success"
      if (failed) throw new WalletError("deposit.fundingFailed", hash)
      if (hash !== saved?.txHash) {
        const tx = { at: Date.now(), ...saved, txHash: hash }
        const repriced = { type: "fundingSubmitted", tx } as const
        await bestEffort("unknown", session.registrations.apply(address, repriced))
      }
      set({ run: { stage: "sent", hash } })
    } catch (e) {
      // Nothing was sent under this submission; its hold goes.
      if (!hash) void bestEffort("unknown", clearHold())
      if (failed && saved) {
        const failure = { type: "submissionFailed", txHash: saved.txHash } as const
        void bestEffort("unknown", session.registrations.apply(address, failure))
      }
      // An RPC error or timeout does not prove failure: recheck the same hash, never resend it.
      set({ run: hash && !failed ? { stage: "check", hash } : undefined })
      if (e instanceof WalletPromptOpenError) set({ refusal: e.message })
      else if (session.page.walletPrompt.cancelled(request)) return
      else if (e instanceof FundingPreflightError) set({ refusal: e.message })
      else if (isHoldRefusal(e)) set({ refusal: errorCopy(e) })
      else if (isWalletDisconnect(e)) {
        showErrorModal({
          title: copy.pay.disconnectedTitle,
          message: copy.pay.disconnectedMessage,
        })
      } else if (isWrongNetwork(e)) {
        const network = l1ChainFor(chainId).name
        set({ refusal: fmt(copy.pay.wrongNetwork, { network }) })
      } else if (!isWalletRejection(e)) showReportableError(e, "registration:fund")
    } finally {
      session.page.walletPrompt.settle(request)
    }
  }

  return {
    state: state.readonly,
    start() {},
    pay,
    /** Back to the ask; the address's hold stays until the wallet answers the transfer it holds. */
    cancelPrompt() {
      session.page.walletPrompt.cancel()
      set({ run: undefined, confirming: false })
    },
    confirm: () => set({ confirming: true }),
    closeConfirm: () => set({ refusal: undefined, confirming: false }),
  }
}
