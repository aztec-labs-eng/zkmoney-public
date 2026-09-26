/**
 * The self-finalize exit in the browser: when no relayer has released a proven withdrawal, the user
 * submits its `OxidePortal.withdraw` call themselves. Nobody chooses the payee: the burn named the
 * recipient before it was ever signed. The call names who takes the relayer tip the burn offered,
 * plus the deployment's withdrawal subsidy: the channel's `target`.
 *
 * The sdk owns the calldata (`buildWithdrawFinalizationCall`); this file supplies the browser
 * collaborators — the manifest-derived portal identity and executor, the pre-submit
 * already-released read, and the submission channel it shares with the deposit exits.
 *
 * Unlike the deposit exits this module exposes no `getConfig()`-shaped entry of its own: the node
 * and the TEE signer live in React context, so the call site hands them in — or hands in nothing,
 * which is what a locked or still-connecting wallet looks like from here.
 */
import type { AztecNode } from "@aztec/aztec.js/node"
import { createPublicClient, type Address, type Hex, type PublicClient } from "viem"
import {
  buildWithdrawFinalizationCall,
  isWithdrawalSpent,
  WithdrawFinalizationError,
  type TeeSigner,
  type WithdrawalPortalContext,
  type WithdrawFinalizationCall,
} from "@obsidion/sdk"
import {
  resolveWithdrawalWiring,
  withdrawalRecipients,
  type WithdrawalRecord,
  type WithdrawalStorage,
} from "@obsidion/front-core"
import { getConfig, l1Transport, type WebWalletConfig } from "../../config/env"
import { getOxideTuple } from "../../config/oxideTuple"
import { isDemoMode } from "../../dev/demoFlag"
import {
  desktopBridgeChannel,
  injectedWalletChannel,
  type L1ExitChannel,
  type L1ExitStage,
} from "../deposit/sipaRecovery"
import { isDesktopL1SubmitActive } from "../../platform/desktopBridge"
import { getWithdrawalStore } from "./withdrawGateway"

/** Said whenever the withdrawal turns out to be released already, from either check. */
const ALREADY_RELEASED =
  "A relayer finalized this withdrawal first and the funds have already reached the recipient. Refresh to see it complete."

/** The wallet the finalization needs, held in React context rather than reachable from a module. */
export interface FinalizeWallet {
  node: AztecNode
  signer: TeeSigner
}

/** The calldata builder, already bound to whatever chain access it needs. */
export type FinalizationBuilder = (
  burnTxHash: Hex,
  tipRecipient: Address,
) => Promise<WithdrawFinalizationCall>

export interface SelfFinalizeDeps {
  channel: L1ExitChannel
  build: FinalizationBuilder
  portalContext: WithdrawalPortalContext
  l1: PublicClient
  store: Pick<WithdrawalStorage, "patch" | "get">
  /** Injectable for tests. */
  isSpent?: typeof isWithdrawalSpent
}

/** Where the real calldata comes from: the wallet's node and the enclave signature over the burn. */
export function walletFinalizationBuilder(
  wallet: FinalizeWallet,
  ctx: {
    portalContext: WithdrawalPortalContext
    plainWithdrawalExecutor: Hex
    withdrawalSubsidy?: Hex
    l1: PublicClient
  },
): FinalizationBuilder {
  return (burnTxHash, tipRecipient) =>
    buildWithdrawFinalizationCall(
      {
        node: wallet.node,
        signer: wallet.signer,
        portalContext: ctx.portalContext,
        plainWithdrawalExecutor: ctx.plainWithdrawalExecutor,
        l1: ctx.l1,
      },
      { burnTxHash, tipRecipient, withdrawalSubsidy: ctx.withdrawalSubsidy },
    )
}

/**
 * Guard the finalization, then submit it. The already-released read is the cheap honest refusal:
 * the signature behind the calldata replays the burn checkpoint's blocks, which is too expensive
 * to spend on a withdrawal that is already done. A relayer can still win the race after it, and
 * then the portal reverts this transaction.
 */
export async function selfFinalizeWithdrawal(
  record: WithdrawalRecord,
  deps: SelfFinalizeDeps,
): Promise<Hex> {
  if (!record.l2TxHash) {
    throw new Error(
      "This withdrawal hasn't been submitted to Aztec yet, so there is nothing to finalize.",
    )
  }
  const isSpent = deps.isSpent ?? isWithdrawalSpent
  if (
    record.withdrawalId &&
    (await isSpent(deps.l1, deps.portalContext.l1Portal, record.withdrawalId))
  ) {
    throw new Error(ALREADY_RELEASED)
  }

  let call
  try {
    call = await deps.build(record.l2TxHash, deps.channel.target)
  } catch (err) {
    throw new Error(finalizationFailureMessage(err), { cause: err })
  }

  const hash = await deps.channel.sendTransaction(call.to, call.data)
  if (!(await deps.channel.waitForReceipt(hash))) {
    // A relayer that released it while this transaction was in flight is the likely revert.
    if (await isSpent(deps.l1, deps.portalContext.l1Portal, call.withdrawalId).catch(() => false)) {
      throw new Error(ALREADY_RELEASED)
    }
    throw new Error(
      `Finalization transaction ${hash} reverted, so nothing moved and the withdrawal is still finalizable. Try again in a little while.`,
    )
  }
  // Deliberately phase-preserving: only the tracker's `isSpent` pass may write `done`, and it needs
  // to see the release on chain. Read the phase and the epoch back rather than echoing the
  // snapshot: the tracker can write `done` or demote the record while the receipt is awaited, and
  // the snapshot would rewind the one and un-fence the other.
  const current = deps.store.get(record.l2TxHash) ?? record
  await deps.store.patch(record.l2TxHash, {
    phase: current.phase,
    finalizeTxHash: hash,
    reorgEpoch: current.reorgEpoch,
  })
  return hash
}

