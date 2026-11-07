/** What the registration rail's sessions, retries and gate witnesses need from the wallet's keys. */
import type { Fr } from "@aztec-labs/aztec.js/fields"
import { WalletError } from "@obsidion/core/errors"
import { toBytes, toHex, type Hex, type PublicClient } from "viem"
import type { PrivateKeyAccount } from "viem/accounts"
import {
  AccountServiceClient,
  composeWireNameHash,
  createOxideL1Reader,
  createRegistrationSipaDeriver,
  deriveBootstrapKey,
  metadataMigrationBinding,
  pubkeyToR1KeyArg,
  type AccountRecord,
  type BootstrapKeyProvider,
  type OxideRegistrationSessionDeps,
  type OxideRegistrationStage,
  type OxideSignDeps,
  type RegistrationStore,
  type SipaDeposits,
} from "@obsidion/front-core"
import { SANDBOX_REGISTRATION_BENEFICIARY_ID } from "@obsidion/core/constants"
import type { NameClaimResponse } from "@obsidion/core/types"
import type { NameClaimWitness, OxideAccountBinding } from "@obsidion/sdk"
import type { WebWalletConfig } from "../../config/env"
import { getOxideTuple, oxideEnvFor, requireTupleField } from "../../config/oxideTuple"
import { oxideAccountPasskey } from "../../platform/auth/oxideAccountPasskey"
import { type OnboardingKeys } from "../../session/account"
import type { SignupStash } from "./signupStash"
import { makeRegistrationDepositSeeder, seededRegistrationSalt } from "./registrationDepositSeed"
import { readRegistrationSchedule, resolveBeneficiary } from "./registrationTerms"

function bigintTo32(value: bigint): Uint8Array {
  return toBytes(toHex(value, { size: 32 }))
}

/** Account-service request auth signed by the bootstrap key itself. */
export function bootstrapKeyProvider(bootstrap: PrivateKeyAccount): BootstrapKeyProvider {
  return {
    subject: bootstrap.address.toLowerCase(),
    signClientDataHash: (hash) =>
      bootstrap.sign({ hash: `0x${Buffer.from(hash).toString("hex")}` as Hex }),
  }
}

/**
 * The bootstrap-key request-auth provider for `/domain/sign` (front-core `BootstrapKeyProvider`,
 * PR #1174): the wallet's own bootstrap key signs the request's `clientDataHash` directly.
 */
function bootstrapProviderFor(masterSecret: OnboardingKeys["secretKey"]): BootstrapKeyProvider {
  return bootstrapKeyProvider(deriveBootstrapKey(masterSecret))
}

export function accountServiceFor(
  config: WebWalletConfig,
  keys: Pick<OnboardingKeys, "secretKey">,
  grantToken?: string,
): AccountServiceClient {
  // The bootstrap key names the subject in test mode too, so the sandbox binds claims (and earned
  // entitlements) to the same subject production does.
  return new AccountServiceClient(config.accountServiceUrl, {
    testMode: config.accountServiceTestMode,
    // Sandbox testMode skips the HTTP gate; the bootstrap subject still names the ticket owner
    // and the NameClaim's keyId, so the ticket's entitlement prices the claim.
    bootstrapProvider: bootstrapProviderFor(keys.secretKey),
    grantToken,
  })
}

/** The account's passkey credential id, or a loud failure — registration installs the r1 key
 *  through the sweep and cannot without it. */
async function requireCredentialId(account: AccountOf): Promise<string> {
  const credentialId = (await account?.get())?.signKeyConfig.webauthnData.credentialId
  if (!credentialId) {
    throw new WalletError(
      "account.noPasskeyCredential",
      "the signed-in account has no passkey credential",
    )
  }
  return credentialId
}

/** The session's account record; a visitor's session has none. */
type AccountOf = Pick<AccountRecord, "get"> | null

/** What deriving this wallet's registration address needs; the session and recovery share it. */
export async function registrationAddressDeps(
  handle: string,
  secretKey: Fr,
  l2Address: Hex,
  config: WebWalletConfig,
  networkId: string,
  deposits: Pick<SipaDeposits, "apply">,
  l1Client?: PublicClient,
  grantToken?: string,
) {
  const { tuple, env, publicClient: envClient } = await oxideEnvFor(config)
  const publicClient = l1Client ?? envClient
  return {
    tag: handle,
    env,
    masterSecret: secretKey,
    l2Address,
    accountService: accountServiceFor(config, { secretKey }, grantToken),
    beneficiary: await resolveBeneficiary(config, Number(SANDBOX_REGISTRATION_BENEFICIARY_ID)),
    // Read live at derivation: the committed fee must be exactly what the controller checks at
    // sweep, and signed terms (when the claim carries them) take precedence over this schedule.
    scheduleFee: () => readRegistrationSchedule(config).then((schedule) => schedule.fee),
    l1: createOxideL1Reader(publicClient),
    deriveRegistrationSipa: createRegistrationSipaDeriver({
      publicClient,
      env,
      tuple,
    }),
    seedSipaDeposit: makeRegistrationDepositSeeder(deposits, {
      feeToken: env.feeToken,
      l1ChainId: env.l1ChainId,
      networkId,
    }),
  }
}

