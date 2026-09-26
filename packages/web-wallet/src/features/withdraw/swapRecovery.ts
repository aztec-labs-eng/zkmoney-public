/**
 * The two exits from a swap-on-withdraw escrow no relayer is running, in the browser: run the swap
 * yourself (`factory.deployAndExecute`, the tip comes back to you) or recover the DAI (`recoverERC20`,
 * signed by this wallet's Oxide account with its passkey, to an address you name). front-core's
 * `runSwapEscrowExecute` / `runSwapEscrowRecovery` own the calls, the commitment check and the
 * store write; this file supplies the browser collaborators — the L1 channel shared with the
 * deposit exits, the escrow reader, and the account, salt and passkey the recovery opens with.
 */
import { isAddress, type Address, type Hex } from "viem"
import { L1SwapEscrowReader } from "@obsidion/sdk"
import {
  canRecoverSwap,
  canSelfExecuteSwap,
  createOxideL1Reader,
  deriveSwapEscrowRecoverySalt,
  runSwapEscrowExecute,
  runSwapEscrowRecovery,
  signAccountDigestWithPasskey,
  swapEscrowTarget,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import { getConfig } from "../../config/env"
import { getOxideTuple, l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import { oxideAccountPasskey } from "../../platform/auth/oxideAccountPasskey"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import { isDesktopL1SubmitActive } from "../../platform/desktopBridge"
import {
  desktopBridgeChannel,
  injectedWalletChannel,
  type L1ExitChannel,
  type L1ExitStage,
} from "../deposit/sipaRecovery"
import { getWithdrawalStore, ownSwapRecoverer } from "./withdrawGateway"

/** Why a swap record offers an exit: `unswappable` can never fill, `stuck` still can. */
export type SwapExitReason = "unswappable" | "stuck"

/** Whether `record` offers a swap exit, and on which grounds. */
export function swapExitReasonFor(
  record: WithdrawalRecord,
  now: number = Date.now(),
): SwapExitReason | null {
  if (canRecoverSwap(record)) return "unswappable"
  return canSelfExecuteSwap(record, now) ? "stuck" : null
}

export interface SwapExitOptions {
  /** Recovery only: where the DAI goes. Defaults to the withdrawal's own recipient. */
  destination?: Address
  /** Injected-wallet mode: pins the submitting account to the app's selection. */
  from?: Hex
  onHelperOpened?: (submitUrl: string) => void
  onStage?: (stage: L1ExitStage) => void
}

/**
 * Where the transaction is signed. Neither exit asks who is paid by the submitter: the swap pays
 * the recipient the escrow committed to and tips whoever submits, and the recovery pays the signed
 * `target` — so the desktop launcher's helper page is handed the paid address purely to show it.
 */
async function swapExitChannel(
  record: WithdrawalRecord,
  paid: { label: string; address: Address },
  title: string,
  opts: SwapExitOptions,
): Promise<L1ExitChannel> {
  const config = getConfig()
  if (!isDesktopL1SubmitActive()) {
    return await injectedWalletChannel(config, { from: opts.from, onStage: opts.onStage })
  }
  return desktopBridgeChannel({
    destination: paid.address,
    chainId: config.l1ChainId,
    publicClient: l1PublicClient(config),
    display: {
      title,
      lines: [
        ["Amount", `${record.amount} ${record.tokenSymbol}`],
        [paid.label, paid.address],
      ],
    },
    onHelperOpened: opts.onHelperOpened,
    onStage: opts.onStage,
  })
}

async function escrowReader(): Promise<{ reader: L1SwapEscrowReader; dai: Address }> {
  const config = getConfig()
  const dai = requireTupleField(await getOxideTuple(config), "token") as Address
  return { reader: new L1SwapEscrowReader(l1PublicClient(config), { dai }), dai }
}

/** Run `record`'s swap yourself. Resolves to the L1 tx hash. */
export async function executeSwapWithdrawal(
  record: WithdrawalRecord,
  opts: SwapExitOptions = {},
): Promise<Hex> {
  const { reader } = await escrowReader()
  const channel = await swapExitChannel(
    record,
    { label: "Recipient", address: record.recipient },
    "Run your zk.money swap",
    opts,
  )
  return await runSwapEscrowExecute({ record, channel, reader, store: getWithdrawalStore() })
}

/**
 * Send `record`'s escrowed DAI to `opts.destination` (the recipient by default). The account's
 * installed passkey signs; an account still on its bootstrap key is refused.
 */
export async function recoverSwapWithdrawal(
  record: WithdrawalRecord,
  opts: SwapExitOptions = {},
): Promise<Hex> {
  const target = opts.destination ?? record.recipient
  if (!isAddress(target)) {
    throw new Error("Enter the Ethereum address that should receive the recovered funds.")
  }
  const nonce = swapEscrowTarget(record)?.args.nonce
  if (!nonce) {
    throw new Error(
      "This withdrawal's escrow details weren't stored, so this wallet can't act on it.",
    )
  }
  const config = getConfig()
  const { account, secret } = await ownSwapRecoverer(await getOxideTuple(config))
  const provider = await getAuthService().getAuthProvider()
  const passkey = provider ? await oxideAccountPasskey(provider) : undefined
  const l1Reader = createOxideL1Reader(l1PublicClient(config))
  const { reader, dai } = await escrowReader()
  const channel = await swapExitChannel(
    record,
    { label: "Recovered to", address: target },
    "Recover your zk.money withdrawal",
    opts,
  )
  return await runSwapEscrowRecovery({
    record,
    channel,
    reader,
    store: getWithdrawalStore(),
    recovery: { account, salt: deriveSwapEscrowRecoverySalt(secret, nonce) },
    signAccount: (signer, hash) =>
      signAccountDigestWithPasskey({
        account: signer,
        hash,
        chainId: config.l1ChainId,
        reader: l1Reader,
        passkey,
      }),
    target,
    dai,
    chainId: config.l1ChainId,
  })
}
