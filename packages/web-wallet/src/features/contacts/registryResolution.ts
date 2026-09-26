/**
 * Binds the web app's L1 config (chain, RPC, pinned manifest profile) to front-core's shared
 * Registry tag resolution. Two call modes: debounced type-ahead reads the process-cached manifest
 * tuple (no fetch per keystroke); the commit path (add-contact confirm, handshake verifyTag)
 * refetches the manifest so a rotation between resolution and commit never persists a stale record.
 */

import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  resolveTagViaRegistry as resolveViaFrontCore,
  TagValidationError,
  type RegistryTagResolution,
} from "@obsidion/front-core"

import { isDemoMode } from "../../dev/demoFlag"
import { getConfig, type WebWalletConfig } from "../../config/env"
import { getOxideTuple, l1PublicClient } from "../../config/oxideTuple"

function resolutionOpts(config: WebWalletConfig, tuple?: OxideEnvTuple) {
  return {
    publicClient: l1PublicClient(config),
    manifestUrl: config.oxideProfile.manifestUrl,
    portal: config.oxideProfile.portal,
    network: config.network,
    expectedGitSha: config.oxideProfile.expectedGitSha,
    tuple,
  }
}

/** Type-ahead resolution over the cached manifest tuple. */
export async function resolveTagViaRegistry(tag: string): Promise<RegistryTagResolution> {
  if (import.meta.env.DEV && isDemoMode()) {
    return (await import("../../dev/contactDemo")).demoContactResolution(tag, false)
  }
  const config = getConfig()
  return resolveViaFrontCore(tag, resolutionOpts(config, await getOxideTuple(config)))
}

/** Commit-time resolution: fresh manifest fetch. */
export async function resolveTagForCommit(tag: string): Promise<RegistryTagResolution> {
  if (import.meta.env.DEV && isDemoMode()) {
    return (await import("../../dev/contactDemo")).demoContactResolution(tag, true)
  }
  return resolveViaFrontCore(tag, resolutionOpts(getConfig()))
}

/**
 * scanCore's authoritative registry cross-check: registered identity, `null` for a
 * non-discoverable tag (notFound / staleRollup / invalid), throws on transport failure so the
 * handshake core fails open. Reads a fresh manifest — never the type-ahead cache.
 */
export async function verifyTag(
  tag: string,
): Promise<{ l2Address?: string; xmtpAddress?: string } | null> {
  try {
    const r = await resolveTagForCommit(tag)
    if (r.status !== "resolved") return null
    return { l2Address: r.l2Address, xmtpAddress: r.xmtpAddress ?? undefined }
  } catch (e) {
    if (e instanceof TagValidationError) return null
    throw e
  }
}
