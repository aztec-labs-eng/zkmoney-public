/**
 * The two exits from a withdrawal's escrow (a swap or a bridge-out) no relayer is running, in the
 * browser: run it yourself (`factory.deployAndExecute`, the tip comes back to you) or recover what it
 * holds (`recoverERC20`, to an address you name). A wallet's own escrow is signed by its Oxide account with its passkey; a
 * paylink visitor's is signed by the destination wallet with `personal_sign`. front-core's
 * `runSwapEscrowExecute` / `runSwapEscrowRecovery` own the calls, the commitment check and the
 * store write; this file supplies the browser collaborators — the L1 channel shared with the
 * deposit exits, the escrow reader, and the account, salt and passkey the recovery opens with.
 */
import { isAddress, type Address, type Hex } from "viem"
import type { Config } from "wagmi"
import { decodePaylinkInline, L1SwapEscrowReader } from "@obsidion/sdk"
import {
  createOxideL1Reader,
  deriveSkyEscrowSalts,
  deriveSwapEscrowRecoverySalt,
  runSkyEscrow,
  runSkyEscrowRecovery,
  escrowLeg,
  runSwapEscrowExecute,
  runSwapEscrowRecovery,
  signAccountDigestWithPasskey,
  skyEscrowLeg,
  type SavingsMoveRecord,
  type SavingsMoves,
  type WithdrawalRecord,
} from "@obsidion/front-core"
import { l1PublicClient, requireTupleField } from "../../config/oxideTuple"
import type { PageFacts } from "../../session/pageChain"
import { oxideAccountPasskey } from "../../platform/auth/oxideAccountPasskey"
import { isDesktopL1SubmitActive } from "../../platform/desktopBridge"
import {
  desktopBridgeChannel,
  injectedWalletChannel,
  type L1ExitChannel,
  type L1ExitStage,
} from "../sipa/l1ExitChannels"
import { getL1Clients } from "../../session/l1Wallet"
import { sessionSwapRecoverer, type SwapRecoverer } from "./withdrawGateway"
import type { Session } from "../../session/session"

export interface SwapExitOptions {
  wagmi: Config
  /** Recovery only: where the DAI goes. Defaults to the withdrawal's own recipient. */
  destination?: Address
  /** Injected-wallet mode: pins the submitting account to the app's selection. */
  from?: Hex
  /** Recovery only: the paylink a visitor cashed out. Its escrow commits to the recipient, salted by the link secret. */
  linkFragment?: string
  onHelperOpened?: (submitUrl: string) => void
  onStage?: (stage: L1ExitStage) => void
  /** The session whose burn this is. */
  session: Pick<Session, "withdrawals" | "auth" | "page">
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
  const { config } = opts.session.page
  if (!isDesktopL1SubmitActive()) {
    return await injectedWalletChannel(config, {
      pace: opts.session.page.pace,
      wagmi: opts.wagmi,
      from: opts.from,
      onStage: opts.onStage,
    })
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
    pace: opts.session.page.pace,
  })
}

async function escrowReader(
  page: PageFacts,
): Promise<{ reader: L1SwapEscrowReader; dai: Address }> {
  const dai = requireTupleField(await page.chain.oxideTuple.read(), "token") as Address
  return { reader: new L1SwapEscrowReader(l1PublicClient(page.config), { dai }), dai }
}

/** Run `record`'s swap yourself. Resolves to the L1 tx hash. */
export async function executeSwapWithdrawal(
  record: WithdrawalRecord,
  opts: SwapExitOptions,
): Promise<Hex> {
  const { reader, dai } = await escrowReader(opts.session.page)
  const channel = await swapExitChannel(
    record,
    { label: "Recipient", address: record.recipient },
    "Run your zk.money swap",
    opts,
  )
  return await runSwapEscrowExecute({
    record,
    channel,
    reader,
    dai,
    store: opts.session.withdrawals,
  })
}

/**
 * Send `record`'s escrowed DAI to `opts.destination` (the recipient by default). The account's
 * installed passkey signs, and an account still on its bootstrap key is refused; with
 * `opts.linkFragment` the recipient's connected wallet signs.
 */
export async function recoverSwapWithdrawal(
  record: WithdrawalRecord,
  opts: SwapExitOptions,
): Promise<Hex> {
  const target = opts.destination ?? record.recipient
  if (!isAddress(target)) {
    throw new Error("Enter the Ethereum address that should receive the recovered funds.")
  }
  const nonce = escrowLeg(record)?.nonce
  if (!nonce) {
    throw new Error(
      "This withdrawal's escrow details weren't stored, so this wallet can't act on it.",
    )
  }
  const { config } = opts.session.page
  const l1 = l1PublicClient(config)
  const { account, secret, signAccount } = opts.linkFragment
    ? bearerRecoverer(record, opts.linkFragment, config.l1ChainId, opts)
    : await walletRecoverer(opts.session, l1)
  const { reader, dai } = await escrowReader(opts.session.page)
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
    store: opts.session.withdrawals,
    recovery: { account, salt: deriveSwapEscrowRecoverySalt(secret, nonce) },
    signAccount,
    target,
    dai,
    chainId: config.l1ChainId,
    chainNow: async () => (await l1.getBlock()).timestamp,
  })
}

