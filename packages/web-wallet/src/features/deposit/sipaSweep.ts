/**
 * The self-sweep exit in the browser: the user submits the relayer's own deploy-and-sweep
 * transaction for a deposit no relayer picked up, pushing the funds FORWARD into the portal and on
 * into their private balance. Any EOA may submit it; the deposit fee returns to whoever is named as
 * `relayer`, which here is the user's own L1 address.
 *
 * A received deposit is the deposit intent: the deploy-and-sweep binds the SIPA clone to
 * `(depositImplementation, intentHash = keccak256(abi.encode(recipientCommitment)))` and reveals
 * `abi.encode(recipientCommitment)` at sweep with no proofs. The intent builders + calldata come
 * from the SIPA-intents lib (via the local mirror until it vendors); this file supplies the browser
 * collaborators — the manifest addresses the create2 derivation binds to, the deposit
 * implementation read, the pre-submit funding read, and the submission channel it shares with the
 * recovery exit.
 *
 * Nothing is settled here. A confirmed sweep only moves the funds into the portal; the L2 claim is
 * the sync loop's job on its next pass, which reads the very `Sweep` event this transaction emits.
 */
import { createPublicClient, isAddress, type Address, type Hex, type PublicClient } from "viem"
import { Fr } from "@aztec/aztec.js/fields"
import { EthAddress } from "@aztec/foundation/eth-address"
import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import {
  buildDepositIntent,
  buildSipaSweepCall,
  readDepositSIPAImplementation,
  readSipaFundingStatus,
  SELF_BROADCAST_RESWEEPABLE,
  TX_AMOUNT_CAP,
  type SipaSweepDeployArgs,
  type SipaFundingStatus,
} from "@obsidion/sdk"
import {
  computeSIPAAddress,
  computeAccountSIPAAddress,
  depositAmounts,
  SIPADepositStore,
  type SIPADepositRecord,
} from "@obsidion/front-core"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { getConfig, l1Transport, type WebWalletConfig } from "../../config/env"
import { getOxideTuple, requireTupleField } from "../../config/oxideTuple"
import { isDesktopL1SubmitActive } from "../../platform/desktopBridge"
import { fpcFundingCut } from "../fees/fpcFundingCut"
import { WebStorageAdapter } from "../../platform/storage/WebStorageAdapter"
import {
  desktopBridgeChannel,
  injectedWalletChannel,
  isStuckSweep,
  type L1ExitChannel,
  type L1ExitStage,
} from "./sipaRecovery"

/**
 * Whether `record` can be self-swept.
 *
 * Only a stuck `sweeping` record qualifies, on the same staleness the recovery affordance uses: the
 * two exits are reached through one surface, so offering them on different clocks would show a
 * modal whose primary action is unavailable. `recoverable` is excluded outright — its balance sits
 * outside the sweep window, so a sweep there cannot land at all and Recover is the only way out.
 *
 * No message secret is needed: a sweep carries no signature, only the deploy args and the sweep
 * args. What it does need is the pair of derived fields the CREATE2 address is bound to, which a
 * self-initiated record created before discovery may not have yet.
 */
export function canSelfSweep(
  record: Pick<
    SIPADepositRecord,
    "phase" | "startTime" | "sweepTxHash" | "recipientHash" | "recoveryAddress" | "origin"
  >,
  now: number = Date.now(),
): boolean {
  return (
    isStuckSweep(record, now) &&
    !!record.recipientHash &&
    !!(record.recoveryAddress || record.origin)
  )
}

/** The manifest surface the derivation and the sweep bind to. */
export interface SweepManifest {
  sipaFactory: Address
  /** The portal the factory serves this generation's implementations under. */
  portal: Address
  /** Part of the CREATE2 preimage, so it stays even though the implementation is keyed on the portal. */
  rollupVersion: bigint
  token: Address
}

export interface SweepDeps {
  channel: L1ExitChannel
  manifest: SweepManifest
  /** The deposit implementation this portal is served by (`SIPAFactory.implementationFor`). */
  implementation: Address
  /** Non-empty `getCode` — a deployed SIPA is swept directly, an undeployed one deploy-and-swept. */
  readDeployed: (sipa: Address) => Promise<boolean>
  readFunding: (sipa: Address, token: Address) => Promise<SipaFundingStatus>
  /** Offline create2 prediction (`computeSIPAAddress`), checked before any deploy. */
  predict: (args: SipaSweepDeployArgs) => Promise<Address>
  store: Pick<SIPADepositStore, "upsert" | "get">
  /** Injectable for tests. */
  build?: typeof buildSipaSweepCall
}

/**
 * The deploy args for `record` as the deposit intent. The recipient's stealth `recipientHash` is
 * the intent's `recipientCommitment`; the clone commits to `(implementation, intentHash)` where
 * `intentHash = keccak256(abi.encode(recipientCommitment))` and `implementation` is the deposit
 * intent type. `resweepable` is the web wallet's own broadcast flag — every address this wallet
 * hands out is derived under it — and the args are checked against `computeSIPAAddress` before they
 * are used, so a record derived under anything else fails closed rather than deploying to a
 * stranger's address.
 */
