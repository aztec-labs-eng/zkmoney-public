import { oxideAccountPasskey } from "../../../platform/auth/oxideAccountPasskey"
/**
 * The `recoverERC20` / `recoverETH` exit in the browser: pulls a SIPA deposit the sweep path can
 * never move back out to an L1 address the user controls. front-core's `runSipaRecovery` owns the key derivation,
 * the signature and the store write; this file supplies the browser collaborators — an L1
 * submission channel and the pre-submit balance read that stops a recovery from settling a record
 * it never moved.
 */
import {
  erc20Abi,
  formatUnits,
  isAddress,
  type Address,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
} from "viem"
import {
  bestEffort,
  claimRefusalReason,
  createRegistrationSipaDeriver,
  depositAmounts,
  isNameBlocked,
  isNameReserved,
  deriveStealthKey,
  isStuckSweep,
  deriveBootstrapKey,
  createOxideL1Reader,
  signAccountDigest,
  runSipaRecovery,
  STUCK_SWEEP_MS,
  sipaDeployArgCandidates,
  type RegistrationRecovery,
  type SipaDeposit,
  type SipaDeposits,
  type SipaRecoverCandidate,
  type SipaRecoveryDeps,
  isNativeEth,
  NATIVE_ETH,
  type SipaFundingToken,
} from "@obsidion/front-core"
import {
  predictAccountAddress,
  encodeAccountInitCode,
  detectHistoricDeployments,
  readDepositSIPAImplementation,
} from "@obsidion/sdk"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { WalletError } from "@obsidion/core/errors"
import { getConfig, type WebWalletConfig } from "../../../config/env"
import {
  getOxideTuple,
  l1PublicClient,
  oxideEnvFor,
  requireTupleField,
} from "../../../config/oxideTuple"
import {
  healRegistrationDeposits,
  type RegistrationSeedStores,
} from "../../registration/registrationDepositSeed"
import {
  registrationCandidates,
  seedRegistrationCandidates,
} from "../../registration/registrationRederive"
import { registrationRecordForSipa } from "../../registration/webRegistration"
import { isDesktopL1SubmitActive } from "../../../platform/desktopBridge"
import { fmt } from "../../../lib/fmt"
import { session } from "../../../session/session"
import { EmptyDepositError } from "../depositReadErrors"
import { emptiedError, readSipaDeployed } from "../../sipa/sipaSweep"
import { predictSipaCandidate } from "../sipaPredict"
import { loadSourceGeneration, retiredRollupMajor } from "../../../platform/sourceGeneration"
import { findPreviousVersionDeposit } from "./previousVersionSipa"
import { findFrozenDeposit, type FrozenDeposit } from "./frozenDepositRefund"
import { recoveryProbeTokens } from "../../sipa/loadDepositFacts"
import {
  desktopBridgeChannel,
  injectedWalletChannel,
  type L1ExitChannel,
  type L1ExitStage,
} from "../../sipa/l1ExitChannels"
import copy from "./sipaRecovery.copy"

/** The stuck-sweep clock the activity feed and both exits share. */
export { isStuckSweep, STUCK_SWEEP_MS }

export interface RecoveryDeps {
  channel: L1ExitChannel
  chainId: number
  /** Every token any row of the table accepts, the manifest token first. */
  tokens: [SipaFundingToken, ...SipaFundingToken[]]
  readBalance: (sipa: Address, token: Address) => Promise<bigint>
  readEthBalance: (sipa: Address) => Promise<bigint>
  /** A confirmed recovery's receipt, for what it moved. */
  readReceipt: (hash: Hex) => Promise<TransactionReceipt>
  /** Deploy capability for an undeployed SIPA (see `SipaRecoveryDeps.deployment`). */
  deployment: SipaRecoveryDeps["deployment"]
  store: Pick<SipaDeposits, "apply">
  /** Remembers a recovery of a registration's token as its refund. */
  refunds: Pick<RegistrationRecovery, "confirmed">
  stealthKey: () => Promise<SipaRecoveryDeps["stealthKey"]>
  signAccount?: SipaRecoveryDeps["signAccount"]
  accountInitCode?: Hex
  /**
   * A token the person names in Settings, recovered with the others. A settled record keeps its
   * history: the recovery writes nothing to it or to its registration.
   */
  stranded?: SipaFundingToken
  /** Injectable for tests. */
  run?: typeof runSipaRecovery
}

/**
 * Guard the recovery, then run it. It moves every token that has a balance when it is read, so no
 * sweep has to move a token left at an address the recovery deploys. A token without a balance is
 * left out, because its recovery call reverts on the empty balance.
 */
