import {
  encodeMetadataUpdateIntentData,
  encodeMetadataUpdateProofs,
  encodeUserRecordMetadata,
  metadataUpdateDigest,
  oxideAccountPersonalSignDigest,
  OxideAccountAbi,
  OxidePortalAbi,
  predictSIPA,
  readAccountMetadataRegistry,
  readMetadataStateHash,
  readNameOf,
  readRegistrationController,
  readSIPAImplementation,
  SipaIntent,
  type MetadataUpdateIntent,
  type SipaDeployArgs,
  type UserRecordArg,
} from "@oxide/l1-contracts"
import { keccak256, zeroAddress, zeroHash, type Address, type Hex, type PublicClient } from "viem"
import { quotedDepositFee } from "@obsidion/core/constants"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { readDepositFee } from "./sipaClaim.js"
import { readDepositSIPAImplementation } from "./sipaIntents.js"

export interface MetadataDestination {
  chainId: bigint
  rollupVersion: bigint
  nameRegistry: Address
  metadataRegistry: Address
  controller: Address
  factory: Address
  portal: Address
  implementation: Address
  namePortal: Address
  /** The portal's underlying token; the SIPA is funded and swept in it. */
  token: Address
  depositSubsidy: Address
  operationExecutor: Address
}

/**
 * The saved plan no longer matches the chain: its consent, routing or source batch is out of date.
 * Only this error lets the durable flow discard the plan and prepare again; any other failure keeps
 * it, so a retry reuses its saved approvals.
 */
export class StalePlanError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StalePlanError"
  }
}

/**
 * Why a retry soon repeats a stop: another account or deployment is in use, a sent transaction
 * reverted, or a saved transfer's deposit address no longer resolves to the one approved.
 */
export type MigrationHalt = "account" | "reverted" | "recipient"

/** A stop a blind retry repeats, so the durable flow stops for the user at once. */
export class MigrationHaltedError extends Error {
  constructor(readonly halt: MigrationHalt, message: string) {
    super(message)
    this.name = "MigrationHaltedError"
  }
}

/**
 * A step needs an approval it has not been given, outside a user's own action. The durable flow
 * stops for one press instead of prompting from a background pass.
 */
export class ApprovalNeededError extends Error {
  constructor(message = "This upgrade needs your approval to continue") {
    super(message)
    this.name = "ApprovalNeededError"
  }
}

function address(value: string | undefined, field: string): Address {
  if (!value || !/^0x[0-9a-f]{40}$/i.test(value) || value.toLowerCase() === zeroAddress) {
    throw new Error(`Metadata migration requires ${field} in the destination manifest`)
  }
  return value as Address
}

