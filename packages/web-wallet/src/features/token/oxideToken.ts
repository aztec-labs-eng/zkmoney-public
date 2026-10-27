/** The token's published address-bound values, checked against its L1 portal. */
import type { AztecAddress } from "@aztec-labs/stdlib/aztec-address"
import { EthAddress } from "@aztec-labs/foundation/eth-address"
import {
  readOxideTokenImmutables,
  type OxideTokenImmutables,
  type PortalDomain,
  type RegisteredTeeSigner,
} from "@obsidion/sdk"
import { fleetSignerConnector, sharedFleetSigners } from "@obsidion/front-core"
import { OxidePortalContract } from "@oxide/l1-contracts/oxide_portal.js"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { Address, Hex, PublicClient } from "viem"
import { getConfig } from "../../config/env"
import {
  fleetUrl,
  getManifestBridges,
  getOxideTuple,
  l1PublicClient,
  requireTupleField,
} from "../../config/oxideTuple"

/** Waits between the three attempts. */
const RETRY_DELAYS_MS = [500, 1_000]

const immutablesByPortal = new Map<string, Promise<OxideTokenImmutables>>()
const capsByPortal = new Map<string, Promise<bigint>>()

export const portalContract = (client: PublicClient, portal: Address) =>
  new OxidePortalContract(
    client as unknown as ConstructorParameters<typeof OxidePortalContract>[0],
    portal,
  )

async function readWithRetry<T>(read: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await read()
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length) throw err
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]))
    }
  }
}

async function readTokenImmutables(client: PublicClient, portal: Address): Promise<OxideTokenImmutables> {
  const find = (bridges: OxideEnvTuple[]) =>
    bridges.find((bridge) => bridge.portal.toLowerCase() === portal.toLowerCase())
  const bridge =
    find(await getManifestBridges(getConfig())) ??
    find(await getManifestBridges(getConfig(), { fresh: true }))
  const published = bridge?.l2TokenImmutables
  return readWithRetry(async () => {
    const contract = portalContract(client, portal)
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

/** The immutables of the token `portal` binds. */
export function tokenImmutables(
  client: PublicClient,
  portal: Address,
): Promise<OxideTokenImmutables> {
  const key = portal.toLowerCase()
  let value = immutablesByPortal.get(key)
  if (!value) {
    const pending = readTokenImmutables(client, portal)
    immutablesByPortal.set(key, pending)
    pending.catch(() => {
      if (immutablesByPortal.get(key) === pending) immutablesByPortal.delete(key)
    })
    value = pending
  }
  return value
}

/** The portal's `TX_AMOUNT_CAP()`: the most one operation may move, in settlement-token units. */
export function txAmountCap(client: PublicClient, portal: Address): Promise<bigint> {
  const key = portal.toLowerCase()
  let value = capsByPortal.get(key)
  if (!value) {
    const pending = readWithRetry(() => portalContract(client, portal).getTxAmountCap())
    capsByPortal.set(key, pending)
    pending.catch(() => {
      if (capsByPortal.get(key) === pending) capsByPortal.delete(key)
    })
    value = pending
  }
  return value
}

/** The cap of the active deployment, for callers holding neither a client nor the tuple. */
export async function currentTxAmountCap(): Promise<bigint> {
  const config = getConfig()
  const tuple = await getOxideTuple(config)
  return txAmountCap(l1PublicClient(config), requireTupleField(tuple, "portal") as Address)
}

const domainByPortal = new Map<string, Promise<PortalDomain>>()

/** The domain withdrawal messages of `portal` hash under, read off L1 once per portal. */
export function portalDomain(portal: Address): Promise<PortalDomain> {
  const key = portal.toLowerCase()
  let value = domainByPortal.get(key)
  if (!value) {
    const pending = portalContract(l1PublicClient(getConfig()), portal).getPortalDomain()
    domainByPortal.set(key, pending)
    pending.catch(() => {
      if (domainByPortal.get(key) === pending) domainByPortal.delete(key)
    })
    value = pending
  }
  return value
}

/** The manifest bridge that lists `token`. A token the cached list lacks is looked up in a fresh fetch. */
export async function bridgeOfToken(token: string): Promise<OxideEnvTuple> {
  const key = token.toLowerCase()
  const find = (bridges: OxideEnvTuple[]) => bridges.find((t) => t.l2Token.toLowerCase() === key)
  const bridge =
    find(await getManifestBridges(getConfig())) ??
    find(await getManifestBridges(getConfig(), { fresh: true }))
  if (!bridge) throw new Error(`No oxide bridge lists the token ${token}`)
  return bridge
}

/** The published immutables of `token`, with its portal's values checked on L1. */
export async function oxideTokenImmutablesOf(
  token: AztecAddress | string,
): Promise<OxideTokenImmutables> {
  const bridge = await bridgeOfToken(token.toString())
  return tokenImmutables(l1PublicClient(getConfig()), bridge.portal as Address)
}

/** The portal `token`'s immutables commit to. */
export async function portalOfToken(token: AztecAddress | string): Promise<Address> {
  return (await oxideTokenImmutablesOf(token)).portal.toString() as Address
}

/** The domain `token`'s withdrawal messages hash under. */
export async function portalDomainOfToken(token: AztecAddress | string): Promise<PortalDomain> {
  return portalDomain(await portalOfToken(token))
}

let fleetSigners: { l1RpcUrl: string; connect: ReturnType<typeof sharedFleetSigners> } | undefined

/** How every flow connects its co-signer: one signer per fleet and portal domain. */
export function connectFleetSigner(fleet: string, portal: Hex): Promise<RegisteredTeeSigner> {
  const { l1RpcUrl, l1Chain } = getConfig()
  if (fleetSigners?.l1RpcUrl !== l1RpcUrl) {
    fleetSigners = {
      l1RpcUrl,
      connect: sharedFleetSigners(fleetSignerConnector(l1RpcUrl, l1Chain)),
    }
  }
  return fleetSigners.connect(fleet, portal)
}

/** The co-signer for `token`: its deployment's fleet, sealing to the domain of the portal its immutables name. */
export async function teeSignerOfToken(token: AztecAddress | string): Promise<RegisteredTeeSigner> {
  const [bridge, portal] = await Promise.all([
    bridgeOfToken(token.toString()),
    portalOfToken(token),
  ])
  return connectFleetSigner(fleetUrl(getConfig(), bridge), portal)
}