export async function recoverSipaDeposit(record: SipaDeposit, deps: RecoveryDeps): Promise<Hex> {
  if (!record.messageSecret) throw new WalletError("recovery.detailsPending")
  const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  // A record naming a token off the list (a historic deployment's) is read too.
  const named = record.tokenAddress
  const erc20s: SipaFundingToken[] = [...deps.tokens]
  const addToken = (t: SipaFundingToken) => {
    if (!isNativeEth(t.address) && !erc20s.some((e) => same(e.address, t.address))) erc20s.push(t)
  }
  if (named)
    addToken({
      address: named,
      symbol: record.tokenSymbol ?? "",
      decimals: record.tokenDecimals ?? deps.tokens[0].decimals,
    })
  const stranded = deps.stranded
  if (stranded) addToken(stranded)
  const account = record.origin?.protocol === "account"
  const listed = account ? [...erc20s, NATIVE_ETH] : erc20s
  const balances = await Promise.all(
    listed.map((t) =>
      isNativeEth(t.address)
        ? deps.readEthBalance(record.sipaAddress)
        : deps.readBalance(record.sipaAddress, t.address),
    ),
  )
  const held = listed.filter((_, i) => balances[i]! > 0n)
  if (stranded && !held.some((t) => same(t.address, stranded.address))) {
    throw new WalletError("recovery.strandedEmpty", undefined, {
      data: { symbol: stranded.symbol },
    })
  }
  const token = held.find((t) => named && same(t.address, named)) ?? held[0]
  if (!token) {
    if (isNativeEth(named))
      throw new WalletError(account ? "recovery.noEth" : "recovery.ethUnsupported")
    throw emptiedError(!!named)
  }
  const moved =
    named && same(token.address, named)
      ? record
      : {
          ...record,
          tokenAddress: token.address,
          tokenSymbol: token.symbol,
          tokenDecimals: token.decimals,
        }
  const others = held.filter((t) => t !== token).map((t) => t.address)
  // Checked at each write: a sync can settle the record while the recovery is signed.
  let kept = false
  const store: RecoveryDeps["store"] = stranded
    ? {
        async apply(sipa, event) {
          const unsettled = event.type === "recoverySent" ? { ...event, ifUnsettled: true } : event
          const next = await deps.store.apply(sipa, unsettled)
          kept ||= !next
          return next
        },
      }
    : deps.store
  const hash = await runRecovery(moved, [token.address, ...others], { ...deps, store })
  if (kept) return hash
  const refunded = (held.find((t) => !isNativeEth(t.address)) ?? token).address
  await bestEffort(
    "unknown",
    deps.refunds.confirmed(record.sipaAddress, refunded, hash, deps.readReceipt),
  )
  return hash
}

async function runRecovery(
  record: SipaDeposit,
  tokens: [Address, ...Address[]],
  deps: RecoveryDeps,
) {
  return await (deps.run ?? runSipaRecovery)({
    record,
    stealthKey: await deps.stealthKey(),
    signAccount: deps.signAccount,
    accountInitCode: deps.accountInitCode,
    target: deps.channel.target,
    tokens,
    chainId: deps.chainId,
    deployment: deps.deployment,
    sendTransaction: deps.channel.sendTransaction,
    waitForReceipt: deps.channel.waitForReceipt,
    store: deps.store,
  })
}

/** The user's stealth keypair; unavailable while the session is locked. */
async function webStealthKey(): Promise<SipaRecoveryDeps["stealthKey"]> {
  const msk = await session().auth.getSecretKey()
  if (!msk) throw new WalletError("account.unlockWithPasskey")
  return deriveStealthKey(msk)
}

export interface RecoverDepositOptions {
  /** Required in bridge mode: where the recovered funds go. */
  destination?: Address
  /** Injected-wallet mode: pins the submitting (and receiving) account to the app's selection. */
  from?: Hex
  onHelperOpened?: (submitUrl: string) => void
  onStage?: (stage: L1ExitStage) => void
  stranded?: RecoveryDeps["stranded"]
}

