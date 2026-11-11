/**
 * Resolver payments, found and published by the wallet.
 *
 * A sender who pays a tag through the ENS resolver funds an address the resolver derived for one
 * `(day, nonce)`: an ECDH salt between the resolver's key and the account's registered stealth key,
 * where `day` is the L1 block's UTC day and the nonce counts up from 0 per account and day, one per
 * resolve. The ECDH is symmetric, so the wallet derives the same addresses from its own key. The
 * scan reads the ones the resolver could have handed out, records a funded one as an incoming
 * deposit and owes its broadcast: the resolver does not publish the addresses it hands out.
 *
 * The record carries the salt and the full origin, so the pipeline claims and publishes it like any
 * other, and the event its broadcast sends is pinned to it by salt rather than recorded again.
 */

import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"
import { formatUnits, type Address, type Hex, type PublicClient } from "viem"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  buildDepositIntent,
  deriveSelfSipaSecret,
  epochDay,
  readAccountResolution,
  readDepositSIPAImplementation,
  selfSipaNonce,
} from "@obsidion/sdk"
import { logger } from "../utils/logger"

import { computeAccountSIPAAddress } from "../core/services/deposits/sipa/sipaAddress"
import {
  computeStealthRecipientHash,
  deriveSharedSecret,
  type SipaK1Point,
} from "../core/services/deposits/sipa/stealth"
import type { SipaDeposit, SipaDepositFields } from "../engine/sipaDeposits"
import { NATIVE_ETH, type SipaFundingToken } from "./sipaFunding"

/**
 * Unused nonces watched past the highest one in use. Every resolve takes a nonce, paid or not (a
 * sender's wallet can resolve the name several times before it sends), so the window has to reach
 * past a few unpaid ones.
 */
export const RESOLVER_NONCE_LOOKAHEAD = 15

/** Nonces per day the window ever reaches; bounds derivation and the call size. */
export const RESOLVER_MAX_NONCES_PER_DAY = 60

/** Chain days the window reads, today included. A payment older than that has no record. */
export const RESOLVER_LOOKBACK_DAYS = 24

/** The oxide gateway resolves every name to a resweepable address. */
const RESOLVER_RESWEEPABLE = true

const DAY_MS = 86_400_000

/** A deployment an address of this account's commits to. */
export interface SipaDeployment {
  portal: Address
  sipaFactory: Address
  /** The ForwardingTable every address the resolver hands out commits to. */
  forwardingTable: Address
  /** The factory's deposit implementation, which every address the resolver hands out clones. */
  implementation: Address
  /** The rollup version the account's user record names. */
  rollupVersion: bigint
  /** The account the name registry records, which the recovery commitment binds. */
  recoveryAccount: Address
  accountFactory: Address
  /** Tokens a SIPA on this deployment is swept in, the credited one first. */
  tokens: readonly SipaFundingToken[]
}

/** A deployment whose resolver can hand out this account's addresses. */
export interface ResolverDeployment extends SipaDeployment {
  /** The resolver operator's key, the ECDH counterparty. */
  resolverPublicKey: SipaK1Point
}

/** The pinned deployment the wallet hands out its own addresses on, if they bind a recovery account. */
export function selfDeployment(
  tuple: OxideEnvTuple,
  implementation: Address,
  recoveryAccount: Address,
  tokens: readonly SipaFundingToken[],
): SipaDeployment | undefined {
  const { forwardingTable, accountFactory } = tuple
  if (tuple.sipaRecoveryProtocol !== "account" || !forwardingTable || !accountFactory) return
  return {
    portal: tuple.portal as Address,
    sipaFactory: tuple.sipaFactory as Address,
    forwardingTable: forwardingTable as Address,
    accountFactory: accountFactory as Address,
    implementation,
    rollupVersion: BigInt(tuple.rollupVersion),
    recoveryAccount,
    tokens,
  }
}

/** A profile deployment the resolver might serve, with the tokens its SIPAs take. */
export interface ResolverDeploymentSource {
  tuple: OxideEnvTuple
  tokens: readonly [SipaFundingToken, ...SipaFundingToken[]]
}

