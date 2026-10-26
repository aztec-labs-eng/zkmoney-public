import type { BackupRotationRecord, RerootCheckpoints } from "@obsidion/front-core"
import type { AlphaAuthProvider, ObsidionAccount, RecoveryMetadata } from "@obsidion/sdk"

export interface RerootDeps {
  /** The address the account contract derives for `set`. */
  derive(set: readonly string[]): Promise<string>
  /** The session's root passkey, as the identity map names it. */
  root: { credentialId: string; pubkeyHex: string }
  /** The root's record for the one-key account; its fields carry over to the two-key one, never a `backup`. */
  rootRecord(): Promise<RecoveryMetadata | undefined>
  writeRecord(meta: RecoveryMetadata & { userHandle?: string }): Promise<void>
  /** The root passkey's signer over `set`. */
  providerFor(set: readonly string[]): AlphaAuthProvider
  /**
   * Installs `provider` as the session's signer; the stored session keeps its key and credential.
   * Throws when the session ended under it; returns whether that session is still held.
   */
  commit(provider: AlphaAuthProvider): Promise<() => boolean>
  account(provider: AlphaAuthProvider): Promise<ObsidionAccount>
  /** Saves `account` as the browser's account and moves the identity to its address. */
  persist(account: ObsidionAccount): Promise<void>
  /** Hands the page the account it now runs on. */
  switchAccount(account: ObsidionAccount): void
}

const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const hex0x = (hex: string) => (hex.startsWith("0x") ? hex : `0x${hex}`)

/**
 * Makes this browser the two-key wallet once the key is installed: the identity map names the set
 * under both passkeys, the session signs over it, the saved account and the identity move to the
 * two-key address, and the page switches. Every step is written again on a resume; none is undone.
 * The deposit gateway rebuilds its account from the new signer on its next pass.
 */
export async function rerootToPasskeySet(
  deps: RerootDeps,
  record: BackupRotationRecord,
  checkpoint: (fields: RerootCheckpoints) => Promise<void>,
): Promise<RerootCheckpoints> {
  const { plan, backup } = record
  if (!plan || !backup.envelopeHex) throw new Error("nothing signed to install")
  const set = [deps.root.pubkeyHex, backup.pubkeyHex]
  const address = await deps.derive(set)
  if (!sameHex(address, plan.address)) {
    throw new Error("the two-key address does not match the signed change")
  }

  const stored = await deps.rootRecord()
  const { backup: _, ...root } = stored ?? {}
  await deps.writeRecord({
    ...root,
    credentialId: deps.root.credentialId,
    l2Address: address,
    pubkey: stored?.pubkey ?? deps.root.pubkeyHex,
    isMskRoot: true,
    passkeySet: set,
  })
  await deps.writeRecord({
    credentialId: backup.credentialId,
    l2Address: address,
    pubkey: backup.pubkeyHex,
    isMskRoot: false,
    backup: { account: record.owner, envelope: hex0x(backup.envelopeHex) },
    passkeySet: set,
    prfSlot: backup.prfSlot,
    ...(backup.prfAaguid ? { prfAaguid: backup.prfAaguid } : {}),
    authenticatorType: backup.securityKey ? "security-key" : "platform",
    ...(backup.transports ? { transports: backup.transports } : {}),
    userHandle: backup.userHandle,
  })

  const provider = deps.providerFor(set)
  const held = await deps.commit(provider)
  const account = await deps.account(provider)
  // A sign-out that landed meanwhile owns the session: nothing more is saved or shown for it.
  if (!held()) throw new Error("the session changed")
  await deps.persist(account)
  if (!held()) throw new Error("the session changed")
  deps.switchAccount(account)
  await checkpoint({ switched: true })
  return { switched: true, rebound: true }
}