/** Recover `record` over whichever channel this build has. Resolves to the L1 recovery tx hash. */
export async function recoverDeposit(
  record: SipaDeposit,
  opts: RecoverDepositOptions = {},
): Promise<Hex> {
  const config = getConfig()
  if (record.l1ChainId !== config.l1ChainId) throw new WalletError("recovery.wrongChain")
  const publicClient = l1PublicClient(config)
  const tuple = await getOxideTuple(config)
  const token = requireTupleField(tuple, "token") as Address

  let channel: L1ExitChannel
  if (isDesktopL1SubmitActive()) {
    const destination = opts.destination
    if (!destination || !isAddress(destination)) {
      throw new WalletError("recovery.destinationMissing")
    }
    channel = desktopBridgeChannel({
      destination,
      chainId: config.l1ChainId,
      publicClient,
      display: {
        title: copy.helper.title,
        lines: [
          [
            copy.helper.amount,
            opts.stranded
              ? fmt(copy.helper.strandedAmount, { symbol: opts.stranded.symbol })
              : fmt(copy.helper.depositAmount, {
                  amount: depositAmounts(record).grossDisplay,
                  symbol: record.tokenSymbol,
                }),
          ],
          [copy.helper.depositAddress, record.sipaAddress],
          [copy.helper.recoveredTo, destination],
        ],
      },
      onHelperOpened: opts.onHelperOpened,
      onStage: opts.onStage,
    })
  } else {
    channel = await injectedWalletChannel(config, { from: opts.from, onStage: opts.onStage })
  }

  const keys = await session().auth.sessionKeys()
  if (!keys) throw new WalletError("recovery.locked")
  const bootstrap = deriveBootstrapKey(keys.secretKey)
  const passkey = await oxideAccountPasskey(keys.authProvider)
  const reader = createOxideL1Reader(publicClient)
  let accountInitCode: Hex | undefined
  if (record.origin?.protocol === "account") {
    const predicted = await predictAccountAddress(
      publicClient,
      record.origin.accountFactory,
      bootstrap.address,
    )
    if (predicted.toLowerCase() !== record.origin.recoveryAccount.toLowerCase())
      throw new WalletError("recovery.keysMismatch")
    const code = await reader.getCode(predicted)
    if (!code || code === "0x")
      accountInitCode = encodeAccountInitCode(record.origin.accountFactory, bootstrap.address)
  }

  const { sipaDeposits, registrationRecovery } = session()
  return await recoverSipaDeposit(record, {
    channel,
    chainId: config.l1ChainId,
    tokens: await recoveryProbeTokens(config, token),
    readBalance: (sipa, token) =>
      publicClient.readContract({
        address: token,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [sipa],
      }),
    readEthBalance: (address) => publicClient.getBalance({ address }),
    readReceipt: (hash) => publicClient.getTransactionReceipt({ hash }),
    deployment: await recoveryDeployment(publicClient, record, tuple),
    store: sipaDeposits,
    refunds: registrationRecovery,
    stealthKey: webStealthKey,
    accountInitCode,
    stranded: opts.stranded,
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
  record: SipaDeposit,
  tuple: OxideEnvTuple,
): Promise<SipaRecoveryDeps["deployment"]> {
  const readDeployed = (sipa: Address) => readSipaDeployed(publicClient, sipa)
  const predict: SipaRecoveryDeps["deployment"]["predict"] = (candidate) =>
    predictSipaCandidate(publicClient, candidate)
  const origin = record.origin
  // Another generation's factory takes its own args, so only that generation encodes the deploy.
  const major =
    origin?.protocol === "account" && record.networkId
      ? await retiredRollupMajor(record.networkId)
      : undefined
  if (origin?.protocol === "account" && major) {
    const deployCall = (await loadSourceGeneration(major)).encodeSipaDeploy(origin) as Hex
    return {
      readDeployed,
      candidates: [{ protocol: "account", sipaFactory: origin.sipaFactory, deployCall }],
      predict,
    }
  }
  const deployments: Parameters<typeof sipaDeployArgCandidates>[1] = []
  if (!record.origin) {
    const config = getConfig()
    const { historic } = await detectHistoricDeployments({
      ...config.oxideProfile,
      network: config.network,
      publicClient,
      sourcePortals: new Set(config.sourceRollupNodes?.keys()),
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
        (await readDepositSIPAImplementation(publicClient, candidate.sipaFactory as Address).catch(
          () => undefined,
        ))
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
    readDeployed,
    candidates: [
      ...sipaDeployArgCandidates(record, deployments),
      ...(registration ? [registration] : []),
    ],
    predict,
  }
}

/**
 * The CREATE2 args of a registration SIPA, or null for a plain deposit. A registration SIPA
 * commits to the registration intent (registration implementation, non-resweepable), which the
 * pending record does not persist — it is re-derived from the unlocked master secret.
 */
async function registrationCandidate(record: SipaDeposit): Promise<SipaRecoverCandidate | null> {
  const pending = registrationRecordForSipa(session().registrations, record.sipaAddress)
  // Legacy records lack the payment committed into the address; do not substitute a current quote.
  if (!pending || pending.fee === undefined || pending.beneficiary === undefined) return null
  const msk = await session().auth.getSecretKey()
  if (!msk) throw new WalletError("account.unlockWithPasskey")
  const config = getConfig()
  const { tuple, env, publicClient } = await oxideEnvFor(config)
  const derive = createRegistrationSipaDeriver({
    publicClient,
    env,
    tuple,
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

/** What the Settings recovery needs for a token stranded at one of this wallet's deposit addresses. */
export interface StrandedToken {
  record: SipaDeposit
  token: SipaFundingToken
  balance: string
}

/** A previous version's deposit address whose sweep waits in that version's frozen portal. */
export interface StrandedFrozenDeposit {
  record: SipaDeposit
  frozen: FrozenDeposit
}

/** `previousVersion` also looks on the previous Aztec generation, as this account. */
export async function readStrandedToken(
  sipa: Address,
  token: Address,
  networkId: string,
): Promise<StrandedToken>
export async function readStrandedToken(
  sipa: Address,
  token: Address,
  networkId: string,
  previousVersion: boolean,
): Promise<StrandedToken | StrandedFrozenDeposit>
export async function readStrandedToken(
  sipa: Address,
  token: Address,
  networkId: string,
  previousVersion = false,
): Promise<StrandedToken | StrandedFrozenDeposit> {
  const config = getConfig()
  const own = session()
  const stored = async () => (await own.sipaDeposits.get(sipa)) ?? null
  // A registration address has a deposit record only once one is seeded: from this device's
  // registration record, else re-derived from the master secret and the wallet's name.
  const ok = () => true
  const failed = () => false
  const healed = await healRegistrationDeposits(own, config, networkId).then(ok, failed)
  let record = await stored()
  const rederived =
    record !== null ||
    (await rederiveRegistrationDeposit(own, config, networkId, sipa).then(ok, failed))
  if (!record) record = await stored()
  if (!record && previousVersion) {
    await findPreviousVersionDeposit(sipa).catch((error: unknown) => {
      console.warn("[sipaRecovery] previous version lookup failed:", error)
      throw new WalletError("recovery.previousVersionUnreadable")
    })
    record = await stored()
  }
  if (!record) {
    throw new WalletError(
      !(healed && rederived)
        ? "recovery.addressesUnchecked"
        : previousVersion
        ? "recovery.noDepositAnyVersion"
        : "recovery.noDeposit",
    )
  }
  if (record.l1ChainId !== config.l1ChainId) {
    throw new WalletError("recovery.otherNetwork")
  }
  if (!record.messageSecret) {
    throw new WalletError("recovery.detailsPendingRetry")
  }
  const client = l1PublicClient(config)
  const erc20 = { address: token, abi: erc20Abi } as const
  const balance = await client
    .readContract({ ...erc20, functionName: "balanceOf", args: [sipa] })
    .catch(() => {
      throw new WalletError("recovery.notErc20")
    })
  if (balance === 0n) {
    const frozen = previousVersion ? await findFrozenDeposit(record) : null
    if (frozen) return { record, frozen }
    throw new EmptyDepositError()
  }
  const [symbol, decimals] = await Promise.all([
    client
      .readContract({ ...erc20, functionName: "symbol" })
      .catch(() => copy.stranded.unknownSymbol),
    client.readContract({ ...erc20, functionName: "decimals" }).catch(() => undefined),
  ])
  // Recovery needs only the address; without decimals the amount cannot be shown, so it reads "All".
  return {
    record,
    token: { address: token, symbol, decimals: decimals ?? 18 },
    balance: decimals === undefined ? copy.stranded.unknownBalance : formatUnits(balance, decimals),
  }
}

/**
 * Seeds this wallet's registration addresses, as on a device with no registration record. A claim's
 * fee is the last try for `sipa`; a refused claim means this name's address is not found.
 */
async function rederiveRegistrationDeposit(
  own: RegistrationSeedStores,
  config: WebWalletConfig,
  networkId: string,
  sipa: Address,
) {
  const identity = own.identity.get().value
  const secret = await own.auth.getSecretKey()
  if (!identity?.handle || !secret) return
  const l2Address = identity.address as Hex
  const c = await registrationCandidates(
    config,
    networkId,
    secret,
    identity.handle,
    l2Address,
    own.sipaDeposits,
  )
  const seeded = await seedRegistrationCandidates(c)
  if (seeded.some((a) => a.toLowerCase() === sipa.toLowerCase())) return
  const claim = await c.deps.accountService
    .signDomain({ nameHash: c.nameHash, userAddress: c.owner })
    .catch((err: unknown) => {
      if (isNameReserved(err) || isNameBlocked(err)) return undefined
      if (claimRefusalReason(err) === "name_registered") return undefined
      throw err
    })
  const fee = claim?.terms ? BigInt(claim.terms.fee) : undefined
  if (fee !== undefined && !c.fees.includes(fee)) await seedRegistrationCandidates(c, [fee])
}