const sameKey = (a: SipaK1Point, b: SipaK1Point) => a.x === b.x && a.y === b.y

/**
 * The deployments whose resolver can hand out addresses for `recoveryAccount`: per metadata
 * registry, the account's user record names one operator, and that operator's forwarding table is
 * the only one its addresses route through. Read the way the resolver gateway reads them, so the derivation
 * agrees with it. A record bound to another key or L2 account derives addresses this wallet could
 * never claim, so it is skipped.
 */
export async function readResolverDeployments(deps: {
  publicClient: PublicClient
  sources: readonly ResolverDeploymentSource[]
  recoveryAccount: Address
  recipient: AztecAddress
  stealthPublicKey: SipaK1Point
}): Promise<ResolverDeployment[]> {
  const registries = [
    ...new Set(
      deps.sources.flatMap((s) =>
        s.tuple.accountMetadataRegistry ? [s.tuple.accountMetadataRegistry.toLowerCase()] : [],
      ),
    ),
  ] as Address[]
  const out: ResolverDeployment[] = []
  for (const registry of registries) {
    const resolution = await readAccountResolution(
      deps.publicClient,
      registry,
      deps.recoveryAccount,
    )
    if (!resolution) continue
    if (
      !sameKey(resolution.publicKey, deps.stealthPublicKey) ||
      resolution.l2Address.toLowerCase() !== deps.recipient.toString().toLowerCase()
    ) {
      logger.warn(`[resolverPayments] the user record in ${registry} is bound to another key`)
      continue
    }
    const table = resolution.operator.forwardingTable.toLowerCase()
    const source = deps.sources.find((s) => s.tuple.forwardingTable?.toLowerCase() === table)
    const { sipaFactory, accountFactory } = source?.tuple ?? {}
    if (!source || !sipaFactory || !accountFactory) {
      logger.warn(`[resolverPayments] the resolver routes through ${table}, outside this profile`)
      continue
    }
    if (out.some((d) => d.forwardingTable.toLowerCase() === table)) continue
    out.push({
      portal: source.tuple.portal as Address,
      sipaFactory: sipaFactory as Address,
      forwardingTable: source.tuple.forwardingTable as Address,
      implementation: await readDepositSIPAImplementation(
        deps.publicClient,
        sipaFactory as Address,
      ),
      rollupVersion: resolution.rollupVersion,
      resolverPublicKey: resolution.operator.resolverPublicKey,
      recoveryAccount: deps.recoveryAccount,
      accountFactory: accountFactory as Address,
      tokens: source.tokens,
    })
  }
  return out
}

/** The wallet keys a derivation needs. */
export interface ResolverPaymentKeys {
  /** The registered stealth scalar (`deriveStealthKey(masterSecret).scalar`). */
  stealthScalar: bigint
  /** The wallet-only key its own addresses' salts hash from (`deriveSelfSipaKey`). */
  selfSipaKey: Fr
  recipient: AztecAddress
}

/**
 * How a window numbers a day's addresses and salts them, the `resweepable` flag their CREATE2
 * commits to, and how far past the last used slot it looks.
 */
export interface SipaSlots<D extends SipaDeployment> {
  salt(deployment: D, keys: ResolverPaymentKeys, day: number, nonce: number): Fr
  nonce(slot: number): number
  resweepable: boolean
  lookahead: number
  /** Slots a day ever reaches; bounds derivation and the call size. */
  perDay: number
}

/** The resolver's: an ECDH salt, nonces counting up from 0. */
export const RESOLVER_SLOTS: SipaSlots<ResolverDeployment> = {
  salt: (d, keys, day, nonce) =>
    deriveSharedSecret(d.resolverPublicKey, keys.stealthScalar, day, nonce),
  nonce: (slot) => slot,
  resweepable: RESOLVER_RESWEEPABLE,
  lookahead: RESOLVER_NONCE_LOOKAHEAD,
  perDay: RESOLVER_MAX_NONCES_PER_DAY,
}