/** A Savings move's escrow, rebuilt from its burn's Sky meta. */
function moveEscrow(burn: WithdrawalRecord) {
  const leg = skyEscrowLeg(burn)
  if (!leg) {
    throw new Error("This move's escrow details weren't stored, so this wallet can't act on it.")
  }
  return leg
}

/** Run a Savings move's escrow yourself: its deposit lands and the tip comes back. Resolves to the L1 tx hash. */
export async function runSkyEscrowMove(
  burn: WithdrawalRecord,
  opts: SwapExitOptions,
): Promise<Hex> {
  const leg = moveEscrow(burn)
  const { reader, dai } = await escrowReader(opts.session.page)
  const channel = await swapExitChannel(
    burn,
    { label: "Escrow", address: leg.escrow },
    "Run your zk.money move",
    opts,
  )
  return await runSkyEscrow({ leg, dai, channel, reader })
}

/**
 * Send a Savings move's escrowed DAI to `opts.destination`, signed by the account's installed
 * passkey, and mark the move recovered.
 */
export async function recoverSkyEscrowMove(
  moves: Pick<SavingsMoves, "update">,
  move: SavingsMoveRecord,
  burn: WithdrawalRecord,
  opts: SwapExitOptions,
): Promise<Hex> {
  const to = opts.destination
  if (!to || !isAddress(to)) {
    throw new Error("Enter the Ethereum address that should receive the recovered funds.")
  }
  const leg = moveEscrow(burn)
  const { config } = opts.session.page
  const l1 = l1PublicClient(config)
  const { account, secret, signAccount } = await walletRecoverer(opts.session, l1)
  const { reader, dai } = await escrowReader(opts.session.page)
  const channel = await swapExitChannel(
    burn,
    { label: "Recovered to", address: to },
    "Recover your zk.money move",
    opts,
  )
  const hash = await runSkyEscrowRecovery(
    {
      leg,
      channel,
      reader,
      recovery: { account, salt: deriveSkyEscrowSalts(secret, move.nonce).recovery },
      signAccount,
      dai,
      chainId: config.l1ChainId,
      chainNow: async () => (await l1.getBlock()).timestamp,
    },
    to,
  )
  await moves.update(move.withdrawalLocalId, (current) => ({
    ...(current ?? move),
    recovered: { to, txHashes: [hash] },
  }))
  return hash
}

type Recoverer = SwapRecoverer & { signAccount: (account: Address, digest: Hex) => Promise<Hex> }

async function walletRecoverer(
  session: Pick<Session, "auth" | "page">,
  l1: ReturnType<typeof l1PublicClient>,
): Promise<Recoverer> {
  const { config, chain } = session.page
  const keys = await session.auth.sessionKeys()
  if (!keys) throw new Error("Unlock your wallet with your passkey and try again.")
  const tuple = await chain.oxideTuple.read()
  const { account, secret } = await sessionSwapRecoverer(session, tuple, keys.secretKey)
  const passkey = await oxideAccountPasskey(keys.authProvider)
  const reader = createOxideL1Reader(l1)
  return {
    account,
    secret,
    signAccount: (signer, hash) =>
      signAccountDigestWithPasskey({
        account: signer,
        hash,
        chainId: config.l1ChainId,
        reader,
        passkey,
      }),
  }
}

/** A visitor has no account: the recipient's own wallet signs. */
function bearerRecoverer(
  record: WithdrawalRecord,
  fragment: string,
  l1ChainId: number,
  { wagmi, from }: Pick<SwapExitOptions, "wagmi" | "from">,
): Recoverer {
  if (isDesktopL1SubmitActive()) {
    throw new Error("Open this link in a browser with the recipient's wallet to recover the funds.")
  }
  const account = record.recipient as Address
  return {
    account,
    secret: decodePaylinkInline(fragment).secret,
    // ponytail: EOA personal_sign only (what the escrow checks for an address with no code); a smart-wallet
    // recipient would need its own ERC-1271 signing flow.
    signAccount: async (signer, digest) => {
      const { walletClient, account: connected } = await getL1Clients(wagmi, l1ChainId, from)
      if (connected.toLowerCase() !== signer.toLowerCase()) {
        throw new Error(
          `Connect ${signer} — the address this link was claimed to — to sign the recovery.`,
        )
      }
      return await walletClient.signMessage({ account: connected, message: { raw: digest } })
    },
  }
}
