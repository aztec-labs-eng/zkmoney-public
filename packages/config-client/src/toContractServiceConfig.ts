import { Network } from "@obsidion/core/constants"
import type {
  ContractServiceConfig,
  ContractServiceConfigEntry,
  ContractName,
} from "@obsidion/core/types"
import { type ConfigProfile, type ProfileNetwork, isL2ContractEntry } from "./schema.js"
import { resolveVersion } from "./client.js"

/**
 * Profile → ContractService config. The two vocabularies now spell every contract the same way, so
 * this is a filter rather than a translation; it stays the one place a divergence would land.
 */

const NETWORKS: Record<ProfileNetwork, Network> = {
  sandbox: Network.SANDBOX,
  testnet: Network.TESTNET,
  mainnet: Network.MAINNET,
}

/**
 * Profile contract keys that name a ContractName. Anything else — `adminAccount`, or a key a later
 * schema adds — is dropped, and stays reachable on the raw profile for whoever wants it.
 */
const KNOWN: ReadonlySet<string> = new Set<string>([
  "oidcKeyRegistry",
  "sponsorFPC",
  "claimFpc",
  "obsidionAccountAlpha",
  "obsidionAccountAlphaTest",
  "paylinkEmail",
  "paylinkDirect",
  "passwordFPC",
])

function toContractName(profileKey: string): ContractName | undefined {
  return KNOWN.has(profileKey) ? (profileKey as ContractName) : undefined
}

export function toContractServiceConfig(
  profile: ConfigProfile,
  versionIdOverride?: string,
): ContractServiceConfig {
  const { versionId, version } = resolveVersion(profile, versionIdOverride)

  const contracts: Partial<Record<ContractName, ContractServiceConfigEntry>> = {}
  for (const [key, entry] of Object.entries(version.contracts)) {
    const name = toContractName(key)
    if (!name) continue
    if (!isL2ContractEntry(entry)) continue
    contracts[name] = {
      ...(entry.address === undefined ? {} : { address: entry.address }),
      classId: entry.classId,
      ...(entry.meta === undefined ? {} : { meta: entry.meta }),
    }
  }

  return {
    network: NETWORKS[profile.network],
    configVersion: versionId,
    contracts,
    oxide: {
      manifestUrl: version.oxide.manifestUrl,
      portal: version.oxide.portal,
      ...(version.oxide.expectedGitSha === undefined
        ? {}
        : { expectedGitSha: version.oxide.expectedGitSha }),
    },
  }
}

