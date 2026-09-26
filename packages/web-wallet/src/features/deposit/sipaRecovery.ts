import { oxideAccountPasskey } from "../../platform/auth/oxideAccountPasskey"
/**
 * The `recoverERC20` exit in the browser: pulls a SIPA deposit the sweep path can never move back
 * out to an L1 address the user controls. front-core's `runSipaRecovery` owns the key derivation,
 * the signature and the store write; this file supplies the browser collaborators — an L1
 * submission channel and the pre-submit balance read that stops a recovery from settling a record
 * it never moved.
 *
 * Two channels, because the desktop launcher's Chrome profile carries no wallet extension:
 * an injected wallet both pays the gas and receives the funds, while the launcher hands the
 * prepared transaction to a helper page in the user's default browser and the funds go to an
 * address the user types (any EOA can submit — only `target` is paid).
 */
import {
  erc20Abi,
  isAddress,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem"
import {
  createRegistrationSipaDeriver,
  depositAmounts,
  deriveStealthKey,
  isStuckSweep,
  deriveBootstrapKey,
  createOxideL1Reader,
  signAccountDigest,
  runSipaRecovery,
  STUCK_SWEEP_MS,
  sipaDeployArgCandidates,
  SIPADepositStore,
  type SIPADepositRecord,
  type SipaRecoverCandidate,
  type SipaRecoveryDeps,
} from "@obsidion/front-core"
import {
  predictSIPA,
  predictLegacySIPA,
  predictAccountAddress,
  encodeAccountInitCode,
  IntraRollupMigrationService,
  readDepositSIPAImplementation,
} from "@obsidion/sdk"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { getConfig, l1ChainFor, type WebWalletConfig } from "../../config/env"
import {
  getOxideTuple,
  l1PublicClient,
  oxideEnvFor,
  requireTupleField,
} from "../../config/oxideTuple"
import { registrationRefundConfirmed } from "../onboarding/registrationQuoteRecovery"
import { registrationRecordForSipa } from "../onboarding/webRegistration"
import { getAuthService } from "../../platform/auth/useAuthenticator"
import { isDesktopL1SubmitActive, submitViaDesktopBridge } from "../../platform/desktopBridge"
import { WebStorageAdapter } from "../../platform/storage/WebStorageAdapter"
import { getL1Clients } from "./l1Wallet"
import { readSipaDeployed } from "./sipaSweep"

/** The stuck-sweep clock the activity feed and both exits share. */
export { isStuckSweep, STUCK_SWEEP_MS }

/** Why a record offers the exit: `unsweepable` can never be swept, `stuck` still can. */
export type RecoveryReason = "unsweepable" | "stuck" | "registration-quote"

/** Progress of one L1 submission — shared by both exits. */
export type L1ExitStage = "signing" | "awaiting-browser" | "confirming"

/**
 * Whether `record` offers the recovery exit, and on which grounds. The note's message secret is
 * half the recovery key, so a record discovered without one cannot sign at all.
 */
export function recoveryReasonFor(
  record: Pick<SIPADepositRecord, "phase" | "messageSecret" | "startTime" | "sweepTxHash">,
  now: number = Date.now(),
): RecoveryReason | null {
  if (!record.messageSecret) return null
  if (record.phase === "recoverable") return "unsweepable"
  return isStuckSweep(record, now) ? "stuck" : null
}

/** Who the transaction pays and how it reaches L1. Shared by the recovery and self-sweep exits. */
export interface L1ExitChannel {
  /** Receives the recovered funds, the deposit fee on a self-sweep, or a finalize's relayer tip. */
  target: Address
  sendTransaction: (to: Address, data: Hex) => Promise<Hex>
  /** False on a reverted transaction. */
  waitForReceipt: (hash: Hex) => Promise<boolean>
}

export interface RecoveryDeps {
  channel: L1ExitChannel
  chainId: number
  /** Fallback token for records predating `tokenAddress` tracking. */
  token: Address
  /** The SIPA's live token balance. */
  readBalance: (sipa: Address, token: Address) => Promise<bigint>
  /** A confirmed recovery's receipt, for what it moved. */
  readReceipt: (hash: Hex) => Promise<TransactionReceipt>
  /** Deploy capability for an undeployed SIPA (see `SipaRecoveryDeps.deployment`). */
  deployment: SipaRecoveryDeps["deployment"]
  store: Pick<SIPADepositStore, "get" | "upsert">
  stealthKey: () => Promise<SipaRecoveryDeps["stealthKey"]>
  signAccount?: SipaRecoveryDeps["signAccount"]
  accountInitCode?: Hex
  /** Injectable for tests. */
  run?: typeof runSipaRecovery
}

/**
 * Guard the recovery, then run it. The balance read is load-bearing: a `recoverERC20` over an
 * already-swept SIPA transfers nothing yet still confirms, which would settle the record as
 * `recovered` and hide a deposit that is on its way into the balance.
 */
export async function recoverSipaDeposit(
  record: SIPADepositRecord,
  deps: RecoveryDeps,
): Promise<Hex> {
  if (!record.messageSecret) {
    throw new Error(
      "This wallet is still looking up this deposit's details. Recovery becomes available once it has them.",
    )
  }
  const token = record.tokenAddress ?? deps.token
  const balance = await deps.readBalance(record.sipaAddress, token)
  if (balance === 0n) {
    // A record without its own token read the CURRENT deployment's token — on a historic-generation
    // SIPA that read is against the wrong contract, so zero is inconclusive there.
    throw new Error(
      record.tokenAddress
        ? "This deposit has already been swept. It will appear in your balance shortly."
        : "This deposit reads as already swept, but it predates token tracking — if it was made on an older deployment, report it from Settings before assuming the funds moved.",
    )
  }
  const hash = await (deps.run ?? runSipaRecovery)({
    record,
    stealthKey: await deps.stealthKey(),
    signAccount: deps.signAccount,
    accountInitCode: deps.accountInitCode,
    target: deps.channel.target,
    token,
    chainId: deps.chainId,
    deployment: deps.deployment,
    sendTransaction: deps.channel.sendTransaction,
    waitForReceipt: deps.channel.waitForReceipt,
    store: deps.store,
  })
  await registrationRefundConfirmed(
    record.sipaAddress,
    token,
    deps.chainId,
    hash,
    deps.readReceipt,
  ).catch(() => {})
  return hash
}

/**
 * The injected wallet pays the gas and is itself the destination. Receipts are polled over the
 * app's own RPC, not the wallet's: connected over a scanned QR the wallet is a phone behind a
 * WalletConnect relay, and plenty of mobile wallets answer no reads at all. `readClient` overrides
 * that for callers whose environment cannot reach the RPC.
 */
export async function injectedWalletChannel(
  config: WebWalletConfig,
  opts: {
    from?: Hex
    onStage?: (stage: L1ExitStage) => void
    readClient?: PublicClient
  } = {},
): Promise<L1ExitChannel> {
  const { walletClient, account, chain } = await getL1Clients(config.l1ChainId, opts.from)
  const publicClient = opts.readClient ?? l1PublicClient(config)
  return {
    target: account,
    sendTransaction: async (to, data) => {
      const block = await publicClient.getBlock({ blockTag: "latest" })
      // EIP-7825 caps individual transactions on Ethereum and Sepolia independently of the
      // block limit. Local/other chains retain their own block limit.
      const transactionCap = chain.id === 1 || chain.id === 11155111 ? 16_777_216n : block.gasLimit
      const limit = block.gasLimit < transactionCap ? block.gasLimit : transactionCap
      // Bound the estimate too: some RPCs otherwise simulate against the larger block limit.
      // Propagate estimation errors before signing; never let a wallet substitute a fallback.
      const estimate = await publicClient.estimateGas({ to, data, account, gas: limit })
      if (estimate > limit) {
        throw new Error("This transaction exceeds the network's gas limit and cannot be submitted.")
      }
      const buffered = (estimate * 120n + 99n) / 100n
      const gas = buffered < limit ? buffered : limit
      opts.onStage?.("signing")
      return walletClient.sendTransaction({ to, data, account, chain, gas })
    },
    waitForReceipt: async (hash) => {
      opts.onStage?.("confirming")
      const receipt = await publicClient.waitForTransactionReceipt({ hash })
      return receipt.status === "success"
    },
  }
}

export interface DesktopBridgeChannelParams {
  /**
   * Who the transaction pays. Typed by the user on the deposit exits; on a withdrawal finalize it
   * is the withdrawal's own recipient, which takes the relayer tip.
   */
  destination: Address
  chainId: number
  /** App-owned client: the helper page's wallet is not ours to poll. */
  publicClient: PublicClient
  /** Helper-page summary; the network row is appended. */
  display: { title: string; lines: [string, string][] }
  onHelperOpened?: (submitUrl: string) => void
  onStage?: (stage: L1ExitStage) => void
}

/** Submission through the desktop launcher's helper page in the user's default browser. */
export function desktopBridgeChannel(params: DesktopBridgeChannelParams): L1ExitChannel {
  return {
    target: params.destination,
    sendTransaction: (to, data) => {
      params.onStage?.("awaiting-browser")
      return submitViaDesktopBridge({
        onHelperOpened: params.onHelperOpened,
        tx: { to, data, chainId: params.chainId },
        display: {
          title: params.display.title,
          lines: [...params.display.lines, ["Network", l1ChainFor(params.chainId).name]],
        },
      })
    },
    waitForReceipt: async (hash) => {
      params.onStage?.("confirming")
      const receipt = await params.publicClient.waitForTransactionReceipt({ hash })
      return receipt.status === "success"
    },
  }
}

/** The user's stealth keypair; unavailable while the session is locked. */
async function webStealthKey(): Promise<SipaRecoveryDeps["stealthKey"]> {
  const msk = await getAuthService().getSecretKey()
  if (!msk) throw new Error("Unlock your wallet with your passkey and try again.")
  return deriveStealthKey(msk)
}

export interface RecoverDepositOptions {
  /** Required in bridge mode: where the recovered funds go. */
  destination?: Address
  /** Injected-wallet mode: pins the submitting (and receiving) account to the app's selection. */
  from?: Hex
  onHelperOpened?: (submitUrl: string) => void
  onStage?: (stage: L1ExitStage) => void
}

/** Recover `record` over whichever channel this build has. Resolves to the L1 recovery tx hash. */
export async function recoverDeposit(
  record: SIPADepositRecord,
  opts: RecoverDepositOptions = {},
): Promise<Hex> {
  const config = getConfig()
  if (record.l1ChainId !== config.l1ChainId)
    throw new Error("Switch to the deposit's original chain before recovery")
  const publicClient = l1PublicClient(config)
  const tuple = await getOxideTuple(config)
  const token = requireTupleField(tuple, "token") as Address

  let channel: L1ExitChannel
  if (isDesktopL1SubmitActive()) {
    const destination = opts.destination
    if (!destination || !isAddress(destination)) {
      throw new Error("Enter the Ethereum address that should receive the recovered funds.")
    }
    channel = desktopBridgeChannel({
      destination,
      chainId: config.l1ChainId,
      publicClient,
      display: {
        title: "Recover your zk.money deposit",
        lines: [
          ["Amount", `${depositAmounts(record).grossDisplay} ${record.tokenSymbol}`],
          ["Deposit address", record.sipaAddress],
          ["Recovered to", destination],
        ],
      },
      onHelperOpened: opts.onHelperOpened,
      onStage: opts.onStage,
    })
  } else {
    channel = await injectedWalletChannel(config, { from: opts.from, onStage: opts.onStage })
  }

  const auth = getAuthService()
  const secret = await auth.getSecretKey()
  if (!secret) throw new Error("Unlock the wallet before recovery")
  const bootstrap = deriveBootstrapKey(secret)
  const provider = await auth.getAuthProvider()
  const passkey = provider ? await oxideAccountPasskey(provider) : undefined
  const reader = createOxideL1Reader(publicClient)
  let accountInitCode: Hex | undefined
  if (record.origin?.protocol === "account") {
    const predicted = await predictAccountAddress(
      publicClient,
      record.origin.accountFactory,
      bootstrap.address,
    )
    if (predicted.toLowerCase() !== record.origin.recoveryAccount.toLowerCase())
      throw new Error("Wallet keys do not match this deposit's recovery account")
    const code = await reader.getCode(predicted)
    if (!code || code === "0x")
      accountInitCode = encodeAccountInitCode(record.origin.accountFactory, bootstrap.address)
  }

  return await recoverSipaDeposit(record, {
    channel,
    chainId: config.l1ChainId,
    token,
    readBalance: (sipa, tok) => readSipaTokenBalance(publicClient, sipa, tok),
    readReceipt: (hash) => publicClient.getTransactionReceipt({ hash }),
    deployment: await recoveryDeployment(publicClient, record, tuple),
    store: SIPADepositStore.get(new WebStorageAdapter()),
    stealthKey: webStealthKey,
    accountInitCode,
    signAccount: (account, hash) =>
      signAccountDigest({ account, hash, chainId: config.l1ChainId, bootstrap, reader, passkey }),
  })
}

/**
 * Deploy capability for the current manifest tuple: an unswept deposit is counterfactual, so
 * recovery must be able to deploy it. The implementation read is best-effort — an unreadable
 * factory yields no deposit candidates and the recovery fails closed instead of submitting a no-op.
 */
async function recoveryDeployment(
  publicClient: PublicClient,
  record: SIPADepositRecord,
  tuple: OxideEnvTuple,
): Promise<SipaRecoveryDeps["deployment"]> {
  const deployments: Parameters<typeof sipaDeployArgCandidates>[1] = []
  if (!record.origin) {
    const config = getConfig()
    const { historic } = await IntraRollupMigrationService.detectHistoricDeployments({
      ...config.oxideProfile,
      network: config.network,
    })
    for (const candidate of [tuple, ...historic]) {
      if (
        candidate.sipaRecoveryProtocol === "account" ||
        !candidate.sipaFactory ||
        !/^\d+$/.test(candidate.rollupVersion ?? "")
      )
        continue
      const implementation =
        (candidate.depositSIPAImplementation as Address | undefined) ??
        (await readDepositSIPAImplementation(
          publicClient,
          candidate.sipaFactory as Address,
          candidate.portal as Address,
        ).catch(() => undefined))
      if (implementation)
        deployments.push({
          sipaFactory: candidate.sipaFactory as Address,
          rollupVersion: BigInt(candidate.rollupVersion),
          implementation,
        })
    }
  }
  const registration =
    record.origin || (await readSipaDeployed(publicClient, record.sipaAddress))
      ? null
      : await registrationCandidate(record)
  return {
    readDeployed: (sipa) => readSipaDeployed(publicClient, sipa),
    candidates: [
      ...sipaDeployArgCandidates(record, deployments),
      ...(registration ? [registration] : []),
    ],
    predict: (candidate) =>
      candidate.protocol === "legacy-eoa"
        ? predictLegacySIPA(publicClient, candidate.sipaFactory, candidate.args)
        : predictSIPA(
            publicClient as never,
            candidate.sipaFactory,
            candidate.args.implementation,
            candidate.args.intentHash,
            candidate.args.recoveryCommitment,
            candidate.args.rollupVersion,
            candidate.args.resweepable,
          ),
  }
}

/**
 * The CREATE2 args of a registration SIPA, or null for a plain deposit. A registration SIPA
 * commits to the registration intent (registration implementation, non-resweepable), which the
 * pending record does not persist — it is re-derived from the unlocked master secret.
 */
async function registrationCandidate(
  record: SIPADepositRecord,
): Promise<SipaRecoverCandidate | null> {
  const pending = registrationRecordForSipa(record.sipaAddress)
  // Legacy records lack the payment committed into the address; do not substitute a current quote.
  if (!pending || pending.fee === undefined || pending.beneficiary === undefined) return null
  const msk = await getAuthService().getSecretKey()
  if (!msk) throw new Error("Unlock your wallet with your passkey and try again.")
  const config = getConfig()
  const { tuple, env, publicClient } = await oxideEnvFor(config)
  const derive = createRegistrationSipaDeriver({
    publicClient,
    env,
    tuple,
    network: config.network,
  })
  const derivation = await derive({
    owner: pending.account as Address,
    nameHash: pending.nameHash,
    l2Address: pending.l2Address,
    fee: BigInt(pending.fee),
    beneficiary: pending.beneficiary,
    masterSecret: msk,
  })
  const sipaFactory = requireTupleField(tuple, "sipaFactory") as Address
  return "recoveryAddress" in derivation.sipaArgs
    ? { protocol: "legacy-eoa", sipaFactory, args: derivation.sipaArgs }
    : { protocol: "account", sipaFactory, args: derivation.sipaArgs }
}

/** The SIPA's current token balance. */
export function readSipaTokenBalance(
  publicClient: PublicClient,
  sipa: Address,
  token: Address,
): Promise<bigint> {
  return publicClient.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [sipa],
  })
}