/**
 * The wallet's own (`SipaSelfResolver`): a salt from the self-SIPA key, nonces counting down. A new
 * address is refused while `lookahead` are unpublished, so every one shown stays in the window.
 */
export const SELF_SLOTS: SipaSlots<SipaDeployment> = {
  salt: (_, keys, day, nonce) => deriveSelfSipaSecret(keys.selfSipaKey, day, nonce),
  nonce: (slot) => selfSipaNonce(slot),
  // `SELF_BROADCAST_RESWEEPABLE`, which a test pins: the hand-out's address commits to it.
  resweepable: true,
  lookahead: 3,
  // The cap keeps the window within 3 of the last used slot, so a busy day needs no ceiling.
  perDay: Infinity,
}

/** An address the resolver or the wallet hands out at `(day, nonce)`, with what its record needs. */
export interface ResolverCandidate {
  deployment: SipaDeployment
  day: number
  nonce: number
  sipaAddress: Address
  messageSecret: string
  recipientHash: string
  origin: NonNullable<SipaDeposit["origin"]>
}

/** The address of `salt` at `(day, nonce)` on `deployment`, derived offline. */
async function deriveCandidate(
  deployment: SipaDeployment,
  keys: ResolverPaymentKeys,
  day: number,
  nonce: number,
  salt: Fr,
  resweepable: boolean,
): Promise<ResolverCandidate> {
  const recipientHash = await computeStealthRecipientHash(salt, keys.recipient)
  const recoveryCommitment = deriveRecoveryCommitment(
    salt,
    EthAddress.fromString(deployment.recoveryAccount),
  )
  const { intentHash } = buildDepositIntent({
    implementation: deployment.implementation,
    recipientCommitment: recipientHash.toString() as Hex,
  })
  const sipaAddress = computeAccountSIPAAddress({
    sipaFactory: EthAddress.fromString(deployment.sipaFactory),
    implementation: EthAddress.fromString(deployment.implementation),
    intentHash: Buffer.from(intentHash.slice(2), "hex"),
    recoveryCommitment,
    forwardingTable: EthAddress.fromString(deployment.forwardingTable),
    rollupVersion: deployment.rollupVersion,
    resweepable,
  }).toString() as Address
  return {
    deployment,
    day,
    nonce,
    sipaAddress,
    messageSecret: salt.toString(),
    recipientHash: recipientHash.toString(),
    origin: {
      protocol: "account",
      sipaFactory: deployment.sipaFactory,
      implementation: deployment.implementation,
      intentHash,
      rollupVersion: deployment.rollupVersion.toString(),
      resweepable,
      accountFactory: deployment.accountFactory,
      forwardingTable: deployment.forwardingTable,
      recoveryAccount: deployment.recoveryAccount,
      recoveryCommitment: recoveryCommitment.toString() as Hex,
    },
  }
}

/**
 * The addresses `slots` could have handed out over the last `lookback` chain days, by default
 * {@link RESOLVER_LOOKBACK_DAYS}. Per deployment and day, the window is every slot up to
 * `slots.lookahead` past the highest one with a record or among the `known` salts: a slot below
 * that was handed out and may still be paid. A recorded address is the scan's to follow, so it is
 * left out. Derivations are kept for the days the window still covers.
 */
