/**
 * Resolver payments, shown the moment they land on L1.
 *
 * A sender who pays a tag through the ENS resolver funds an address the resolver derived for one
 * `(day, nonce)`: an ECDH salt between the resolver's key and the account's registered stealth key,
 * where `day` is the L1 block's UTC day and the nonce counts up from 0 per account and day, one per
 * resolve. The ECDH is symmetric, so the wallet derives the same addresses from its own key. The
 * scan reads the ones the resolver could have handed out and records a funded one as an
 * incoming deposit straight away, instead of waiting for the resolver's L2 broadcast to reach discovery.
 *
 * The record carries the salt and the full origin, so the pipeline claims it like any other, and
 * the event discovery later finds is pinned to it by salt rather than recorded again.
 */

import type { AztecAddress } from "@aztec-labs/aztec.js/addresses"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import { deriveRecoveryCommitment } from "@oxide/oxide-lib/sipa_recovery.js"
import { formatUnits, type Address, type Hex, type PublicClient } from "viem"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  buildDepositIntent,
  epochDay,
  readAccountResolution,
  readDepositSIPAImplementation,
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
export const RESOLVER_NONCE_LOOKAHEAD = 8

/** Nonces per day the window ever reaches; bounds derivation and the call size. */
export const RESOLVER_MAX_NONCES_PER_DAY = 32

/** The oxide gateway resolves every name to a resweepable address. */
const RESOLVER_RESWEEPABLE = true

/** A deployment whose resolver can hand out this account's addresses. */
export interface ResolverDeployment {
  portal: Address
  sipaFactory: Address
  /** The ForwardingTable every address the resolver hands out commits to. */
  forwardingTable: Address
  /** The factory's deposit implementation, which every address the resolver hands out clones. */
  implementation: Address
  /** The rollup version the account's user record names. */
  rollupVersion: bigint
  /** The resolver operator's key, the ECDH counterparty. */
  resolverPublicKey: SipaK1Point
  /** The account the name registry records, which the recovery commitment binds. */
  recoveryAccount: Address
  accountFactory: Address
  /** Tokens a SIPA on this deployment is swept in, the credited one first. */
  tokens: readonly [SipaFundingToken, ...SipaFundingToken[]]
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
  recipient: AztecAddress
}

/** An address the resolver hands out at `(day, nonce)`, with what its record needs. */
export interface ResolverCandidate {
  deployment: ResolverDeployment
  day: number
  nonce: number
  sipaAddress: Address
  messageSecret: string
  recipientHash: string
  origin: NonNullable<SipaDeposit["origin"]>
}

/** The address `deployment`'s resolver hands out at `(day, nonce)`, derived offline. */
export async function deriveResolverCandidate(
  deployment: ResolverDeployment,
  keys: ResolverPaymentKeys,
  day: number,
  nonce: number,
): Promise<ResolverCandidate> {
  const salt = deriveSharedSecret(deployment.resolverPublicKey, keys.stealthScalar, day, nonce)
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
    resweepable: RESOLVER_RESWEEPABLE,
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
      resweepable: RESOLVER_RESWEEPABLE,
      accountFactory: deployment.accountFactory,
      forwardingTable: deployment.forwardingTable,
      recoveryAccount: deployment.recoveryAccount,
      recoveryCommitment: recoveryCommitment.toString() as Hex,
    },
  }
}

/**
 * The addresses the resolver could have handed out for today and yesterday (it watches an unpaid one
 * into the next day). Per deployment and day, the window is every nonce up to
 * {@link RESOLVER_NONCE_LOOKAHEAD} past the highest one with a record: a nonce below that was handed
 * out and may still be paid. A recorded address is the scan's to follow, so it is left out.
 * Derivations are kept for the days the window still covers.
 */
export function createResolverWindow(): (
  keys: ResolverPaymentKeys,
  deployments: readonly ResolverDeployment[],
  records: readonly SipaDeposit[],
  now: number,
) => Promise<ResolverCandidate[]> {
  const derived = new Map<string, ResolverCandidate>()
  const candidate = async (
    deployment: ResolverDeployment,
    keys: ResolverPaymentKeys,
    day: number,
    nonce: number,
  ) => {
    // The day stays second: the window prunes by it. The rest is every input to the address.
    const key = [
      deployment.portal,
      day,
      nonce,
      keys.recipient,
      deployment.sipaFactory,
      deployment.forwardingTable,
      deployment.implementation,
      deployment.rollupVersion,
      deployment.resolverPublicKey.x,
      deployment.resolverPublicKey.y,
      deployment.recoveryAccount,
    ]
      .join(":")
      .toLowerCase()
    let found = derived.get(key)
    if (!found) {
      found = await deriveResolverCandidate(deployment, keys, day, nonce)
      derived.set(key, found)
    }
    return found
  }
  return async (keys, deployments, records, now) => {
    const today = epochDay(Math.floor(now / 1000))
    const days = today > 0 ? [today - 1, today] : [today]
    for (const key of derived.keys()) {
      if (!days.includes(Number(key.split(":")[1]))) derived.delete(key)
    }
    const addresses = new Set(records.map((r) => r.sipaAddress.toLowerCase()))
    const secrets = new Set(
      records.flatMap((r) => (r.messageSecret ? [r.messageSecret.toLowerCase()] : [])),
    )
    const recorded = (c: ResolverCandidate) =>
      addresses.has(c.sipaAddress.toLowerCase()) || secrets.has(c.messageSecret.toLowerCase())
    const out: ResolverCandidate[] = []
    for (const deployment of deployments) {
      for (const day of days) {
        let end = RESOLVER_NONCE_LOOKAHEAD
        for (let nonce = 0; nonce < Math.min(end, RESOLVER_MAX_NONCES_PER_DAY); nonce++) {
          const found = await candidate(deployment, keys, day, nonce)
          if (recorded(found)) end = nonce + 1 + RESOLVER_NONCE_LOOKAHEAD
          else out.push(found)
        }
      }
    }
    return out
  }
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
