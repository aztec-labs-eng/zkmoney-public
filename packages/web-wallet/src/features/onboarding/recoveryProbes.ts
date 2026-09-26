import type { Fr } from "@aztec/aztec.js/fields"
import type { PrfSlot } from "@obsidion/core/types"
import type { Hex } from "viem"
import type { PrivateKeyAccount } from "viem/accounts"
import {
  AccountServiceClient,
  deriveBootstrapKey,
  registryCandidateProbe,
  type AnchorTier,
  type BootstrapKeyProvider,
  type CandidateProbe,
  type OxideIdentityDeps,
  type ResolvedMsk,
} from "@obsidion/front-core"
import { getConfig, type WebWalletConfig } from "../../config/env"
import { AmbiguousPasskeyError, NoWalletForPasskeyError } from "@obsidion/passkey-web"

/**
 * The on-chain anchor a browser that has never held an account can ask: the L1 Registry record
 * registration wrote. The account contract is private, so nothing on L2 can be looked up, and a
 * nameless account has no record here at all. Every generation the deployment still publishes is
 * asked, because the factory of the generation a user registered under predicts their account and
 * a later factory does not.
 */
function registryTier(generations: OxideIdentityDeps): AnchorTier[] {
  return [{ name: "registry", probes: [registryCandidateProbe(generations)] }]
}

/** What the campaign's bridge material says of itself: the candidates it evaluated and the slot its account is. */
export type CampaignSlot = { candidates: { first?: Fr; second?: Fr }; slot: PrfSlot }

/**
 * The campaign's own word on the signup, for a hand-off whose deposit has not registered the name
 * yet: its bridge material names the slot it signed the user up under, and only the campaign
 * origin can post that material. The candidate at that slot is the account; the sibling is not.
 */
export function campaignSlotProbe(campaign: CampaignSlot): CandidateProbe {
  const named = campaign.candidates[campaign.slot]?.toString()
  return async (msk) => (named !== undefined && msk.toString() === named ? "anchored" : "absent")
}

/**
 * The hand-off's anchors, in trust order: the Registry, the campaign's word when its material
 * carries one, then account-service's claim ledger. A passkey that signed up and never paid has no
 * Registry record; the campaign reserved its tag through account-service under the same bootstrap
 * key, so the ledger names it wherever the material cannot. The Registry decides first, so an
 * anchor that cannot answer only ever reaches the keys it has never seen registered.
 */
export function anchorTiers(
  config: WebWalletConfig,
  generations: OxideIdentityDeps,
  campaign?: CampaignSlot,
): AnchorTier[] {
  const tiers = registryTier(generations)
  if (campaign) tiers.push({ name: "campaign", probes: [campaignSlotProbe(campaign)] })
  if (!config.accountServiceTestMode) {
    tiers.push({ name: "reservation", probes: [reservationCandidateProbe()] })
  }
  return tiers
}

/** One reservation lookup, reply included. */
const RESERVATION_TIMEOUT_MS = 15_000

/** Account-service request auth signed by the bootstrap key itself. */
export function bootstrapKeyProvider(bootstrap: PrivateKeyAccount): BootstrapKeyProvider {
  return {
    subject: bootstrap.address.toLowerCase(),
    signClientDataHash: (hash) =>
      bootstrap.sign({ hash: `0x${Buffer.from(hash).toString("hex")}` as Hex }),
  }
}

/** The name hashes account-service has claimed under `bootstrap`, asked fresh; any non-answer throws. */
export function reservedNameHashes(bootstrap: PrivateKeyAccount): Promise<Hex[]> {
  return new AccountServiceClient(getConfig().accountServiceUrl, {
    bootstrapProvider: bootstrapKeyProvider(bootstrap),
  }).claimedNames({ timeoutMs: RESERVATION_TIMEOUT_MS })
}

/**
 * Account-service's claim ledger, for a signup whose tag is claimed but not registered. Only a
 * candidate's own bootstrap key can file or read claims under it, so any claim anchors and none is
 * `absent`; a lookup that cannot answer aborts. Left out in account-service test mode, where every
 * web claim shares one keyId and both candidates would look like its holder.
 */
export function reservationCandidateProbe(lookup = reservedNameHashes): CandidateProbe {
  return async (msk) => ((await lookup(deriveBootstrapKey(msk))).length > 0 ? "anchored" : "absent")
}

/** A sign-in's anchors: the outside records alone, with no campaign material to speak for the key. */
export function enterTiers(config: WebWalletConfig, generations: OxideIdentityDeps): AnchorTier[] {
  return anchorTiers(config, generations)
}

/** The resolver's non-answers as the errors the screens show. */
export function requireResolved(result: ResolvedMsk): Extract<ResolvedMsk, { kind: "resolved" }> {
  if (result.kind === "unknown") throw new NoWalletForPasskeyError()
  if (result.kind === "ambiguous") throw new AmbiguousPasskeyError()
  return result
}