export function createResolverWindow<D extends SipaDeployment>(
  slots: SipaSlots<D>,
): (
  keys: ResolverPaymentKeys,
  deployments: readonly D[],
  records: readonly SipaDeposit[],
  now: number,
  known?: ReadonlySet<string>,
  lookback?: number,
) => Promise<ResolverCandidate[]> {
  const derived = new Map<string, ResolverCandidate>()
  return async (
    keys,
    deployments,
    records,
    now,
    known = new Set(),
    lookback = RESOLVER_LOOKBACK_DAYS,
  ) => {
    const today = epochDay(Math.floor(now / 1000))
    const days = Array.from({ length: Math.min(lookback, today + 1) }, (_, i) => today - i)
    for (const key of derived.keys()) {
      if (!days.includes(Number(key.split(":")[0]))) derived.delete(key)
    }
    const addresses = new Set(records.map((r) => r.sipaAddress.toLowerCase()))
    // Every account of one master secret shares its salts: only this account's records count.
    const account = keys.recipient.toString().toLowerCase()
    const secrets = new Set([
      ...known,
      ...records.flatMap((r) =>
        r.messageSecret && r.recipientL2Address?.toLowerCase() === account
          ? [r.messageSecret.toLowerCase()]
          : [],
      ),
    ])
    const recorded = (c: ResolverCandidate) =>
      addresses.has(c.sipaAddress.toLowerCase()) || secrets.has(c.messageSecret.toLowerCase())
    const out: ResolverCandidate[] = []
    for (const deployment of deployments) {
      // Every input to the address but its slot; the day leads, the window prunes by it.
      const inputs = `${keys.recipient}:${JSON.stringify(deployment, (_, v: unknown) =>
        typeof v === "bigint" ? v.toString() : v,
      )}`.toLowerCase()
      for (const day of days) {
        let end = slots.lookahead
        for (let slot = 0; slot < Math.min(end, slots.perDay); slot++) {
          const nonce = slots.nonce(slot)
          const key = `${day}:${nonce}:${inputs}`
          let found = derived.get(key)
          if (!found) {
            const salt = slots.salt(deployment, keys, day, nonce)
            found = await deriveCandidate(deployment, keys, day, nonce, salt, slots.resweepable)
            derived.set(key, found)
          }
          if (recorded(found)) end = slot + 1 + slots.lookahead
          else out.push(found)
        }
      }
    }
    return out
  }
}

/**
 * This account's own address `sipa`, searched offline from chain day `fromDay` to `toDay`, past the
 * slots in `records` and its `SIPA` event `salts`.
 */
export async function findOwnSlot(
  keys: ResolverPaymentKeys,
  deployment: SipaDeployment,
  sipa: Address,
  records: readonly SipaDeposit[],
  salts: ReadonlySet<string>,
  fromDay: number,
  toDay: number,
): Promise<ResolverCandidate | undefined> {
  const days = toDay - fromDay + 1
  const all = await createResolverWindow(SELF_SLOTS)(
    keys,
    [deployment],
    records,
    toDay * DAY_MS,
    salts,
    days,
  )
  return all.find((c) => c.sipaAddress.toLowerCase() === sipa.toLowerCase())
}

/**
 * The record a resolver payment opens: the address holds one of its deployment's tokens, else ETH.
 * Undefined while it holds nothing.
 */
export function resolverPaymentFields(
  candidate: ResolverCandidate,
  balances: ReadonlyMap<string, bigint>,
  context: { recipient: AztecAddress; l1ChainId: number; networkId: string; now: number },
): SipaDepositFields | undefined {
  const held = holding(candidate, balances)
  if (!held) return undefined
  const { token, balance } = held
  return {
    sipaAddress: candidate.sipaAddress,
    phase: "sweeping",
    recipientL2Address: context.recipient.toString(),
    messageSecret: candidate.messageSecret,
    recipientHash: candidate.recipientHash,
    recoveryAddress: "",
    origin: candidate.origin,
    l1ChainId: context.l1ChainId,
    networkId: context.networkId,
    amount: formatUnits(balance, token.decimals),
    tokenAddress: token.address,
    tokenSymbol: token.symbol,
    tokenDecimals: token.decimals,
    fundingTokenSymbol: token.symbol,
    startTime: context.now,
  }
}

/** The first of the deployment's tokens the address holds, else its ETH. */
function holding(
  candidate: ResolverCandidate,
  balances: ReadonlyMap<string, bigint>,
): { token: SipaFundingToken; balance: bigint } | undefined {
  for (const token of [...candidate.deployment.tokens, NATIVE_ETH]) {
    const balance = balances.get(token.address.toLowerCase()) ?? 0n
    if (balance > 0n) return { token, balance }
  }
  return undefined
}
