/**
 * Settings recovery for a deposit address the previous Aztec generation handed out. That
 * generation's bundle is loaded only when this browser's own retired databases lack the address.
 * The cutover's import carries settled deposits only, so the record is copied here in any phase.
 */
import { WalletError } from "@obsidion/core/errors"
import { isRetiredRollupSource } from "@obsidion/core/oxide"
import type { OxideEnvTuple, SourceGenerationSession } from "@obsidion/core/types"
import {
  deploymentScanRange,
  retiredDatabaseOf,
  retiredSipaDeposit,
  type SipaDepositFields,
} from "@obsidion/front-core"
import { epochDay } from "@obsidion/sdk"
import type { Address, PublicClient } from "viem"
import { l1PublicClient } from "../../../config/oxideTuple"
import type { PageFacts } from "../../../session/pageChain"
import type { Session } from "../../../session/session"
import type { WebAlphaAuthService } from "../../../platform/auth/WebAlphaAuthService"
import type { SourceRollupWallet } from "../../../platform/sourceRollupWallet"
import { webStorage } from "../../../platform/storage/WebStorageAdapter"
import { sourceChain } from "../../migration/historicTokenContext"
import { readSourceHistory } from "../../migration/sourceHistoryReplay"
import { sourceResolverKeys } from "../../migration/sourceSipaSources"
import copy from "./sipaRecovery.copy"

/** Copies `sipa`'s record from the previous generation into this rollup's store, when it has one. */
export async function findPreviousVersionDeposit(session: Session, sipa: Address): Promise<void> {
  // The lookup's account: a switch during it never writes into another account's store.
  const { sipaDeposits, wallet, account, auth, identity } = session
  if (!account) throw new Error(copy.signInToLookUp)
  const record =
    (await webStorage.readOtherDatabases((db) => retiredSipaDeposit(db, sipa))).find(Boolean) ??
    (await fromSourceGeneration(
      session.page,
      sipa,
      { wallet: await wallet.ready(), account: await account.ready() },
      auth,
      identity.get().value?.handle,
    ))
  if (record) await sipaDeposits.adopt(record)
}

async function fromSourceGeneration(
  { config, chain: pageChain }: PageFacts,
  sipa: Address,
  active: SourceRollupWallet,
  auth: Pick<WebAlphaAuthService, "getSecretKey" | "sessionKeys">,
  handle: string | undefined,
): Promise<SipaDepositFields | null> {
  const masterSecret = await auth.getSecretKey()
  if (!masterSecret) throw new WalletError("account.unlockWithPasskey")
  const publicClient = l1PublicClient(config)
  const [current, sources, scanHead] = await Promise.all([
    pageChain.oxideTuple.read(),
    pageChain.otherManifestSources.read(),
    publicClient.getBlockNumber({ cacheTime: 0 }),
  ])
  for (const tuple of sources) {
    // Only a source the refund also reads, so a found address can be refunded.
    if (!isRetiredRollupSource(tuple, current)) continue
    // A deployment without SIPAs, such as Sky savings, handed out no deposit address.
    if (!tuple.depositSIPAImplementation && !tuple.registrationSIPAImplementation) continue
    const chain = await sourceChain(config, active, current, tuple, auth)
    if (chain.kind !== "generation") continue
    // A failed registration search still lets the history find a plain deposit address.
    let registrationFailure: unknown
    const registration = await registrationDeposit({
      page: { config, chain: pageChain },
      session: chain.session,
      tuple,
      publicClient,
      scanHead,
      sipa,
      handle,
    }).catch((e: unknown) => {
      registrationFailure = e
      return null
    })
    if (registration) return registration
    const db = await readSourceHistory({
      page: { config, chain: pageChain },
      session: chain.session,
      tuple,
      publicClient,
      masterSecret,
      scanHead,
      handle,
      deployments: sources.filter((t) => t.rollupVersion === tuple.rollupVersion),
    })
    const record =
      retiredSipaDeposit(db, sipa) ??
      (await resolverDeposit({
        page: { config, chain: pageChain },
        session: chain.session,
        tuple,
        publicClient,
        scanHead,
        sipa,
      }))
    if (record) return record
    if (registrationFailure) throw registrationFailure
  }
  return null
}

/** `sipa` as one of the account's registration addresses on `tuple`, announced on L2 or not. */
async function registrationDeposit(o: {
  page: PageFacts
  session: SourceGenerationSession
  tuple: OxideEnvTuple
  publicClient: PublicClient
  scanHead: bigint
  sipa: Address
  handle: string | undefined
}): Promise<ReturnType<typeof retiredSipaDeposit>> {
  const { tuple, handle } = o
  if (!handle || !tuple.registrationSIPAImplementation || !tuple.accountMetadataRegistry)
    return null
  const resolvers = await sourceResolverKeys(o)
  const items = await o.session.registrationDeposit({
    tuple,
    sipa: o.sipa,
    handle,
    resolvers: resolvers.map(({ owner, resolverPublicKey: key }) => ({
      operator: owner,
      publicKey: { x: key.x.toString(), y: key.y.toString() },
    })),
  })
  return retiredSipaDeposit(retiredDatabaseOf(tuple.rollupVersion, items), o.sipa)
}

/** `sipa` as a resolver address from any day of the deployment. */
async function resolverDeposit(o: {
  page: PageFacts
  session: SourceGenerationSession
  tuple: OxideEnvTuple
  publicClient: PublicClient
  scanHead: bigint
  sipa: Address
}): Promise<SipaDepositFields | null> {
  const { tuple, publicClient } = o
  if (
    !tuple.ensDomain ||
    tuple.sipaRecoveryProtocol !== "account" ||
    !tuple.depositSIPAImplementation
  )
    return null
  const { fromBlock, toBlock } = await deploymentScanRange(publicClient, tuple, o.scanHead)
  const [first, last, resolvers] = await Promise.all([
    publicClient.getBlock({ blockNumber: fromBlock }),
    publicClient.getBlock({ blockNumber: toBlock }),
    sourceResolverKeys(o),
  ])
  const keys = new Map(
    resolvers.map(({ resolverPublicKey: k }) => [
      `${k.x}:${k.y}`,
      { x: k.x.toString(), y: k.y.toString() },
    ]),
  )
  const items = await o.session.resolverDeposit({
    tuple,
    sipa: o.sipa,
    resolvers: [...keys.values()],
    fromDay: epochDay(first.timestamp),
    toDay: epochDay(last.timestamp),
  })
  return retiredSipaDeposit(retiredDatabaseOf(tuple.rollupVersion, items), o.sipa)
}
