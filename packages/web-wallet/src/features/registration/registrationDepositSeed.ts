/**
 * Self-initiated intent tracking for registration deposits (sipa-intents.md §Wallet): the discovery
 * note carries no intent type, so a registration deposit's claim inputs must be recorded by the
 * wallet itself — this seeder writes them into the SIPA rail's store, whose known-address scan then
 * reads the L1 sweep and claims the bridged funds. `healRegistrationDeposits` covers records from
 * before the seeder existed (or whose seed was lost): with the wallet unlocked it re-derives each
 * custodial registration and seeds the ones whose address still re-derives.
 */

import type { Address, Hex } from "viem"
import { WALLET_TOKEN_SYMBOL } from "@obsidion/core/constants"
import {
  loadRecords,
  createRegistrationSipaDeriver,
  isTerminalRegistrationPhase,
  type IdentityView,
  type PendingRegistrationRecord,
  type ReadonlyStore,
  type RegistrationSipaSeed,
  type RegistrationStore,
  type SipaDeposits,
} from "@obsidion/front-core"
import type { WebWalletConfig } from "../../config/env"
import type { WebAlphaAuthService } from "../../platform/auth/WebAlphaAuthService"
import { oxideEnvFor } from "../../config/oxideTuple"

/** The salt seeded with a registration address on this device, if any. */
export const seededRegistrationSalt =
  (deposits: Pick<SipaDeposits, "get">) =>
  async (sipaAddress: Address): Promise<Hex | undefined> => {
    const record = await deposits.get(sipaAddress)
    return (record?.messageSecret || undefined) as Hex | undefined
  }

/** Seed claim inputs or backfill a missing fee without replacing an existing deposit's progress. */
export function makeRegistrationDepositSeeder(
  deposits: Pick<SipaDeposits, "apply">,
  env: { feeToken: string; l1ChainId: number; networkId: string },
): (seed: RegistrationSipaSeed) => Promise<void> {
  return async (seed) => {
    await deposits.apply(seed.sipaAddress, {
      type: "seeded",
      fields: {
        sipaAddress: seed.sipaAddress as Address,
        phase: "broadcast",
        registrationFee: seed.registrationFee.toString(),
        recipientL2Address: seed.recipientL2Address,
        messageSecret: seed.messageSecret,
        recipientHash: seed.recipientHash,
        recoveryAddress: seed.origin.protocol === "legacy-eoa" ? seed.origin.recoveryAddress : "",
        origin: seed.origin,
        l1ChainId: env.l1ChainId,
        networkId: env.networkId,
        amount: "0",
        tokenSymbol: WALLET_TOKEN_SYMBOL,
        startTime: Date.now(),
        tokenAddress: env.feeToken as Address,
        intent: "registration",
      },
    })
  }
}

/** The account's stores and key a heal reads and seeds. */
export interface RegistrationSeedStores {
  sipaDeposits: Pick<SipaDeposits, "view" | "apply">
  registrations: Pick<RegistrationStore, "view">
  identity: ReadonlyStore<IdentityView>
  auth: Pick<WebAlphaAuthService, "getSecretKey">
}

/** A registration whose funds the rail should be tracking: money touched it, or it registered. */
function fundsBearing(record: PendingRegistrationRecord): boolean {
  return (
    record.phase === "confirmed" ||
    record.fundedAt !== undefined ||
    record.sweptAt !== undefined ||
    record.fundingTxHash !== undefined
  )
}

/**
 * One pass over this wallet's registrations, seeding missing records and backfilling missing fees.
 * Requires the unlocked master secret (re-derivation); silently does nothing when locked. A
 * record whose address no longer re-derives is a previous iteration's and is skipped, per the
 * no-backwards-compatibility rule.
 */
export async function healRegistrationDeposits(
  own: RegistrationSeedStores,
  config: WebWalletConfig,
  networkId: string,
): Promise<number> {
  const identity = own.identity.get().value
  if (!identity) return 0
  const secret = await own.auth.getSecretKey()
  if (!secret) return 0
  const fees = new Map(
    (await loadRecords(own.sipaDeposits.view)).map((d) => [
      d.sipaAddress.toLowerCase(),
      d.registrationFee,
    ]),
  )
  const candidates = (await loadRecords(own.registrations.view)).filter(
    (r) =>
      r.l2Address.toLowerCase() === identity.address.toLowerCase() &&
      (fundsBearing(r) || !isTerminalRegistrationPhase(r.phase)) &&
      fees.get(r.sipaAddress.toLowerCase()) === undefined,
  )
  if (candidates.length === 0) return 0

  const { tuple, env, publicClient } = await oxideEnvFor(config)
  const derive = createRegistrationSipaDeriver({
    publicClient,
    env,
    tuple,
  })
  const seeder = makeRegistrationDepositSeeder(own.sipaDeposits, {
    feeToken: env.feeToken,
    l1ChainId: env.l1ChainId,
    networkId,
  })
  let seeded = 0
  for (const record of candidates) {
    try {
      const derivation = await derive({
        owner: record.account as Address,
        nameHash: record.nameHash,
        l2Address: record.l2Address,
        fee: BigInt(record.fee),
        beneficiary: record.beneficiary as Address,
        masterSecret: secret,
      })
      if (derivation.sipaAddress.toLowerCase() !== record.sipaAddress.toLowerCase()) continue
      await seeder({
        sipaAddress: derivation.sipaAddress,
        messageSecret: derivation.sharedSecretSalt,
        recipientHash: derivation.recipientCommitment,
        origin: derivation.origin,
        recipientL2Address: record.l2Address,
        registrationFee: BigInt(record.fee),
      })
      seeded += 1
    } catch (err) {
      console.warn("[registrationDepositSeed] heal failed for", record.tag, err)
    }
  }
  if (seeded > 0) console.info(`[registrationDepositSeed] healed ${seeded} registration deposit(s)`)
  return seeded
}
