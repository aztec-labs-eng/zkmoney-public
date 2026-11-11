/**
 * A self-initiated deposit: a transfer from the connected L1 wallet to an address the caller is
 * already showing, and the one writer of `fundingSent`. The deposit lands in the L2 balance through
 * the SIPA pipeline.
 */
import type { Pace } from "@obsidion/core/cadence"
import {
  encodeFunctionData,
  erc20Abi,
  formatUnits,
  parseAbi,
  parseUnits,
  type Address,
  type Hex,
  type PublicClient,
} from "viem"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { WalletError, type SipaDeposit, type SipaDeposits } from "@obsidion/front-core"
import { l1ChainFor, type WebWalletConfig } from "../../config/env"
import { requireTupleField } from "../../config/oxideTuple"
import {
  DesktopSendUnresolvedError,
  type submitViaDesktopBridge,
} from "../../platform/desktopBridge"
import { isWalletRejection, type getL1Clients } from "../../session/l1Wallet"
import { InsufficientL1BalanceError, type L1TokenBalance } from "./l1DepositTokenBalance"
import type { DepositDisplayFacts, DepositTokenOption } from "../sipa/loadDepositFacts"
import type { DepositStage } from "./sipaAddresses"
import type { DepositAddress } from "../sipa/depositTarget"
import { L1_RECEIPT_POLL_MS } from "../sipa/l1ExitChannels"

/** The sandbox token's open mint (faucet convenience; a real sender already holds funds). */
const SANDBOX_MINT_ABI = parseAbi(["function mint(address to, uint256 amount)"])

/**
 * Why a send cannot be swept, or undefined when it can. Below the quoted fee nothing is left to
 * credit and the sweep itself hard-reverts, stranding the funds; above the cap the portal refuses
 * what it would take in. `amount` and `fee` must be in the same token's units, which `decimals` and
 * `symbol` name; `txAmountCap` is the row portal's, in `capDecimals`, the row token's.
 */
export function depositWindowError(
  amount: bigint,
  fee: bigint,
  decimals: number,
  symbol: string,
  txAmountCap: bigint,
  capDecimals: number,
): WalletError | undefined {
  if (amount <= fee)
    return new WalletError("deposit.belowFee", undefined, {
      data: { fee: formatUnits(fee, decimals), symbol },
    })
  const capDisplay = formatUnits(txAmountCap, capDecimals)
  if (amount - fee > parseUnits(capDisplay, decimals)) return new WalletError("deposit.overCap")
  return undefined
}

/** What the self-initiated funding path knows about the transfer it just made. */
export type FundingStamp = Pick<SipaDeposit, "fundingTxHash" | "walletName" | "walletAddress"> &
  Partial<Pick<SipaDeposit, "tokenSymbol">> & {
    fundingTxHash: Hex
  }

/** A mined-but-reverted transfer funded nothing; it must never be stamped as a deposit. */
async function confirmed(
  publicClient: Pick<PublicClient, "waitForTransactionReceipt">,
  hash: Hex,
  pollingInterval: number,
): Promise<void> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval })
  if (receipt.status !== "success")
    throw new WalletError("deposit.fundingReverted", undefined, { data: { hash } })
}

export interface FundDepositParams {
  target: DepositAddress
  amountDisplay: string
  from?: Hex
  /** Connected wallet's display name, stamped on the record for the detail sheet. */
  walletName?: string
  /** Symbol of the token the user sent (the record otherwise carries the bridged token's). */
  tokenSymbol?: string
  /** ERC-20 to transfer instead of the pinned bridge's token, and the row token its sweep settles in. */
  token?: { address: Address; decimals: number; settlesIn?: Address }
  mint?: boolean
  /** False: a payer funding someone else's address. Nothing is recorded on this device. */
  record?: boolean
  onStage?: (stage: DepositStage) => void
  /** Fires with the L1 hash once the wallet has broadcast the transfer, before confirmation. */
  onSubmitted?: (txHash: Hex) => void
  /** Desktop bridge only: receives the helper page's URL for display. */
  onBrowserSubmit?: (submitUrl: string) => void
  /**
   * The caller's last check, with the fee read for this send (display units of the manifest
   * token). It runs right before the wallet prompt, and on the desktop before the hand-off and again
   * each time the helper page is about to send. A throw stops the transfer.
   */
  preflight: (fresh: { feeDisplay: string }) => Promise<void>
  /**
   * Desktop only: runs when the helper is about to be approved to send, after the recheck passed in
   * time, with the desktop submission id. It must resolve once it has durably recorded that a send
   * may follow, or reject so the send is refused.
   */
  beforeApprove?: (submission: string) => Promise<void>
  /**
   * Browser wallet only: runs right before the wallet prompt. It must resolve once it has durably
   * recorded that a send may follow, or reject so the send is refused.
   */
  beforeSend?: () => Promise<void>
}

const BROWSER = "browser:"

/** The id a hold saved before a browser wallet's prompt carries. */
export const browserSubmission = () => `${BROWSER}${crypto.randomUUID()}`

/**
 * Whether a funding that failed ends the hold saved under `submission`: a desktop one's, unless the
 * helper's send stayed unresolved; a browser wallet's only on the wallet's refusal, since any other
 * failure may follow its broadcast.
 */
export function holdEnds(submission: string, e: unknown): boolean {
  if (submission.startsWith(BROWSER)) return isWalletRejection(e)
  return !(e instanceof DesktopSendUnresolvedError)
}

