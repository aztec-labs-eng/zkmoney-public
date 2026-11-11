// v5's SIPA logic that a source session only exposes. Each import resolves as in `index.ts`.
import { AztecAddress } from "@aztec/aztec.js/addresses"
import type { Fr } from "@aztec/aztec.js/fields"
import {
  DEFAULT_CONTRACTS,
  REGISTRATION_SIGNED_FEES,
  WALLET_TOKEN_SYMBOL,
} from "@obsidion/core/constants"
import type { ContractServiceConfig } from "@obsidion/core/types"
import {
  composeWireNameHash,
  createOxideL1Reader,
  createRegistrationSipaDeriver,
  depositSipaImplementation,
  deriveBootstrapKey,
  deriveRegistrationAddress,
  deriveResolverCandidate,
  deriveStealthKey,
  legacyRegistrationSalt,
  oxideEnvFromTuple,
  resolveOxideAccountFactory,
  RESOLVER_MAX_NONCES_PER_DAY,
  setActiveNetworkId,
  SIPADepositStore,
  type RegistrationSipaSeed,
} from "@obsidion/front-core"
import { encodeDeploySIPA } from "@oxide/l1-contracts"
import { parseAbi, zeroAddress, type Address, type Hex, type PublicClient } from "viem"
import type { SourceGenerationModule, SourceGenerationSession } from "./protocol"
import { fresh, memoryStorage, takeTurn } from "./stores"

const REGISTRY_ABI = parseAbi([
  "function registrationController() view returns (address)",
  "function REGISTRATION_FEE() view returns (uint256)",
  "function beneficiaries(uint256) view returns (address)",
  "function nextBeneficiaryId() view returns (uint256)",
])

/** v5's `scheduleSource`: the registry's controller, or the registry itself before the split. */
async function scheduleSource(client: PublicClient, registry: Address): Promise<Address> {
  const controller = await client
    .readContract({ address: registry, abi: REGISTRY_ABI, functionName: "registrationController" })
    .catch(() => zeroAddress)
  return controller === zeroAddress ? registry : controller
}

/** Every fee beneficiary the controller allowlisted. v5 committed the preferred one or the newest. */
async function allowlistedBeneficiaries(client: PublicClient, source: Address): Promise<Address[]> {
  const next = await client.readContract({
    address: source,
    abi: REGISTRY_ABI,
    functionName: "nextBeneficiaryId",
  })
  const all = await Promise.all(
    Array.from({ length: Number(next) }, (_, id) =>
      client.readContract({
        address: source,
        abi: REGISTRY_ABI,
        functionName: "beneficiaries",
        args: [BigInt(id)],
      }),
    ),
  )
  return all.filter((beneficiary) => beneficiary !== zeroAddress)
}

export const encodeSipaDeploy: SourceGenerationModule["encodeSipaDeploy"] = (args) =>
  encodeDeploySIPA({
    implementation: args.implementation as Address,
    intentHash: args.intentHash as Hex,
    recoveryCommitment: args.recoveryCommitment as Hex,
    rollupVersion: BigInt(args.rollupVersion),
    resweepable: args.resweepable,
  })

/** v5's `makeRegistrationDepositSeeder`, over a store of its own stamped with this rollup. */
const seedRegistration = (
  seed: RegistrationSipaSeed,
  env: { feeToken: Address; l1ChainId: number },
  rollupAddress: string,
) =>
  takeTurn(async () => {
    setActiveNetworkId(rollupAddress)
    const items = new Map<string, string>()
    const deposits = fresh(SIPADepositStore, memoryStorage(items))
    await deposits.load()
    await deposits.upsert(
      seed.sipaAddress as Address,
      { phase: "broadcast", registrationFee: seed.registrationFee.toString() },
      {
        recipientL2Address: seed.recipientL2Address,
        messageSecret: seed.messageSecret,
        recipientHash: seed.recipientHash,
        recoveryAddress: seed.origin.protocol === "legacy-eoa" ? seed.origin.recoveryAddress : "",
        origin: seed.origin,
        l1ChainId: env.l1ChainId,
        amount: "0",
        tokenSymbol: WALLET_TOKEN_SYMBOL,
        startTime: Date.now(),
        tokenAddress: env.feeToken,
        intent: "registration",
      },
    )
    return Object.fromEntries(items)
  })

/** A day can use more nonces than v5 watched: each resolve spends one, paid or not. */
const RESOLVER_SEARCH_NONCES_PER_DAY = 4 * RESOLVER_MAX_NONCES_PER_DAY