export function sweepDeployArgs(
  record: Pick<SIPADepositRecord, "recipientHash" | "recoveryAddress" | "origin">,
  manifest: SweepManifest,
  implementation: Address,
): SipaSweepDeployArgs {
  if (record.origin) {
    const origin = record.origin
    const common = {
      implementation: origin.implementation,
      intentHash: origin.intentHash,
      rollupVersion: BigInt(origin.rollupVersion),
      resweepable: origin.resweepable,
    }
    return origin.protocol === "account"
      ? { ...common, recoveryCommitment: origin.recoveryCommitment }
      : { ...common, recoveryAddress: origin.recoveryAddress }
  }
  const { intentHash } = buildDepositIntent({
    implementation,
    recipientCommitment: record.recipientHash as Hex,
  })
  return {
    implementation,
    intentHash,
    recoveryAddress: record.recoveryAddress as Address,
    rollupVersion: manifest.rollupVersion,
    resweepable: SELF_BROADCAST_RESWEEPABLE,
  }
}

/**
 * Guard the sweep, then submit it. The funding read is the honest failure: a relayer that won the
 * race leaves nothing to sweep and the transaction would revert in the user's wallet, and a balance
 * that fell to the fee floor or was topped up past the per-transaction cap can never be swept at all.
 */
export async function selfSweepDeposit(record: SIPADepositRecord, deps: SweepDeps): Promise<Hex> {
  const { manifest } = deps
  if (!record.recipientHash || (!record.recoveryAddress && !record.origin)) {
    throw new Error(
      "This wallet is still looking up this deposit's details. Sweeping becomes available once it has them.",
    )
  }
  const token = record.tokenAddress ?? manifest.token
  const funding = await deps.readFunding(record.sipaAddress, token)
  if (funding.balance === 0n) {
    throw new Error("This deposit has already been swept. It will appear in your balance shortly.")
  }
  if (!funding.sweepable) {
    // The fee and the portal's cut come off first, and the cap measures what is forwarded after
    // them. `scaledBalance` is the balance in the fee's denomination.
    const reason =
      funding.scaledBalance - funding.fee - funding.fpcFundingCut > TX_AMOUNT_CAP
        ? "is over the network's per-transaction deposit cap"
        : "is at or below the network's deposit fee"
    throw new Error(
      `This deposit ${reason}, so it can't be moved into your private balance. Recover it to an Ethereum address instead.`,
    )
  }

  // The deposit intent: forward the whole balance to the recipient, no fee, no proofs. The record
  // revealed at sweep is `abi.encode(recipientCommitment)`; the clone delegates to the deposit impl.
  const intent = buildDepositIntent({
    implementation: deps.implementation,
    recipientCommitment: record.recipientHash as Hex,
  })
  const deployed = await deps.readDeployed(record.sipaAddress)
  const deployArgs = sweepDeployArgs(record, manifest, deps.implementation)
  if (!deployed) {
    const predicted = await deps.predict(deployArgs)
    if (predicted.toLowerCase() !== record.sipaAddress.toLowerCase()) {
      throw new Error(
        "These deposit details point to a different address, so the sweep was stopped before signing.",
      )
    }
  }

  const call = (deps.build ?? buildSipaSweepCall)({
    deployed,
    sipaFactory: record.origin?.sipaFactory ?? manifest.sipaFactory,
    sipa: record.sipaAddress,
    deployArgs,
    sweepArgs: {
      token,
      relayer: deps.channel.target,
      intentData: intent.intentData,
      proofs: intent.proofs,
    },
  })

  const hash = await deps.channel.sendTransaction(call.to, call.data)
  if (!(await deps.channel.waitForReceipt(hash))) {
    throw new Error(
      `Sweep transaction ${hash} failed. A relayer may have swept this deposit first, in which case it is already on its way into your balance, or the network's deposit limit was reached. Try again later.`,
    )
  }
  // Deliberately not terminal: the funds are in the portal, not the balance. The record stays on
  // the fast scan lane, and the next sync reads this very transaction's `Sweep` event and drives
  // the claim. `sweepTxHash` on a `sweeping` record is the "submitted" marker both exits check.
  //
  // Re-read rather than echo the snapshot: a sync pass can claim the deposit while the receipt is
  // awaited, and writing `sweeping` back over `claimed` never heals — later scans short-circuit on
  // `claimedInboxIndexes` and leave the row pending forever.
  const phase = deps.store.get(record.sipaAddress)?.phase ?? "sweeping"
  await deps.store.upsert(record.sipaAddress, { phase, sweepTxHash: hash })
  return hash
}

