/**
 * Binds the web app's L1 config (chain, RPC, pinned manifest profile) to front-core's shared
 * Registry tag resolution. Two call modes: debounced type-ahead reads the process-cached manifest
 * tuple (no fetch per keystroke); the commit path (add-contact confirm, handshake verifyTag)
 * refetches the manifest so a rotation between resolution and commit never persists a stale record.
 */

import {
  resolveTagViaRegistry as resolveViaFrontCore,
  TagValidationError,
  type RegistryTagResolution,
} from "@obsidion/front-core"

import { isDemoMode } from "../../dev/demoFlag"
import { l1PublicClient } from "../../config/oxideTuple"
import type { PageFacts } from "../../session/pageChain"

async function resolve(
  { config, chain }: PageFacts,
  tag: string,
  cached: boolean,
  signIn = false,
): Promise<RegistryTagResolution> {
  if (import.meta.env.DEV && isDemoMode()) {
    return (await import("../../dev/contactDemo")).demoContactResolution(tag, !cached)
  }
  return resolveViaFrontCore(tag, {
    publicClient: l1PublicClient(config),
    manifestUrl: config.oxideProfile.manifestUrl,
    portal: config.oxideProfile.portal,
    network: config.network,
    expectedGitSha: config.oxideProfile.expectedGitSha,
    tuple: cached ? await chain.oxideTuple.read() : undefined,
    retiredRollupVersions: signIn
      ? async () => (await chain.retiredRollupSources.read()).map((source) => source.rollupVersion)
      : undefined,
  })
}

/** Type-ahead resolution over the cached manifest tuple. */
export const resolveTagViaRegistry = (page: PageFacts, tag: string) => resolve(page, tag, true)

/** Commit-time resolution: fresh manifest fetch. */
export const resolveTagForCommit = (page: PageFacts, tag: string) => resolve(page, tag, false)

/**
 * Sign-in's type-ahead resolution: a tag still bound to one of the profile's retired rollups also
 * resolves, since sign-in admits its account until it migrates. Never for a payment.
 */
export const resolveSignInTag = (page: PageFacts, tag: string) => resolve(page, tag, true, true)

/** {@link resolveSignInTag} over a fresh manifest. */
export const resolveSignInTagForCommit = (page: PageFacts, tag: string) =>
  resolve(page, tag, false, true)

/**
 * scanCore's authoritative registry cross-check: registered identity, `null` for a
 * non-discoverable tag (notFound / staleRollup / invalid), throws on transport failure so the
 * handshake core fails open. Reads a fresh manifest — never the type-ahead cache.
 */
export async function verifyTag(
  page: PageFacts,
  tag: string,
): Promise<{ l2Address?: string; xmtpAddress?: string } | null> {
  try {
    const r = await resolveTagForCommit(page, tag)
    if (r.status !== "resolved") return null
    return { l2Address: r.l2Address, xmtpAddress: r.xmtpAddress ?? undefined }
  } catch (e) {
    if (e instanceof TagValidationError) return null
    throw e
  }
}
