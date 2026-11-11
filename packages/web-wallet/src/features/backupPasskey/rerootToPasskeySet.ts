import type { BackupRotationRecord, RerootCheckpoints } from "@obsidion/front-core"
import { WalletError } from "@obsidion/front-core"
import type { AlphaAuthProvider, ObsidionAccount, RecoveryMetadata } from "@obsidion/sdk"
import type { StoredRecoveryMetadata } from "../../platform/auth/WebPasskeyIdentityMap"

/** How a re-root ends once the session it started on is gone: nothing more is saved or shown. */
export const sessionChanged = () => new WalletError("aborted", "the session changed")

export interface RerootDeps {
  /** The address the account contract derives for `set`. */
  derive(set: readonly string[]): Promise<string>
  /** The session's root passkey, as the identity map names it. */
  root: { credentialId: string; pubkeyHex: string }
  /** The root's record for the one-key account; its fields carry over to the two-key one, never a `backup`. */
  rootRecord(): Promise<RecoveryMetadata | undefined>
  /** Snapshots the session the re-root starts on; the returned check fails once it ends. */
  session(): () => boolean
  /** The root passkey's signer over `set`. */
  providerFor(set: readonly string[]): AlphaAuthProvider
  account(provider: AlphaAuthProvider): Promise<ObsidionAccount>
  /**
   * Saves `records` and `account` as the browser's account in one write, which throws and saves
   * nothing unless `held()` inside it. A reload's cached-key check needs the session's record and
   * the saved account to name the same address.
   */
  persist(
    account: ObsidionAccount,
    records: readonly StoredRecoveryMetadata[],
    held: () => boolean,
  ): Promise<void>
  /**
   * Installs `provider` as the session's signer; the stored session keeps its key and credential.
   * Throws when the session ended under it.
   */
  commit(provider: AlphaAuthProvider): Promise<void>
  /**
   * Points the identity at `account`'s address. The action gate opens once it moves, so it follows
   * the switch to `account`.
   */
  moveIdentity(account: ObsidionAccount): Promise<void>
  /** Hands the page the account it now runs on. */
  switchAccount(account: ObsidionAccount): void
}

const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
const hex0x = (hex: string) => (hex.startsWith("0x") ? hex : `0x${hex}`)

/**
 * Makes this browser the two-key wallet once the key is installed: the identity map names the set
 * under both passkeys and the saved account moves to the two-key address in one write, the session
 * signs over the set, the page switches, and the identity follows. Nothing is saved until the
 * account is built, so a reload during the build finds the one-key wallet. Every step is written
 * again on a resume; none is undone. The deposit gateway rebuilds its account from the new signer
 * on its next pass.
 */
export async function rerootToPasskeySet(
  deps: RerootDeps,
  record: BackupRotationRecord,
  checkpoint: (fields: RerootCheckpoints) => Promise<void>,
): Promise<RerootCheckpoints> {
  const { plan, backup } = record
  if (!plan || !backup.envelopeHex) throw new Error("nothing signed to install")
  const held = deps.session()
  const set = [deps.root.pubkeyHex, backup.pubkeyHex]
  const address = await deps.derive(set)
  if (!sameHex(address, plan.address)) {
    throw new Error("the two-key address does not match the signed change")
  }

  const stored = await deps.rootRecord()
  const { backup: _, ...root } = stored ?? {}
  const records: StoredRecoveryMetadata[] = [
    {
      ...root,
      credentialId: deps.root.credentialId,
      l2Address: address,
      pubkey: stored?.pubkey ?? deps.root.pubkeyHex,
      isMskRoot: true,
      passkeySet: set,
    },
    {
      credentialId: backup.credentialId,
      l2Address: address,
      pubkey: backup.pubkeyHex,
      isMskRoot: false,
      backup: { account: record.owner, envelope: hex0x(backup.envelopeHex) },
      passkeySet: set,
      prfSlot: backup.prfSlot,
      ...(backup.prfAaguid ? { prfAaguid: backup.prfAaguid } : {}),
      authenticatorType: backup.securityKey ? "security-key" : "platform",
      ...(backup.securityKey ? { securityKey: true } : {}),
      ...(backup.transports ? { transports: backup.transports } : {}),
      userHandle: backup.userHandle,
    },
  ]

  const provider = deps.providerFor(set)
  const account = await deps.account(provider)
  // A sign-out that landed meanwhile owns the session: nothing more is saved or shown for it.
  if (!held()) throw sessionChanged()
  await deps.persist(account, records, held)
  // The signer changes only once the records name its address: the previous-account watcher
  // searches again on a new signer, so a search before the save would find nothing for good.
  await deps.commit(provider)
  deps.switchAccount(account)
  await deps.moveIdentity(account)
  await checkpoint({ switched: true })
  return { switched: true, rebound: true }
}
