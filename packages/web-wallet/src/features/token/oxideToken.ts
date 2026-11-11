/** The token's published address-bound values, checked against its L1 portal. */
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import {
  readOxideTokenImmutables,
  type OxideTokenImmutables,
  type PortalDomain,
} from "@obsidion/sdk"
import { OxidePortalContract } from "@oxide/l1-contracts/oxide_portal.js"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { Address, PublicClient } from "viem"
import type { PageChain } from "../../session/pageChain"

/** Waits between the three attempts. */
const RETRY_DELAYS_MS = [500, 1_000]

export const portalContract = (client: PublicClient, portal: Address) =>
  new OxidePortalContract(
    client as unknown as ConstructorParameters<typeof OxidePortalContract>[0],
    portal,
  )

export async function readWithRetry<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read()
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length) throw err
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]))
    }
  }
}

const freshBridges = (reads: Pick<PageChain, "manifestBridges">) => {
  reads.manifestBridges.refresh()
  return reads.manifestBridges.read()
}

/** The immutables of the token `portal` binds, checked against those its manifest bridge publishes. */
export async function readTokenImmutables(
  reads: Pick<PageChain, "manifestBridges">,
  client: () => PublicClient,
  portal: Address,
): Promise<OxideTokenImmutables> {
  const find = (bridges: OxideEnvTuple[]) =>
    bridges.find((bridge) => bridge.portal.toLowerCase() === portal.toLowerCase())
  const bridge = find(await reads.manifestBridges.read()) ?? find(await freshBridges(reads))
  const published = bridge?.l2TokenImmutables
  return readWithRetry(async () => {
    const contract = portalContract(client(), portal)
    if (!published) return await readOxideTokenImmutables(contract)
    const [teeRegistry, maxNoteAmount] = await Promise.all([
      contract.getTeeRegistry(),
      contract.getTxAmountCap(),
    ])
    if (
      teeRegistry.toString().toLowerCase() !== published.teeRegistry.toLowerCase() ||
      maxNoteAmount !== BigInt(published.maxNoteAmount)
    ) {
      throw new Error(`Published L2 token immutables disagree with portal ${portal}`)
    }
    return {
      ...published,
      portal: EthAddress.fromString(published.portal),
      teeRegistry,
      maxNoteAmount,
    }
  })
}

/** The manifest bridge that lists `token`. A token the kept list lacks is looked up in a fresh fetch. */
export async function bridgeOfToken(
  reads: Pick<PageChain, "manifestBridges">,
  token: string,
): Promise<OxideEnvTuple> {
  const key = token.toLowerCase()
  const find = (bridges: OxideEnvTuple[]) => bridges.find((t) => t.l2Token.toLowerCase() === key)
  const bridge = find(await reads.manifestBridges.read()) ?? find(await freshBridges(reads))
  if (!bridge) throw new Error(`No oxide bridge lists the token ${token}`)
  return bridge
}

/** The domain `token`'s withdrawal messages hash under. */
export async function portalDomainOfToken(
  reads: Pick<PageChain, "tokenImmutablesOf" | "portalDomain">,
  token: AztecAddress | string,
): Promise<PortalDomain> {
  const { portal } = await reads.tokenImmutablesOf(token.toString()).read()
  return reads.portalDomain(portal.toString() as Address).read()
}
