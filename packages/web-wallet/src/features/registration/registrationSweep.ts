import { oxideAccountPasskey } from "../../platform/auth/oxideAccountPasskey"
/**
 * Manual sweep for a funded registration deposit: the user submits the relayer's own
 * register-deploy-and-sweep for a SIPA no relayer picked up. It registers the name, pays the
 * on-chain registration fee out of the deposit (a broadcast-time waiver is honored), and bridges
 * the remainder — manual only skips the relayer, never the fee.
 *
 * Nothing extra is persisted for this path: one passkey assertion recovers the master secret, the
 * derivation is recomputed and checked against the record's address before anything is signed
 * (fail closed), and the NameClaim comes from the device cache or a claim-server re-request (see
 * `requireNameClaim`). The submission rides the same injected-wallet / desktop-bridge channel as
 * the plain deposit's self-sweep.
 */

import { createPublicClient, formatUnits, type Address, type Hex, type PublicClient } from "viem"
import { registrationFloor } from "@obsidion/core/constants"
import { EMPTY_SIGNED_TERMS, type SignedTermsArg } from "@obsidion/sdk"
import {
  buildRegistrationR1Install,
  buildRegistrationSelfSweepCall,
  createOxideL1Reader,
  createRegistrationSipaDeriver,
  deriveRecordedRegistrationSipa,
  signAccountDigest,
  deriveBootstrapKey,
  consentDigest,
  readSipaFunding,
  settledBalance,
  type AddressScreener,
  type OxideL1Reader,
  type OxideRegistrationEnv,
  type PendingRegistrationRecord,
  type RegistrationSipaDeriver,
  type RegistrationStore,
  type SipaDeposits,
  type SipaFundingToken,
  type SipaProcessingState,
  type SipaSweepSubject,
} from "@obsidion/front-core"
import type { OxideEnvTuple, RegistrationSchedule } from "@obsidion/core/types"
import { WalletError, bestEffort } from "@obsidion/core/errors"
import { getConfig, l1Transport } from "../../config/env"
import { getFeeTokenBridgeTuple, oxideEnvFor, requireTupleField } from "../../config/oxideTuple"
import {
  assertSweepCapacity,
  readSipaDeployed,
  revertedSweepError,
  submitSweep,
  sweepManifestFrom,
} from "../sipa/sipaSweep"
import { sipaFundingTokens } from "../sipa/loadDepositFacts"
import {
  desktopBridgeChannel,
  injectedWalletChannel,
  type L1ExitChannel,
  type L1ExitStage,
} from "../sipa/l1ExitChannels"
import { isDesktopL1SubmitActive } from "../../platform/desktopBridge"
import { txAmountCap } from "../token/oxideToken"
import { readRegistrationSchedule } from "./registrationTerms"
import { requireNameClaim } from "./nameClaim"
import { seededRegistrationSalt } from "./registrationDepositSeed"
import type { OnboardingKeys } from "../../session/account"
import type { Session } from "../../session/session"

/** A blocked verdict throws Predicate's own reason, stopping the sweep before signing. */
export async function assertScreened(
  screen: AddressScreener["screen"] | undefined,
  address: Address,
): Promise<void> {
  if (!screen) return
  const verdict = await screen(address)
  if (verdict.compliant) return
  const reason = verdict.reason?.message
  throw reason
    ? new WalletError("sweep.addressRefused", reason, { data: { reason } })
    : new WalletError("sweep.addressBlocked")
}

export interface ManualRegistrationSweepOptions {
  /** Recovered account keys — the caller runs the passkey assertion so the prompt has UI context. */
  keys: Pick<OnboardingKeys, "secretKey" | "account">
  /** Bridge mode: the address the deposit fee is paid to. */
  destination?: Address
  /** Injected-wallet mode: pins the submitting account. */
  from?: Hex
  /** Screens the paid address once the channel resolves it; a blocked verdict stops the sweep before signing. */
  screen?: AddressScreener["screen"]
  onHelperOpened?: (submitUrl: string) => void
  onStage?: (stage: L1ExitStage) => void
  /** Progress the sweep makes before it reaches a channel stage, such as waiting out a name-claim refusal. */
  onNotice?: (message: string) => void
}

type OwnedArgs<F> = F extends (own: never, ...rest: infer A) => unknown ? A : never

/** What a sweep reads and writes beside the record and the keys. */
export interface RegistrationSweepDeps {
  env: OxideRegistrationEnv
  tuple: OxideEnvTuple
  client: PublicClient
  reader: OxideL1Reader
  derive: RegistrationSipaDeriver
  claim(...args: OwnedArgs<typeof requireNameClaim>): ReturnType<typeof requireNameClaim>
  /** The controller's own schedule. */
  schedule(): Promise<RegistrationSchedule>
  /** The fee token portal's per-transaction cap. */
  cap(): Promise<bigint>
  /** Every token the address accepts, the registration token first. */
  tokens(): Promise<[SipaFundingToken, ...SipaFundingToken[]]>
  /** Why the address's sweep would wait, read now. */
  capacity(live: Omit<SipaSweepSubject, "sipaAddress">): Promise<SipaProcessingState | undefined>
  channel(): Promise<L1ExitChannel>
  registrations: Pick<RegistrationStore, "apply">
  sipaDeposits: Pick<SipaDeposits, "get" | "apply">
}