/** The manifest fields a sweep cannot be built without. */
export function sweepManifestFrom(tuple: OxideEnvTuple): SweepManifest {
  const rollupVersion = requireTupleField(tuple, "rollupVersion")
  if (!/^\d+$/.test(rollupVersion)) {
    throw new Error(`oxide manifest has a non-numeric rollupVersion ("${rollupVersion}")`)
  }
  return {
    sipaFactory: requireTupleField(tuple, "sipaFactory") as Address,
    portal: requireTupleField(tuple, "portal") as Address,
    rollupVersion: BigInt(rollupVersion),
    token: requireTupleField(tuple, "token") as Address,
  }
}

export interface SelfSweepOptions {
  /** Required in bridge mode: the address the deposit fee is paid to. */
  destination?: Address
  /** Injected-wallet mode: pins the submitting (and tipped) account to the app's selection. */
  from?: Hex
  onHelperOpened?: (submitUrl: string) => void
  onStage?: (stage: L1ExitStage) => void
}

/**
 * Where the sweep is signed. An injected wallet both pays the gas and takes the tip; the desktop
 * launcher's Chrome profile has no wallet extension, so the prepared transaction goes to a helper
 * page in the user's default browser and the tip goes to the address they typed.
 */
export async function sweepChannel(params: {
  config: WebWalletConfig
  record: Pick<SIPADepositRecord, "sipaAddress" | "tokenSymbol" | "amount" | "netAmount" | "fee">
  /** App-owned client: the helper page's wallet is not ours to poll. */
  publicClient: PublicClient
  opts: SelfSweepOptions
}): Promise<L1ExitChannel> {
  const { config, record, opts } = params
  if (!isDesktopL1SubmitActive()) {
    return await injectedWalletChannel(config, { from: opts.from, onStage: opts.onStage })
  }
  const destination = opts.destination
  if (!destination || !isAddress(destination)) {
    throw new Error("Enter the Ethereum address that should receive the network tip.")
  }
  return desktopBridgeChannel({
    destination,
    chainId: config.l1ChainId,
    publicClient: params.publicClient,
    display: {
      title: "Finish your zk.money deposit",
      lines: [
        ["Amount", `${depositAmounts(record).grossDisplay} ${record.tokenSymbol}`],
        ["Deposit address", record.sipaAddress],
        ["Network tip to", destination],
      ],
    },
    onHelperOpened: opts.onHelperOpened,
    onStage: opts.onStage,
  })
}

/** Self-sweep `record` over whichever channel this build has. Resolves to the L1 sweep tx hash. */
export async function selfSweep(
  record: SIPADepositRecord,
  opts: SelfSweepOptions = {},
): Promise<Hex> {
  const config = getConfig()
  const publicClient = createPublicClient({ transport: l1Transport(config) })
  const tuple = await getOxideTuple(config)
  const manifest = sweepManifestFrom(tuple)
  const [implementation, cut] = await Promise.all([
    record.origin
      ? Promise.resolve(record.origin.implementation)
      : readDepositSIPAImplementation(publicClient, manifest.sipaFactory, manifest.portal),
    fpcFundingCut(publicClient, manifest.portal),
  ])
  const channel = await sweepChannel({ config, record, publicClient, opts })

  return await selfSweepDeposit(record, {
    channel,
    manifest,
    implementation,
    readDeployed: (sipa) => readSipaDeployed(publicClient, sipa),
    // A 6-dec stable on the SIPA is measured against the 18-dec DAI fee it swaps into.
    readFunding: (sipa, token) =>
      readSipaFundingStatus(publicClient, {
        sipa,
        token,
        implementation,
        fpcFundingCut: cut,
        balanceScale:
          10n ** BigInt(Math.max(DEFAULT_DECIMALS - (record.tokenDecimals ?? DEFAULT_DECIMALS), 0)),
      }),
    predict: (args) =>
      Promise.resolve(
        sipaAddressFromArgs(record.origin?.sipaFactory ?? manifest.sipaFactory, args),
      ),
    store: SIPADepositStore.get(new WebStorageAdapter()),
  })
}

/**
 * Offline create2 prediction from the viem-shaped deploy args — the deposit intent's SIPA address.
 * Mirrors `SIPAFactory.predictSIPA`, which stays the source of truth; this is the pre-deploy
 * parity check.
 */
function sipaAddressFromArgs(sipaFactory: Address, args: SipaSweepDeployArgs): Address {
  const common = {
    sipaFactory: EthAddress.fromString(sipaFactory),
    implementation: EthAddress.fromString(args.implementation),
    intentHash: Buffer.from(args.intentHash.slice(2), "hex"),
    rollupVersion: args.rollupVersion,
    resweepable: args.resweepable,
  }
  return (
    "recoveryAddress" in args
      ? computeSIPAAddress({
          ...common,
          recoveryAddress: EthAddress.fromString(args.recoveryAddress),
        })
      : computeAccountSIPAAddress({
          ...common,
          recoveryCommitment: Fr.fromString(args.recoveryCommitment),
        })
  ).toString() as Address
}

/** Whether the SIPA clone already exists on L1. */
export async function readSipaDeployed(
  publicClient: PublicClient,
  sipa: Address,
): Promise<boolean> {
  const code = await publicClient.getCode({ address: sipa })
  return !!code && code !== "0x"
}