/** What a funding transfer reads and drives: the pinned deployment, L1 and the desktop bridge. */
export interface FundDepositDeps {
  /** The wallet's own deposit addresses: each has its record before it can be funded. */
  deposits: Pick<SipaDeposits, "apply">
  wakeBroadcasts(): void
  tuple(): Promise<OxideEnvTuple>
  publicClient: Pick<PublicClient, "waitForTransactionReceipt">
  /** The page's: a receipt wait polls at its interval. */
  pace: Pick<Pace, "foreignMs">
  config: WebWalletConfig
  tokenMetadata(token: Address): Promise<{ symbol: string; decimals: number }>
  displayFacts(token?: Pick<DepositTokenOption, "settlesIn">): Promise<DepositDisplayFacts>
  balance(account: Address, token: Address): Promise<L1TokenBalance>
  l1Clients: (chainId: number, from?: Hex) => ReturnType<typeof getL1Clients>
  desktop: { active(): boolean; submit: typeof submitViaDesktopBridge }
}

/**
 * Transfers `amountDisplay` of the token from the connected L1 wallet to `target` (optionally
 * minting first on the sandbox faucet token). `from` pins the sending account to the app's
 * selection. Funds the address the caller is already showing: deriving one here would send to an
 * address the user never saw.
 */
export async function fundDeposit(
  params: FundDepositParams,
  deps: FundDepositDeps,
): Promise<{ txHash: Hex; address: Address; name: string }> {
  const { config, publicClient } = deps
  const receiptPoll = deps.pace.foreignMs(L1_RECEIPT_POLL_MS)
  const onStage = params.onStage ?? (() => {})
  const { address, name } = params.target
  const pinned = requireTupleField(await deps.tuple(), "token") as Address
  const meta = await deps.tokenMetadata(pinned)
  const token = params.token?.address ?? pinned
  const decimals = params.token?.decimals ?? meta.decimals
  const amount = parseUnits(params.amountDisplay, decimals)

  // The fee and the cap are the row the token settles on, in the row token's units; every picker
  // token is a dollar stable, so compare 1:1.
  const {
    fee: feeDisplay,
    txAmountCap: cap,
    token: rowToken,
  } = await deps.displayFacts(
    params.token?.settlesIn ? { settlesIn: params.token.settlesIn } : undefined,
  )
  const outside = depositWindowError(
    amount,
    parseUnits(feeDisplay, decimals),
    decimals,
    params.tokenSymbol ?? meta.symbol,
    cap,
    (await deps.tokenMetadata(rowToken)).decimals,
  )
  if (outside) throw outside

  /**
   * The transfer is already confirmed on L1 by the time this runs, so a failed local write costs a
   * display row and nothing more. Reporting it as a failed deposit would be a lie.
   */
  const stampFunding = async (stamp: FundingStamp) => {
    try {
      await deps.deposits.apply(address, { type: "fundingSent", fields: stamp })
    } catch (err) {
      console.warn("[fundDeposit] could not record the funding transaction locally", err)
    }
    // Funds wait on its broadcast now: it goes first among what is owed.
    deps.wakeBroadcasts()
  }

  // Desktop launcher: no injected wallet exists in the dedicated Chrome profile, so the prepared
  // transfer is handed to a helper page in the user's default browser (where their wallet lives)
  // and we wait for the reported hash. Receipt-watching runs over our own RPC client.
  if (deps.desktop.active()) {
    if (params.mint) throw new WalletError("deposit.mintUnavailable")
    await params.preflight({ feeDisplay })
    onStage("awaiting-browser")
    const txHash = await deps.desktop.submit({
      onHelperOpened: params.onBrowserSubmit,
      // The helper page can stay open for minutes, so capacity is read again when it is about to send.
      recheck: () => params.preflight({ feeDisplay }),
      beforeApprove: params.beforeApprove,
      tx: {
        to: token,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "transfer",
          args: [address, amount],
        }),
        chainId: config.l1ChainId,
      },
      display: {
        title: "Fund your zk.money deposit",
        lines: [
          ["Amount", `${params.amountDisplay} ${params.tokenSymbol ?? meta.symbol}`],
          ["Deposit address", address],
          ["Token contract", token],
          ["Network", l1ChainFor(config.l1ChainId).name],
          [
            "Network capacity",
            "Checked again when you click send. A check doesn't reserve capacity, so processing can still wait.",
          ],
        ],
      },
    })
    onStage("confirming")
    params.onSubmitted?.(txHash)
    await confirmed(publicClient, txHash, receiptPoll)
    if (params.record !== false)
      await stampFunding({
        fundingTxHash: txHash,
        walletName: params.walletName,
        tokenSymbol: params.tokenSymbol,
      })
    onStage("done")
    return { txHash, address, name }
  }

  onStage("connecting")
  const { walletClient, account, chain } = await deps.l1Clients(config.l1ChainId, params.from)

  if (params.mint) {
    onStage("minting")
    const mintHash = await walletClient.writeContract({
      address: token,
      abi: SANDBOX_MINT_ABI,
      functionName: "mint",
      args: [account, amount],
      account,
      chain,
    })
    await publicClient.waitForTransactionReceipt({
      hash: mintHash,
      pollingInterval: receiptPoll,
    })
  }

  // Last stop before the wallet prompt — account may have moved since the form ceiling was read.
  const balance = await deps.balance(account, token)
  if (balance.raw < amount) throw new InsufficientL1BalanceError(balance)
  await params.preflight({ feeDisplay })
  await params.beforeSend?.()

  onStage("sending")
  const txHash = await walletClient.writeContract({
    address: token,
    abi: erc20Abi,
    functionName: "transfer",
    args: [address, amount],
    account,
    chain,
  })
  onStage("confirming")
  params.onSubmitted?.(txHash)
  await confirmed(publicClient, txHash, receiptPoll)
  if (params.record !== false)
    await stampFunding({
      fundingTxHash: txHash,
      walletName: params.walletName,
      walletAddress: account,
      tokenSymbol: params.tokenSymbol,
    })
  onStage("done")
  return { txHash, address, name }
}
