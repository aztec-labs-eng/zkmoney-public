/**
 * Finds this wallet's registration addresses from its keys alone, for a device with no
 * registration record. An address commits to its fee and salt, and both have moved since addresses
 * were handed out, so every fee the account service has signed is tried under the self-SIPA key's
 * salt and under the resolver salt addresses used before it.
 */
import type { Address, Hex } from "viem"
import { REGISTRATION_SIGNED_FEES } from "@obsidion/core/constants"
import {
  composeWireNameHash,
  deriveBootstrapKey,
  deriveRegistrationAddress,
  legacyRegistrationSalt,
  type SipaDeposits,
} from "@obsidion/front-core"
import type { Fr } from "@aztec-labs/aztec.js/fields"
import type { WebWalletConfig } from "../../config/env"
import { l1MulticallClient, oxideEnvFor } from "../../config/oxideTuple"
import { registrationAddressDeps } from "./registrationDeps"

/** What every registration address of one wallet and name derives from. */
export interface RegistrationCandidates {
  deps: Awaited<ReturnType<typeof registrationAddressDeps>>
  owner: Address
  nameHash: Hex
  /** The schedule's fee and every fee the account service has signed. */
  fees: readonly bigint[]
  salts: readonly (Hex | undefined)[]
}

export async function registrationCandidates(
  config: WebWalletConfig,
  networkId: string,
  secret: Fr,
  handle: string,
  l2Address: Hex,
  deposits: Pick<SipaDeposits, "apply">,
): Promise<RegistrationCandidates> {
  // Every candidate's address is one predictSIPA read; the multicall client sends them as one.
  const deps = await registrationAddressDeps(
    handle,
    secret,
    l2Address,
    config,
    networkId,
    deposits,
    l1MulticallClient(config),
  )
  const [owner, scheduleFee, { resolver }] = await Promise.all([
    deps.l1.predictAccountAddress(deps.env.factory, deriveBootstrapKey(secret).address as Address),
    deps.scheduleFee(),
    oxideEnvFor(config),
  ])
  const nameHash = composeWireNameHash(handle, deps.env.ensDomain)
  return {
    deps,
    owner,
    nameHash,
    fees: [...new Set([scheduleFee, ...REGISTRATION_SIGNED_FEES])],
    salts: [undefined, legacyRegistrationSalt(secret, resolver.resolverPublicKey, nameHash)],
  }
}

/**
 * Seeds every address at `fees` under both salts, so the deposit sync watches it, and returns them.
 * The seeder leaves an address already tracked as it is. No claim is asked for: that would reserve
 * the name.
 */
export async function seedRegistrationCandidates(
  c: RegistrationCandidates,
  fees = c.fees,
): Promise<Address[]> {
  const derived = await Promise.all(
    c.salts.flatMap((salt) =>
      fees.map((fee) => deriveRegistrationAddress(c.deps, c.owner, c.nameHash, fee, salt)),
    ),
  )
  for (const { seed } of derived) await c.deps.seedSipaDeposit(seed)
  return derived.map((d) => d.derivation.sipaAddress)
}