export function metadataDestination(tuple: OxideEnvTuple): MetadataDestination {
  if (!tuple.chainId || !tuple.rollupVersion)
    throw new Error("Destination chain identity is missing")
  return {
    chainId: BigInt(tuple.chainId),
    rollupVersion: BigInt(tuple.rollupVersion),
    nameRegistry: address(tuple.registry, "nameRegistry"),
    metadataRegistry: address(tuple.accountMetadataRegistry, "accountMetadataRegistry"),
    controller: address(tuple.registrationController, "registrationController"),
    factory: address(tuple.sipaFactory, "sipaFactory"),
    portal: address(tuple.portal, "portal"),
    implementation: address(
      tuple.updateMetadataSIPAImplementation,
      "updateMetadataSIPAImplementation",
    ),
    namePortal: address(tuple.namePortal, "namePortal"),
    token: address(tuple.token, "token"),
    depositSubsidy: address(tuple.depositSubsidy, "depositSubsidy"),
    operationExecutor: address(tuple.operationExecutor, "operationExecutor"),
  }
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

export async function readMetadataDestinationState(
  client: PublicClient,
  destination: MetadataDestination,
  owner: Address,
) {
  const [chainId, registry, controller, implementation, name] = await Promise.all([
    client.getChainId(),
    readAccountMetadataRegistry(client, destination.nameRegistry),
    readRegistrationController(client, destination.nameRegistry),
    readSIPAImplementation(
      client,
      destination.factory,
      destination.portal,
      SipaIntent.UpdateMetadata,
    ),
    readNameOf(client, destination.nameRegistry, owner),
  ])
  if (BigInt(chainId) !== destination.chainId) throw new Error("Destination L1 chain changed")
  if (!same(registry, destination.metadataRegistry) || !same(controller, destination.controller)) {
    throw new StalePlanError(
      "Destination metadata registry or controller changed; prepare migration again",
    )
  }
  if (!same(implementation, destination.implementation)) {
    throw new Error("Destination factory does not serve the requested metadata implementation")
  }
  if (name === zeroHash) throw new Error("Metadata migration requires an existing registered name")
  return readMetadataStateHash(client, controller, owner)
}

export interface PreparedMetadataUpdate {
  destination: MetadataDestination
  intent: MetadataUpdateIntent
  sipa: Address
  deployArgs: SipaDeployArgs
  intentData: Hex
  proofs: Hex
  fee: bigint
}

/** Derive the current schema from destination keys; never decode a source registry's record. */
export async function prepareMetadataUpdate(args: {
  client: PublicClient
  destination: MetadataDestination
  owner: Address
  record: UserRecordArg
  fpc: Hex
  recipientCommitment: Hex
  recoveryCommitment: Hex
  signConsent(digest: Hex): Promise<Hex>
}): Promise<PreparedMetadataUpdate> {
  const { client, destination, owner } = args
  if (args.record.rollupVersion !== destination.rollupVersion) {
    throw new Error("Destination metadata and deposit rollup disagree")
  }
  if (
    args.fpc === zeroHash ||
    args.recipientCommitment === zeroHash ||
    args.recoveryCommitment === zeroHash
  ) {
    throw new Error("Migration requires an FPC, a deposit recipient, and a recovery commitment")
  }
  const expectedStateHash = await readMetadataDestinationState(client, destination, owner)
  const intent: MetadataUpdateIntent = {
    owner,
    metadataRegistry: destination.metadataRegistry,
    metadata: encodeUserRecordMetadata(args.record),
    expectedStateHash,
    rollupVersion: destination.rollupVersion,
    namePortal: destination.namePortal,
    namePortalRecipient: args.fpc,
    recipientCommitment: args.recipientCommitment,
  }
  const intentData = encodeMetadataUpdateIntentData(intent)
  const deployArgs: SipaDeployArgs = {
    implementation: destination.implementation,
    intentHash: keccak256(intentData),
    recoveryCommitment: args.recoveryCommitment,
    rollupVersion: destination.rollupVersion,
    resweepable: false,
  }
  const sipa = await predictSIPA(
    client,
    destination.factory,
    deployArgs.implementation,
    deployArgs.intentHash,
    deployArgs.recoveryCommitment,
    deployArgs.rollupVersion,
    false,
  )
  const digest = metadataUpdateDigest({
    chainId: destination.chainId,
    nameRegistry: destination.nameRegistry,
    sipa,
    intentData,
  })
  const signature = await args.signConsent(
    oxideAccountPersonalSignDigest({ chainId: destination.chainId, account: owner, digest }),
  )
  const valid = await client.readContract({
    address: owner,
    abi: OxideAccountAbi,
    functionName: "isValidSignature",
    args: [digest, signature],
  })
  if (valid !== "0x1626ba7e") throw new Error("The registered account rejected metadata consent")
  const prepared = {
    destination,
    intent,
    sipa,
    deployArgs,
    intentData,
    proofs: encodeMetadataUpdateProofs(signature),
    fee: await readMetadataUpdateFee(client, destination),
  }
  await assertMetadataUpdateFresh(client, prepared)
  return prepared
}

/** Re-check after signing and immediately before spending sponsorship. */
export async function assertMetadataUpdateFresh(
  client: PublicClient,
  prepared: PreparedMetadataUpdate,
): Promise<void> {
  const state = await readMetadataDestinationState(
    client,
    prepared.destination,
    prepared.intent.owner,
  )
  if (!same(state, prepared.intent.expectedStateHash)) {
    throw new StalePlanError(
      "Destination metadata changed; prepare migration again before broadcasting",
    )
  }
}

/** What funding a SIPA pays before its deposit: the implementation's sweep fee and the portal's funding cut. */
export async function readQuotedDepositFee(
  client: PublicClient,
  portal: Address,
  implementation: Address,
): Promise<bigint> {
  const [depositFee, fpcFundingCut] = await Promise.all([
    readDepositFee(client, implementation),
    client.readContract({
      address: portal,
      abi: OxidePortalAbi,
      functionName: "FPC_FUNDING_CUT",
    }) as Promise<bigint>,
  ])
  return quotedDepositFee(depositFee, fpcFundingCut)
}

export function readMetadataUpdateFee(
  client: PublicClient,
  destination: MetadataDestination,
): Promise<bigint> {
  return readQuotedDepositFee(client, destination.portal, destination.implementation)
}

/** What an ordinary DepositSIPA on the destination pays before its deposit. */
export async function readOrdinaryDepositFee(
  client: PublicClient,
  destination: Pick<MetadataDestination, "factory" | "portal">,
): Promise<bigint> {
  return readQuotedDepositFee(
    client,
    destination.portal,
    await readDepositSIPAImplementation(client, destination.factory, destination.portal),
  )
}