/** Assemble the deposit-driven registration session deps (shared by claimTag + the retry sign deps). */
export async function registrationSessionDeps(
  handle: string,
  keys: OnboardingKeys,
  config: WebWalletConfig,
  networkId: string,
  own: {
    registrations: RegistrationStore
    sipaDeposits: Pick<SipaDeposits, "apply">
    accountRecord: AccountOf
    signup: Pick<SignupStash, "grantToken">
  },
  onStage?: (stage: OxideRegistrationStage) => void,
): Promise<OxideRegistrationSessionDeps> {
  const l2Address = keys.account.getAddress().toString() as Hex
  return {
    ...(await registrationAddressDeps(
      handle,
      keys.secretKey,
      l2Address,
      config,
      networkId,
      own.sipaDeposits,
      undefined,
      own.signup.grantToken(handle),
    )),
    r1Key: pubkeyToR1KeyArg(keys.pubkeyHex),
    passkey: await oxideAccountPasskey(keys.account.getAuthProvider()),
    credentialId: await requireCredentialId(own.accountRecord),
    registrations: own.registrations,
    onStage,
  }
}

/**
 * What rebuilding a registration's broadcast needs: re-derive the SIPA, re-request the claim,
 * re-sign the consent. The bootstrap key gates `/domain/sign` directly, so this arms on any
 * deployment with an unlocked wallet.
 */
export async function buildRetrySignDeps(
  grantToken: string | undefined,
  keys: OnboardingKeys,
  config: WebWalletConfig,
  networkId: string,
  deposits: Pick<SipaDeposits, "get" | "apply">,
  account: AccountOf,
): Promise<OxideSignDeps> {
  const { tuple, env, publicClient } = await oxideEnvFor(config)
  return {
    masterSecret: keys.secretKey,
    accountService: accountServiceFor(config, keys, grantToken),
    r1Key: pubkeyToR1KeyArg(keys.pubkeyHex),
    passkey: await oxideAccountPasskey(keys.account.getAuthProvider()),
    credentialId: await requireCredentialId(account),
    l1: createOxideL1Reader(publicClient),
    deriveRegistrationSipa: createRegistrationSipaDeriver({
      publicClient,
      env,
      tuple,
    }),
    seedSipaDeposit: makeRegistrationDepositSeeder(deposits, {
      feeToken: env.feeToken,
      l1ChainId: env.l1ChainId,
      networkId,
    }),
    seededSipaSalt: seededRegistrationSalt(deposits),
  }
}

/**
 * What both ClaimFPC gates rest on: the name the L1 side commits to, the bootstrap key that
 * CREATE2-derives the OxideAccount holding it, and that key's signature over this L2 address. The
 * signature never leaves the device, and every part re-derives from the master secret.
 */
export async function buildOxideAccountBinding(
  keys: Pick<OnboardingKeys, "account" | "secretKey">,
  nameHash: Hex,
): Promise<OxideAccountBinding> {
  return metadataMigrationBinding(
    keys.secretKey,
    keys.account.getAddress().toString() as Hex,
    nameHash,
  )
}

/**
 * The NameClaim gate's eligibility witness: the binding above plus the REAL NameClaim the domain
 * owner signed.
 *
 * `nameHash` is what the signature actually covers, so a recovered claim passes the value from the
 * Registry's `NameClaimed` log rather than recomposing it — recovery then needs no plaintext tag,
 * and a stale `handle` can't silently produce a node the signature doesn't match.
 */
export async function buildClaimSubscribeWitness(
  handle: string,
  keys: Pick<OnboardingKeys, "account" | "secretKey">,
  claim: Pick<NameClaimResponse, "signature" | "nonce" | "deadline">,
  config: WebWalletConfig,
  nameHash?: Hex,
): Promise<NameClaimWitness> {
  const tuple = await getOxideTuple(config)
  const ensDomain = requireTupleField(tuple, "ensDomain")
  const node = nameHash ?? composeWireNameHash(handle, ensDomain)
  return {
    ...(await buildOxideAccountBinding(keys, node)),
    nonce: bigintTo32(BigInt(claim.nonce)),
    deadline: bigintTo32(BigInt(claim.deadline)),
    claimSig: toBytes(claim.signature).slice(0, 64),
  }
}