/** Finds `sipa` among the account's resolver addresses: a late payment has no `SIPA` event. */
export async function resolverDeposit(
  o: {
    client: PublicClient
    l1ChainId: number
    masterSecret: Fr
    rollupAddress: string
    l2Address: Hex
  },
  {
    tuple,
    sipa,
    resolvers,
    fromDay,
    toDay,
  }: Parameters<SourceGenerationSession["resolverDeposit"]>[0],
) {
  const { client } = o
  if (tuple.sipaRecoveryProtocol !== "account" || !tuple.sipaFactory) return {}
  const accountFactory = resolveOxideAccountFactory({ tuple })
  const [implementation, recoveryAccount] = await Promise.all([
    depositSipaImplementation(client, tuple.sipaFactory as Address, tuple.portal as Address),
    createOxideL1Reader(client).predictAccountAddress(
      accountFactory,
      deriveBootstrapKey(o.masterSecret).address as Address,
    ),
  ])
  const keys = {
    stealthScalar: deriveStealthKey(o.masterSecret).scalar,
    recipient: AztecAddress.fromStringUnsafe(o.l2Address),
  }
  const token = { address: tuple.token as Address, symbol: WALLET_TOKEN_SYMBOL, decimals: 18 }
  const target = sipa.toLowerCase()
  for (let day = toDay; day >= fromDay; day--)
    for (const key of resolvers) {
      const deployment = {
        portal: tuple.portal as Address,
        sipaFactory: tuple.sipaFactory as Address,
        implementation,
        rollupVersion: BigInt(tuple.rollupVersion),
        resolverPublicKey: { x: BigInt(key.x), y: BigInt(key.y) },
        recoveryAccount,
        accountFactory,
        tokens: [token] as const,
      }
      for (let nonce = 0; nonce < RESOLVER_SEARCH_NONCES_PER_DAY; nonce++) {
        const c = await deriveResolverCandidate(deployment, keys, day, nonce)
        if (c.sipaAddress.toLowerCase() !== target) continue
        return takeTurn(async () => {
          setActiveNetworkId(o.rollupAddress)
          const items = new Map<string, string>()
          const deposits = fresh(SIPADepositStore, memoryStorage(items))
          await deposits.load()
          await deposits.upsert(
            c.sipaAddress,
            { phase: "sweeping" },
            {
              recipientL2Address: keys.recipient.toString(),
              messageSecret: c.messageSecret,
              recipientHash: c.recipientHash,
              recoveryAddress: "",
              origin: c.origin,
              l1ChainId: o.l1ChainId,
              amount: "0",
              tokenAddress: token.address,
              tokenSymbol: token.symbol,
              startTime: Date.now(),
            },
          )
          return Object.fromEntries(items)
        })
      }
    }
  return {}
}

/**
 * v5's `seedRederivedRegistrations` for one address, over every operator, resolver key, beneficiary
 * and ClaimFPC the address may name instead of the ones current at its freeze.
 */
export async function registrationDeposit(
  o: {
    client: PublicClient
    l1ChainId: number
    masterSecret: Fr
    contracts: ContractServiceConfig
    rollupAddress: string
    l2Address: Hex
  },
  { tuple, sipa, handle, resolvers }: Parameters<SourceGenerationSession["registrationDeposit"]>[0],
) {
  const { client } = o
  if (!tuple.registrationSIPAImplementation || !tuple.ensDomain || !tuple.registry) return {}
  const source = await scheduleSource(client, tuple.registry as Address)
  const accountFactory = resolveOxideAccountFactory({ tuple })
  const [scheduleFee, beneficiaries, owner] = await Promise.all([
    client.readContract({
      address: source,
      abi: REGISTRY_ABI,
      functionName: "REGISTRATION_FEE",
    }),
    allowlistedBeneficiaries(client, source),
    createOxideL1Reader(client).predictAccountAddress(
      accountFactory,
      deriveBootstrapKey(o.masterSecret).address as Address,
    ),
  ])
  const nameHash = composeWireNameHash(handle, tuple.ensDomain)
  const fees = [...new Set([scheduleFee, ...REGISTRATION_SIGNED_FEES])]
  const portalRecipients = [
    ...new Set(
      [o.contracts.contracts[DEFAULT_CONTRACTS.claimFpc]?.address, tuple.fpcBeneficiary]
        .filter((address): address is string => !!address)
        .map((address) => address.toLowerCase()),
    ),
  ]
  // The self-SIPA salt goes with any operator; a resolver salt goes with the operator whose key
  // made it.
  const operators = [...new Set(resolvers.map((r) => r.operator.toLowerCase()))]
  const salted = [
    ...operators.map((operator) => ({ operator, salt: undefined })),
    ...resolvers.map((r) => ({
      operator: r.operator.toLowerCase(),
      salt: legacyRegistrationSalt(
        o.masterSecret,
        { x: BigInt(r.publicKey.x), y: BigInt(r.publicKey.y) },
        nameHash,
      ),
    })),
  ]
  const target = sipa.toLowerCase()
  // ponytail: one predictSIPA read per candidate, a few hundred at most, for a one-off lookup.
  for (const { operator, salt } of salted)
    for (const namePortalRecipient of portalRecipients) {
      const env = oxideEnvFromTuple(tuple, {
        resolverOperator: operator as Address,
        l1ChainId: o.l1ChainId,
        accountFactory,
        namePortalRecipient: namePortalRecipient as Hex,
      })
      const deps = {
        masterSecret: o.masterSecret,
        l2Address: o.l2Address,
        deriveRegistrationSipa: createRegistrationSipaDeriver({
          publicClient: client,
          env,
          tuple,
        }),
      }
      const derived = await Promise.all(
        beneficiaries.flatMap((beneficiary) =>
          fees.map((fee) =>
            deriveRegistrationAddress({ ...deps, beneficiary }, owner, nameHash, fee, salt),
          ),
        ),
      )
      const found = derived.find((d) => d.derivation.sipaAddress.toLowerCase() === target)
      if (found) return seedRegistration(found.seed, env, o.rollupAddress)
    }
  return {}
}