/** `runRegistrationSweep` over this browser's deployment, L1 reads and exit channel. */
export async function manualRegistrationSweep(
  own: Pick<
    Session,
    "registrations" | "sipaDeposits" | "nameClaims" | "sipaProcessingObserver" | "signup"
  >,
  record: PendingRegistrationRecord,
  opts: ManualRegistrationSweepOptions,
): Promise<Hex> {
  const config = getConfig()
  const { tuple, env, publicClient } = await oxideEnvFor(config)
  return runRegistrationSweep(
    {
      env,
      tuple,
      client: publicClient,
      reader: createOxideL1Reader(publicClient),
      derive: createRegistrationSipaDeriver({ publicClient, env, tuple }),
      claim: (...args) => requireNameClaim(own, ...args),
      schedule: () => readRegistrationSchedule(config),
      cap: () =>
        getFeeTokenBridgeTuple(config).then((fee) =>
          txAmountCap(publicClient, requireTupleField(fee, "portal") as Address),
        ),
      tokens: () => sipaFundingTokens(config, record.depositToken as Address, "registration"),
      capacity: (live) =>
        own.sipaProcessingObserver?.refreshForSweep(record.sipaAddress, live) ??
        Promise.resolve(undefined),
      channel: () =>
        registrationSweepChannel(
          record,
          createPublicClient({ transport: l1Transport(config) }),
          opts,
        ),
      registrations: own.registrations,
      sipaDeposits: own.sipaDeposits,
    },
    record,
    opts,
  )
}

/**
 * Re-derive, guard, and submit the registration sweep for `record`. Resolves to the L1 tx hash;
 * the record gets `sweepTxHash` stamped and the detection tick confirms from the Sweep event as
 * usual — this path never writes `sweptAt` itself.
 */
