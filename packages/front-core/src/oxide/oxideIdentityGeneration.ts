import type { Address, Hex } from "viem"

import type { OxideL1Reader } from "./oxideRegistration"

export interface IdentityGeneration {
  fpcAddress: string
  accountFactory: Address
  implementation: Address
  namePortal: Address
  rollupVersion: string
}

export interface VerifiedOxideIdentity {
  account: Address
  nameHash: Hex
  generations: IdentityGeneration[]
}

export type OxideIdentityOutcome =
  | { kind: "verified"; identity: VerifiedOxideIdentity }
  | { kind: "unverified"; accounts: Address[] }
  | { kind: "no-generation" }
  | { kind: "none" }

export class AmbiguousOxideIdentityError extends Error {
  constructor(readonly accounts: readonly Address[]) {
    super(`this key owns more than one registered account: ${accounts.join(", ")}`)
    this.name = "AmbiguousOxideIdentityError"
  }
}

export class OxideIdentityUnavailableError extends Error {
  constructor(reason: string) {
    super(`this device cannot say which account this passkey owns: ${reason}`)
    this.name = "OxideIdentityUnavailableError"
  }
}

export class UnverifiedOxideIdentityError extends Error {
  constructor(readonly accounts: readonly Address[]) {
    super(
      `this passkey holds a registered account this device cannot confirm: ${accounts.join(", ")}`,
    )
    this.name = "UnverifiedOxideIdentityError"
  }
}

export type IdentityGenerationReads = Pick<
  OxideL1Reader,
  | "predictAccountAddress"
  | "readNameOf"
  | "readAccountMetadataRegistry"
  | "readUserRecord"
  | "readNamePortalRegistry"
  | "readFactoryImplementation"
>

export interface OxideIdentityDeps {
  reader: IdentityGenerationReads
  registry: Address
  catalog: readonly IdentityGeneration[]
  rollupVersion: string
}

const sameAddress = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()

const isZeroHash = (value: string) => /^0x0*$/.test(value)

function readOnce<T>(read: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined
  return () => (pending ??= read())
}

function readOncePerAddress<T>(read: (address: Address) => Promise<T>) {
  const pending = new Map<string, Promise<T>>()
  return (address: Address) => {
    const key = address.toLowerCase()
    const started = pending.get(key)
    if (started) return started
    const next = read(address)
    pending.set(key, next)
    return next
  }
}

export async function resolveOxideIdentity(
  deps: OxideIdentityDeps,
  bootstrap: Address,
  l2Address: string,
): Promise<OxideIdentityOutcome> {
  const metadataRegistry = readOnce(() => deps.reader.readAccountMetadataRegistry(deps.registry))
  const registryBehind = readOncePerAddress((portal: Address) =>
    deps.reader.readNamePortalRegistry(portal),
  )
  const cloneTargetOf = readOncePerAddress((factory: Address) =>
    deps.reader.readFactoryImplementation(factory),
  )

  const bindsThisRegistry = async (generation: IdentityGeneration) => {
    if (generation.rollupVersion !== deps.rollupVersion) return false
    if (!sameAddress(await registryBehind(generation.namePortal), deps.registry)) return false
    return sameAddress(await cloneTargetOf(generation.accountFactory), generation.implementation)
  }

  const verifiedByAccount = new Map<string, VerifiedOxideIdentity>()
  const named = new Map<string, Address>()
  let admitted = 0
  for (const generation of deps.catalog) {
    if (!(await bindsThisRegistry(generation))) continue
    admitted += 1
    const account = await deps.reader.predictAccountAddress(generation.accountFactory, bootstrap)
    const key = account.toLowerCase()
    const verified = verifiedByAccount.get(key)
    if (verified) {
      verified.generations.push(generation)
      continue
    }
    if (named.has(key)) continue
    const nameHash = await deps.reader.readNameOf(deps.registry, account)
    if (isZeroHash(nameHash)) continue
    named.set(key, account)
    const record = await deps.reader.readUserRecord(await metadataRegistry(), account)
    if (!record || !sameAddress(record.l2Address, l2Address)) continue
    if (record.rollupVersion.toString() !== deps.rollupVersion) continue
    verifiedByAccount.set(key, { account, nameHash, generations: [generation] })
  }

  if (admitted === 0) return { kind: "no-generation" }
  const accounts = [...named.values()]
  if (accounts.length > 1) throw new AmbiguousOxideIdentityError(accounts)
  const identity = [...verifiedByAccount.values()][0]
  if (identity) return { kind: "verified", identity }
  return accounts.length > 0 ? { kind: "unverified", accounts } : { kind: "none" }
}

export function requireVerifiedIdentity(
  outcome: OxideIdentityOutcome,
): VerifiedOxideIdentity | undefined {
  if (outcome.kind === "no-generation") {
    throw new OxideIdentityUnavailableError(
      "no published generation binds this deployment's name registry on this rollup",
    )
  }
  if (outcome.kind === "unverified") throw new UnverifiedOxideIdentityError(outcome.accounts)
  return outcome.kind === "verified" ? outcome.identity : undefined
}