/** The user-facing wording for each classified builder failure; anything else keeps its own. */
function finalizationFailureMessage(err: unknown): string {
  if (!(err instanceof WithdrawFinalizationError)) {
    return err instanceof Error ? err.message : String(err)
  }
  switch (err.reason) {
    case "already-finalized":
      return ALREADY_RELEASED
    case "not-yet-finalizable":
      return "This withdrawal can't be finalized yet. Try again in a little while."
    case "enclave-unavailable":
      return "The signing service is unreachable. Try again in a little while."
  }
}

export interface SelfFinalizeOptions {
  /** Injected-wallet mode: pins the submitting (and tipped) account to the app's selection. */
  from?: Hex
  onHelperOpened?: (submitUrl: string) => void
  onStage?: (stage: L1ExitStage) => void
}

/**
 * Where the finalization is signed, and who takes the relayer tip. No destination is ever asked
 * for: the payee is fixed by the burn. An injected wallet submits and is tipped. The desktop
 * launcher's helper page picks its account only after the calldata is built — the bridge carries a
 * finished transaction and reports back only its hash — so there the tip and the subsidy go to the
 * withdrawal's own recipient instead of the submitter. On a swap the payee is the escrow, not the
 * recipient, and the helper says so rather than naming an address this transaction does not pay.
 */
export async function finalizeChannel(params: {
  config: WebWalletConfig
  record: Pick<
    WithdrawalRecord,
    "recipient" | "amount" | "tokenSymbol" | "swapOutput" | "swapEscrow"
  >
  /** App-owned client: the helper page's wallet is not ours to poll. */
  publicClient: PublicClient
  opts: SelfFinalizeOptions
}): Promise<L1ExitChannel> {
  const { config, record, opts } = params
  if (!isDesktopL1SubmitActive()) {
    return await injectedWalletChannel(config, { from: opts.from, onStage: opts.onStage })
  }
  const { final, viaEscrow } = withdrawalRecipients(record)
  return desktopBridgeChannel({
    destination: final,
    chainId: config.l1ChainId,
    publicClient: params.publicClient,
    display: {
      title: "Finalize your zk.money withdrawal",
      lines: [
        ["Amount", `${record.amount} ${record.tokenSymbol}`],
        viaEscrow ? ["Released to", `Swap escrow for ${final}`] : ["Recipient", final],
      ],
    },
    onHelperOpened: opts.onHelperOpened,
    onStage: opts.onStage,
  })
}

/**
 * Dev demo: no node and no enclave to derive calldata from, so the builder is stubbed there.
 * `import.meta.env.DEV` is a build-time literal, so a production build drops this body and the
 * dynamic import with it.
 */
async function demoBuilder(portal: Address): Promise<FinalizationBuilder | undefined> {
  if (!import.meta.env.DEV || !isDemoMode()) return undefined
  return (await import("../../dev/demoFinalization")).demoFinalizationBuilder(portal)
}

/**
 * Finalize `record` over whichever channel this build has. Resolves to the L1 tx hash. A null
 * wallet is refused here — it means the session is locked or still connecting.
 */
export async function selfFinalize(
  record: WithdrawalRecord,
  wallet: FinalizeWallet | null,
  opts: SelfFinalizeOptions = {},
): Promise<Hex> {
  const config = getConfig()
  const publicClient = createPublicClient({ transport: l1Transport(config) })
  const wiring = resolveWithdrawalWiring(await getOxideTuple(config), BigInt(config.l1ChainId))
  if (!wiring) {
    throw new Error("Finalizing by hand isn't available on this network.")
  }
  const ctx = { portalContext: wiring.portalContext, l1: publicClient }
  const build =
    (await demoBuilder(wiring.portal)) ??
    walletFinalizationBuilder(needWallet(wallet), {
      ...ctx,
      plainWithdrawalExecutor: wiring.plainWithdrawalExecutor,
      withdrawalSubsidy: wiring.withdrawalSubsidy,
    })
  const channel = await finalizeChannel({ config, record, publicClient, opts })

  return await selfFinalizeWithdrawal(record, {
    channel,
    build,
    ...ctx,
    store: getWithdrawalStore(),
  })
}

function needWallet(wallet: FinalizeWallet | null): FinalizeWallet {
  if (!wallet) {
    throw new Error("Unlock your wallet with your passkey and try again.")
  }
  return wallet
}