export async function runRegistrationSweep(
  deps: RegistrationSweepDeps,
  record: PendingRegistrationRecord,
  opts: ManualRegistrationSweepOptions,
): Promise<Hex> {
  const { env, tuple, client: publicClient } = deps
  const derivation = await deriveRecordedRegistrationSipa(
    deps.derive,
    {
      owner: record.account as Address,
      nameHash: record.nameHash as Hex,
      l2Address: record.l2Address as Hex,
      fee: BigInt(record.fee),
      beneficiary: record.beneficiary as Address,
      masterSecret: opts.keys.secretKey,
    },
    record.sipaAddress as Address,
    seededRegistrationSalt(deps.sipaDeposits),
  )
  if (derivation.sipaAddress.toLowerCase() !== record.sipaAddress.toLowerCase()) {
    throw new WalletError("registration.sweepAddressMismatch")
  }

  // Read before the claim: the controller's own fee is what tells a terms-less cached claim apart
  // from one that cannot price this address, so it decides whether the service is asked at all.
  const controllerSchedule = await bestEffort("unknown", deps.schedule())
  const claim = await deps.claim(record, opts.keys, {
    onNotice: opts.onNotice,
    controllerFee: controllerSchedule?.fee,
  })

  const schedule = claim.terms
    ? { fee: BigInt(claim.terms.fee), min: BigInt(claim.terms.minDeposit) }
    : controllerSchedule
  const priced = schedule !== undefined && schedule.fee === BigInt(record.fee)
  const floor = priced ? registrationFloor(schedule) : undefined
  // The pre-flight checks the same cap the sweep enforces, the fee token row's, so an unread cap signs nothing.
  const cap = await bestEffort("registration.capUnread", deps.cap())
  // The SIPA swaps whichever accepted token it holds into the fee token at sweep time, and the
  // controller floors what lands, so a swapped deposit is judged on the least the swap may settle.
  const tokens = await deps.tokens()
  const covers = (balance: bigint, sent: SipaFundingToken) =>
    floor !== undefined && settledBalance(tokens[0], sent, balance) >= floor
  const fee = BigInt(record.fee)
  const { token, status } = await readSipaFunding(publicClient, {
    sipa: record.sipaAddress as Address,
    routes: tokens.map((sent) => ({
      token: sent,
      settlesIn: tokens[0],
      fee,
      txAmountCap: cap ?? 0n,
    })),
    accepted: floor === undefined ? undefined : covers,
    decided: floor !== undefined && cap !== undefined,
  })
  if (status.balance === 0n) throw new WalletError("deposit.alreadySwept")
  if (!priced) {
    // A signed schedule naming another fee is the price this address is shut out of for good: only
    // a recovery frees the funds. A claim that carried none fell back to the deployment's own
    // figures, and a re-signed one may yet price it.
    throw new WalletError(
      claim.terms ? "registration.priceCommitted" : "registration.quoteUnusable",
    )
  }
  if (cap === undefined) {
    throw new WalletError("registration.capUnread")
  }
  if (!covers(status.scaledBalance, token)) {
    throw new WalletError("registration.depositShort")
  }
  // The rail can lag this balance or lack the record; the re-derived address pins its origin. The
  // amount is in the token the SIPA holds, which may not be the fee token.
  const live: Omit<SipaSweepSubject, "sipaAddress"> = {
    l1ChainId: record.l1ChainId,
    origin: derivation.origin,
    phase: "funded",
    amount: formatUnits(status.balance, token.decimals),
    tokenAddress: token.address,
    tokenDecimals: token.decimals,
    intent: "registration",
    registrationFee: record.fee,
  }
  const checkCapacity = () => deps.capacity(live)
  await assertSweepCapacity(checkCapacity)

  // The controller resolves the metadata registry off the NameRegistry at sweep time, and checks
  // the committed SIPA against its own caller, so both are read the same way the sweep will.
  const { reader } = deps
  const bootstrap = deriveBootstrapKey(opts.keys.secretKey)
  const consentSig = await signAccountDigest({
    account: record.account as Address,
    chainId: env.l1ChainId,
    bootstrap,
    reader,
    passkey: await oxideAccountPasskey(opts.keys.account.getAuthProvider()),
    hash: consentDigest(
      derivation.recordData,
      env.l1ChainId,
      await reader.readAccountMetadataRegistry(env.registry),
      record.sipaAddress as Address,
    ),
  })
  const signedTerms: SignedTermsArg = claim.terms
    ? {
        fee: BigInt(claim.terms.fee),
        minDeposit: BigInt(claim.terms.minDeposit),
        nonce: BigInt(claim.terms.nonce),
        deadline: BigInt(claim.terms.deadline),
        signature: claim.terms.signature as Hex,
      }
    : EMPTY_SIGNED_TERMS

  if (!record.r1Key || !record.credentialId) {
    throw new WalletError(
      "invariant",
      "pending registration record lacks the passkey to install — cannot sweep",
    )
  }
  const r1Install = await buildRegistrationR1Install(
    opts.keys.secretKey,
    record.account as Address,
    env,
    reader,
    record.r1Key,
    record.credentialId,
  )

  const channel = await deps.channel()
  await assertScreened(opts.screen, channel.target)
  const manifest = sweepManifestFrom(tuple)
  const deployed = await readSipaDeployed(publicClient, record.sipaAddress as Address)
  const call = buildRegistrationSelfSweepCall(
    {
      sipaAddress: record.sipaAddress as Address,
      sipaArgs: derivation.sipaArgs,
      registrationData: derivation.registrationData,
      consentSig,
      bootstrap: bootstrap.address,
      domainAuth: {
        nonce: BigInt(claim.nonce),
        deadline: BigInt(claim.deadline),
        signature: claim.signature as Hex,
      },
      signedTerms,
      r1Install,
    },
    {
      deployed,
      relayer: channel.target,
      manifest: {
        sipaFactory: manifest.sipaFactory,
        token: token.address,
      },
    },
  )

  const hash = await submitSweep(channel, call.to, call.data)
  if (!(await channel.waitForReceipt(hash))) {
    const state = await bestEffort("unknown", checkCapacity())
    throw revertedSweepError(hash, state, [
      "registration.sweepReverted",
      "registration.sweepRevertedCapacity",
    ])
  }
  // The receipt is authoritative: the detection tick and the rail's sync loop reconcile from the
  // Sweep event, so a failed local stamp must not report a landed sweep as failed. The rail stamp
  // clears the stuck-sweep affordance on the deposit surface too.
  try {
    await deps.registrations.apply(record.sipaAddress, { type: "swept", txHash: hash })
    await deps.sipaDeposits.apply(record.sipaAddress, { type: "sweepSent", txHash: hash })
  } catch (err) {
    console.warn("[registrationSweep] sweep landed but the local stamp failed", err)
  }
  return hash
}

/** Same channel split as the plain self-sweep: injected wallet, or the desktop helper page. */
async function registrationSweepChannel(
  record: PendingRegistrationRecord,
  publicClient: PublicClient,
  opts: ManualRegistrationSweepOptions,
): Promise<L1ExitChannel> {
  const config = getConfig()
  if (!isDesktopL1SubmitActive()) {
    return await injectedWalletChannel(config, { from: opts.from, onStage: opts.onStage })
  }
  if (!opts.destination) {
    throw new WalletError("sweep.tipDestinationMissing")
  }
  return desktopBridgeChannel({
    destination: opts.destination,
    chainId: config.l1ChainId,
    publicClient,
    display: {
      title: "Register your zk.money name",
      lines: [
        ["Name", `${record.tag}.zk.money`],
        ["Deposit address", record.sipaAddress],
        ["Network tip to", opts.destination],
      ],
    },
    onHelperOpened: opts.onHelperOpened,
    onStage: opts.onStage,
  })
}
