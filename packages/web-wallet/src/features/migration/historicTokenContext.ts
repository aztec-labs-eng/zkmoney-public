/**
 * Operating on a retired deployment's l2Token. The live TEE signer is bound to the current portal,
 * so nothing on a historic token — a migration burn, a paylink refund — can be co-signed by it:
 * connect to that tuple's own enclave + portal, and pin the token service to its address.
 */
import { AztecAddress } from "@aztec/aztec.js/addresses"
import type { OxideEnvTuple } from "@obsidion/core/types"
import {
  IntraRollupMigrationService,
  loadTeeSigner,
  TokenService,
  type ObsidionAccount,
  type ObsidionWallet,
  type TeeSigner,
} from "@obsidion/sdk"
import { createPublicClient, fallback, http, type Hex } from "viem"
import { getConfig } from "../../config/env"
import { l1PublicClient } from "../../config/oxideTuple"

/** The retired deployment whose l2Token is `tokenAddress`, or null when none in the manifest has it. */
export async function findHistoricTuple(tokenAddress: string): Promise<OxideEnvTuple | null> {
  const config = getConfig()
  const { historic } = await IntraRollupMigrationService.detectHistoricDeployments({
    ...config.oxideProfile,
    network: config.network,
    publicClient: l1PublicClient(config),
  })
  return historic.find((t) => t.l2Token.toLowerCase() === tokenAddress.toLowerCase()) ?? null
}

/** Token service + TEE signer for a retired tuple, `config.enclaveUrl` override included. A dead
 *  historic enclave fails loudly here. */
export async function historicTokenContext(
  wallet: ObsidionWallet,
  account: ObsidionAccount,
  historic: OxideEnvTuple,
): Promise<{ tokenService: TokenService; teeSigner: TeeSigner }> {
  const teeSigner = await historicTeeSigner(historic)
  const tokenService = await TokenService.create(
    wallet,
    account,
    AztecAddress.fromStringUnsafe(historic.l2Token),
    teeSigner,
  )
  return { tokenService, teeSigner }
}

export async function historicTeeSigner(historic: OxideEnvTuple): Promise<TeeSigner> {
  const config = getConfig()
  return loadTeeSigner(
    config.enclaveUrl ? `${config.enclaveUrl}/rpc` : historic.enclaveUrl,
    historic.portal as Hex,
    createPublicClient({
      chain: config.l1Chain,
      transport: fallback([http(config.l1RpcUrl, { timeout: 10_000 })]),
    }) as unknown as Parameters<typeof loadTeeSigner>[2],
  )
}
