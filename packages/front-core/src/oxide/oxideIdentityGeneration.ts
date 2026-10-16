import { getContractAddress, type Address, type Hex } from "viem"
import { predictAccountAddressLocally } from "@oxide/l1-contracts"

import type { OxideL1Reader } from "./oxideRegistration"

export interface IdentityGeneration {
  fpcAddress: string
  accountFactory: Address
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
  /** No account found, but the catalog was incomplete, so none may still exist. */
  | { kind: "inconclusive" }

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
  /** The rollup this device is connected to; the only one a verified identity's `generations` ever names. */
  rollupVersion: string
  /** Rollups a generation or L1 record may admit under, besides `rollupVersion` — e.g. retired
   *  rollups the oxide manifest still names. Defaults to `{rollupVersion}` alone. */
  admissibleRollupVersions?: ReadonlySet<string>
  /** A source of `catalog` failed to load, so finding no account proves nothing. */
  catalogIncomplete?: boolean
}

const sameAddress = (left: string, right: string) => left.toLowerCase() === right.toLowerCase()

export const isZeroHash = (value: string) => /^0x0*$/.test(value)

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
  const admissibleRollupVersions = deps.admissibleRollupVersions ?? new Set([deps.rollupVersion])
  const metadataRegistry = readOnce(() => deps.reader.readAccountMetadataRegistry(deps.registry))
  const registryBehind = readOncePerAddress((portal: Address) =>
    deps.reader.readNamePortalRegistry(portal),
  )
  const cloneTargetOf = readOncePerAddress((factory: Address) =>
    deps.reader.readFactoryImplementation(factory),
  )

  // Admission, not authentication: the portal's registry answer proves nothing, and the local prediction
  // assumes the factory clones its nonce-1 deployment. Only the name read below trusts anything.
  const bindsThisRegistry = async (generation: IdentityGeneration) => {
    if (!admissibleRollupVersions.has(generation.rollupVersion)) return false
    if (!sameAddress(await registryBehind(generation.namePortal), deps.registry)) return false
    return sameAddress(
      await cloneTargetOf(generation.accountFactory),
      getContractAddress({ from: generation.accountFactory, nonce: 1n }),
    )
  }

  const verifiedByAccount = new Map<string, VerifiedOxideIdentity>()
  const named = new Map<string, Address>()
  let admitted = 0
  for (const generation of deps.catalog) {
    if (!(await bindsThisRegistry(generation))) continue
    admitted += 1
    const account = predictAccountAddressLocally(generation.accountFactory, bootstrap)
    const key = account.toLowerCase()
    const verified = verifiedByAccount.get(key)
    if (verified) {
      // Admission accepts any admissible rollup, but a sponsorship consumer must never see a
      // retired rollup's ClaimFPC as a live target on this one.
      if (generation.rollupVersion === deps.rollupVersion) verified.generations.push(generation)
      continue
    }
    if (named.has(key)) continue
    const nameHash = await deps.reader.readNameOf(deps.registry, account)
    if (isZeroHash(nameHash)) continue
    named.set(key, account)
    const record = await deps.reader.readUserRecord(await metadataRegistry(), account)
    if (!record || !sameAddress(record.l2Address, l2Address)) continue
    if (!admissibleRollupVersions.has(record.rollupVersion.toString())) continue
    const onCurrentRollup = generation.rollupVersion === deps.rollupVersion
    verifiedByAccount.set(key, { account, nameHash, generations: onCurrentRollup ? [generation] : [] })
  }

  if (admitted === 0) return { kind: "no-generation" }
  const accounts = [...named.values()]
  if (accounts.length > 1) throw new AmbiguousOxideIdentityError(accounts)
  const identity = [...verifiedByAccount.values()][0]
  if (identity) return { kind: "verified", identity }
  if (accounts.length > 0) return { kind: "unverified", accounts }
  return deps.catalogIncomplete ? { kind: "inconclusive" } : { kind: "none" }
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
  // `undefined` sends the caller to a name claim. After a partial read, that would give the
  // account the read missed a second name.
  if (outcome.kind === "inconclusive") {
    throw new OxideIdentityUnavailableError("part of the identity catalog failed to load")
  }
  return outcome.kind === "verified" ? outcome.identity : undefined
}
