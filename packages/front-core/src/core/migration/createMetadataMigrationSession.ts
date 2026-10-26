import type { Fr } from "@aztec/aztec.js/fields"
import type { OxideEnvTuple } from "@obsidion/core/types"
import type { Network } from "@obsidion/core/constants"
import {
  MetadataMigrationService,
  metadataDestination,
  metadataMigrationContext,
  readNameClaimLog,
  SipaSelfResolver,
  resolverSelectionPolicy,
  selectManifestResolverOperator,
  type ContractService,
  type ObsidionAccount,
  type ObsidionWallet,
  type TokenService,
  type MetadataMigrationServiceOptions,
  type MetadataMigrationSource,
  type RefundChallengeSigner,
} from "@obsidion/sdk"
import { toBytes, toHex, type Address, type Hex, type PublicClient } from "viem"
import { deriveBootstrapKey, selfSipaResolverKeys } from "../../oxide/oxideAccountKeys"
import {
  metadataConsentPrompts,
  signMetadataConsent,
  type MetadataConsentSigner,
} from "../../oxide/metadataConsent"
import { metadataMigrationBinding } from "../../oxide/metadataMigrationBinding"
import { readResolverOperatorRecords } from "../../oxide/resolverOperatorRecords"
import type { IStorageAdapter, StorageLock } from "../storages/adapter"
import { sipaSweepsReceived, type SIPADepositStore } from "../services/deposits/SIPADepositStore"
import { MetadataMigrationController } from "./MetadataMigrationController"
import { MigrationFundingStore } from "./MigrationFundingStore"
import { ApprovalGate, savedChallengeSigner, webAuthnAssertionCodec } from "./savedApprovals"
import type { UpgradeActivity } from "./upgradeActivity"
import { legSettled } from "./upgradeRuns"
import type { SIPADepositRecord } from "../services/deposits/SIPADepositStore"
import { logger } from "src/utils/logger"

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
  /** Told of every write, so activity lists this run's batches. */
  activity?: UpgradeActivity
  /** The deposit rail's records: the rail observes and claims the migration's SIPAs. */
  deposits: Pick<SIPADepositStore, "load" | "get">
  /** Whether a balance read begun now is stored: a run is done only once it holds all it imported. */
  confirmBalance?(): Promise<boolean>
  /** Stores what the source holds; `anchor` is the L1 block its read began at, so no older read lands last. */
  holdings?(amount: bigint, anchor: number): Promise<void>
  /** A funding address is shown for the first time: seed it on the rail, as a registration address is. */
  seedFunding?(sipa: Address, resolution: { messageSecret: Fr; recipientHash: Fr }): Promise<void>
  /** The wallet's record of the deposit at a SIPA address, if it has one. */
  deposit?(sipa: Address): Promise<SIPADepositRecord | null | undefined>
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
      | "received"
      | "swept"
    > & { tokenService: TokenService; depositSettled(recipient: Address): Promise<boolean> },
    batches: MigrationFundingStore,
    /** Wraps the source's refund signer so each approval is asked for once. */
    savedRefundSigner: (sign: RefundChallengeSigner) => RefundChallengeSigner,
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
  const records = await readResolverOperatorRecords(
    o.client,
    destination.metadataRegistry,
    o.current,
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
    received: async (sipa: Address) => {
      await o.deposits.load()
      return sipaSweepsReceived(o.deposits.get(sipa))
    },
    swept: async (sipa: Address) => {
      await o.deposits.load()
      return !!o.deposits.get(sipa)?.sweepTxHash
    },
  }
  const bindingWitness = (nameHash: Hex) =>
    metadataMigrationBinding(o.secretKey, o.account.getAddress().toString() as Hex, nameHash)
  const storage = o.activity ? o.activity.reporting(o.key, o.storage) : o.storage
  const approvals = `${o.key}/approvals`
  const gate = new ApprovalGate()
  // A failed read leaves the last stored figure until a read succeeds.
  const holdings = async (): Promise<boolean> => {
    if (!o.holdings) return true
    try {
      const anchor = Number(await o.client.getBlockNumber({ cacheTime: 0 }))
      const amount = await service.holdings()
      if (amount !== undefined) await o.holdings(amount, anchor)
      return true
    } catch (error) {
      logger.warn("[upgrade] holdings read failed:", error)
      return false
    }
  }
  const depositSettled = async (recipient: Address) =>
    legSettled({ arrival: (await o.deposit?.(recipient)) ?? undefined })
  const source = await o.source(
    { ...context, depositSettled },
    new MigrationFundingStore(storage, `${o.key}/source`),
    (sign) => savedChallengeSigner(sign, o.storage, approvals, webAuthnAssertionCodec, gate),
  )
  const passkey = o.passkey && {
    ...o.passkey,
    signChallenge: savedChallengeSigner(
      o.passkey.signChallenge,
      o.storage,
      approvals,
      undefined,
      gate,
    ),
  }
  const service = new MetadataMigrationService({
    ...context,
    destination,
    owner,
    source,
    client: o.client,
    wallet: o.wallet,
    confirmBalance: o.confirmBalance,
    seedFunding: o.seedFunding,
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
      signMetadataConsent({ client: o.client, owner, bootstrap, passkey }, digest),
    consentPrompts: () => metadataConsentPrompts({ client: o.client, owner }),
  })
  return {
    service,
    controller: new MetadataMigrationController(storage, service, o.key, o.lock, gate),
    /** Reads and stores what the source holds; false when that failed. Never throws. */
    holdings,
  }
}
