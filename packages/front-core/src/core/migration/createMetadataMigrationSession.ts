import type { Fr } from "@aztec/aztec.js/fields"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { Network } from "@obsidion/core/constants"
import {
  MetadataMigrationService,
  metadataDestination,
  metadataMigrationContext,
  readNameClaimLog,
  SipaSelfResolver,
  fetchSipaResolverOperators,
  resolverSelectionPolicy,
  selectManifestResolverOperator,
  type ContractService,
  type ObsidionAccount,
  type ObsidionWallet,
  type TokenService,
  type MetadataMigrationServiceOptions,
  type MetadataMigrationSource,
} from "@obsidion/sdk"
import { toBytes, toHex, type Address, type Hex, type PublicClient } from "viem"
import { deriveBootstrapKey, selfSipaResolverKeys } from "../../oxide/oxideAccountKeys"
import { signMetadataConsent, type MetadataConsentSigner } from "../../oxide/metadataConsent"
import { metadataMigrationBinding } from "../../oxide/metadataMigrationBinding"
import { deploymentScanRange } from "../../oxide/deploymentScanRange"
import type { IStorageAdapter, StorageLock } from "../storages/adapter"
import { MetadataMigrationController } from "./MetadataMigrationController"
import { MigrationFundingStore } from "./MigrationFundingStore"

export interface MetadataMigrationSessionOptions {
  wallet: ObsidionWallet
  account: ObsidionAccount
  contracts: ContractService
  tokenService: TokenService
  current: OxideEnvTuple
  network: Network
  secretKey: Fr
  client: PublicClient
  storage: Pick<IStorageAdapter, "getItem" | "setItem">
  lock: StorageLock
  key: string
  passkey?: MetadataConsentSigner["passkey"]
  source(
    context: Pick<
      MetadataMigrationServiceOptions,
      | "registered"
      | "bootstrap"
      | "broadcaster"
      | "selfResolver"
      | "token"
      | "owner"
      | "destination"
      | "tokenService"
    >,
    batches: MigrationFundingStore,
  ): Promise<MetadataMigrationSource>
}

/** Shared migration composition. The host supplies signing, storage and source generation. */
export async function createMetadataMigrationSession(o: MetadataMigrationSessionOptions) {
  // Registration helpers also load AccountStorage. Defer them until composition so exporting
  // this factory from core does not initialize storage through a circular barrel import.
  const { createOxideL1Reader, resolveOxideAccountFactory } = await import(
    "../../oxide/oxideRegistrationDeps"
  )
  const destination = metadataDestination(o.current)
  const records = await fetchSipaResolverOperators(
    o.client,
    destination.metadataRegistry,
    await deploymentScanRange(o.client, o.current),
  )
  const resolver = selectManifestResolverOperator(records, {
    portal: destination.portal,
    resolverGatewayUrl: o.current.resolverGatewayUrl,
    ...resolverSelectionPolicy(o.network),
  })
  const selfResolver = new SipaSelfResolver(selfSipaResolverKeys(o.secretKey))
  const bootstrap = deriveBootstrapKey(o.secretKey)
  const owner = await createOxideL1Reader(o.client).predictAccountAddress(
    resolveOxideAccountFactory({ tuple: o.current }),
    bootstrap.address,
  )
  const context = {
    ...(await metadataMigrationContext(o.wallet, o.contracts, o.current, o.account.getAddress())),
    selfResolver,
    owner,
    destination,
    tokenService: o.tokenService,
  }
  const bindingWitness = (nameHash: Hex) =>
    metadataMigrationBinding(o.secretKey, o.account.getAddress().toString() as Hex, nameHash)
  const source = await o.source(context, new MigrationFundingStore(o.storage, `${o.key}/source`))
  const service = new MetadataMigrationService({
    ...context,
    destination,
    owner,
    source,
    client: o.client,
    wallet: o.wallet,
    tokenService: o.tokenService,
    record: {
      l2Address: o.account.getAddress().toString() as Hex,
      rollupVersion: destination.rollupVersion,
      publicKey: selfResolver.userPublicKey,
      resolverOperator: resolver.owner,
    },
    bindingWitness,
    nameClaim: async () => {
      const claim = await readNameClaimLog(o.client, destination.nameRegistry, owner)
      if (!claim) throw new Error("No existing name claim is available for migration")
      return {
        kind: "nameClaim",
        ...(await bindingWitness(claim.nameHash)),
        nonce: toBytes(toHex(BigInt(claim.nonce), { size: 32 })),
        deadline: toBytes(toHex(BigInt(claim.deadline), { size: 32 })),
        claimSig: toBytes(claim.signature).slice(0, 64),
      }
    },
    signConsent: (digest) =>
      signMetadataConsent({ client: o.client, owner, bootstrap, passkey: o.passkey }, digest),
  })
  return { service, controller: new MetadataMigrationController(o.storage, service, o.key, o.lock) }
}
