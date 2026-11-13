/**
 * A session catches up with a backup passkey added on another device: from its first balance on,
 * and for as long as it is open, it asks the tag's user record whether the wallet moved to a
 * two-key account and, when it did, adopts that account and reloads the page into it.
 */
import {
  MAX_PASSKEY_CANDIDATES,
  createOxideL1Reader,
  deriveBootstrapKey,
  rerootPending,
  resolveOxideIdentity,
  task,
  type BoundedAuthKeys,
  type OxideIdentityDeps,
  type Service,
  type Task,
} from "@obsidion/front-core"
import { WalletError } from "@obsidion/core/errors"
import type {
  ContractService,
  ObsidionAccount,
  ObsidionWallet,
  PrfSlot,
  RecoveryMetadata,
} from "@obsidion/sdk"
import type { Address } from "viem"
import { l1PublicClient } from "../config/oxideTuple"
import { rotationView, savedRotations } from "../features/backupPasskey/backupRotations"
import { markMovedAccount, movedAccount, sameAddress } from "../features/identity/movedAccount"
import {
  accountSaved,
  adoptRecoveredAccount,
  deriveAddressWith,
  markCommitted,
  recoveryRecord,
} from "../features/identity/passkeyAccount"
import { generationAddresses } from "../features/registration/generationAddresses"
import { loadOxideGenerations } from "../features/registration/oxideGenerations"
import { unlockedSessionKeys } from "../features/registration/registrationResume"
import { SessionChangedError } from "../platform/auth/sessionErrors"
import { saveIdentity, type OnboardingKeys } from "../session/account"
import type { PageFacts } from "../session/pageChain"
import { signedInAccount, type Session } from "../session/session"
import { reloadIfSessionSwitched } from "../session/sessionReload"
import { stillCommitted } from "../session/stillCommitted"

/** What the catch-up reads and writes of its session. */
export type CatchUpSession = Pick<
  Session,
  | "auth"
  | "device"
  | "database"
  | "namespace"
  | "page"
  | "identity"
  | "backupRotations"
  | "accountRecord"
  | "sessionLock"
>

/** What the catch-up reads of the chain and writes of the page; a test passes fakes. */
export interface CatchUpDeps {
  /** The unlocked session's keys; undefined while locked. */
  sessionKeys: (
    session: Pick<Session, "auth">,
    wallet: ObsidionWallet,
  ) => Promise<OnboardingKeys | undefined>
  generations: (
    wallet: ObsidionWallet,
    contractService: ContractService,
    page: PageFacts,
  ) => Promise<OxideIdentityDeps>
  /** At most {@link MAX_PASSKEY_CANDIDATES} of the account's installed keys, with its total count. */
  readAuthKeys: (page: PageFacts, account: Address) => Promise<BoundedAuthKeys>
  saveIdentity: typeof saveIdentity
  reload: typeof reloadIfSessionSwitched
}

export const liveCatchUpDeps: CatchUpDeps = {
  sessionKeys: unlockedSessionKeys,
  generations: loadOxideGenerations,
  readAuthKeys: (page, account) =>
    createOxideL1Reader(l1PublicClient(page.config)).readAuthKeysCounted(
      account,
      MAX_PASSKEY_CANDIDATES,
    ),
  saveIdentity,
  reload: reloadIfSessionSwitched,
}

/** How often an open session asks again, shown and hidden. */
const RECHECK_MS = 60_000
const RECHECK_HIDDEN_MS = 5 * 60_000

/**
 * Runs after the first balance, then every minute while shown, every five while hidden, and at
 * once on show, so a session left open while a backup is added elsewhere follows the move. Hiding
 * never aborts a run, which may be past its commit. A failed read backs off. The adding device's
 * own rotation, loaded or still loading, holds it off: that device switches itself. The catalog is
 * read once per wallet; a recheck reads only the chain's record and keys.
 */
export function movedAccountCatchUp(
  needs: {
    session: CatchUpSession
    wallet: Service<ObsidionWallet>
    account: Service<ObsidionAccount>
    contractService: Service<ContractService>
  },
  deps: CatchUpDeps = liveCatchUpDeps,
): Task {
  let read:
    | { wallet: ObsidionWallet; contractService: ContractService; generations: OxideIdentityDeps }
    | undefined
  const checkDeps: CatchUpDeps = {
    ...deps,
    generations: async (wallet, contractService, page) => {
      if (read?.wallet === wallet && read.contractService === contractService)
        return read.generations
      const generations = await deps.generations(wallet, contractService, page)
      // An incomplete catalog proves nothing: the next check reads it again.
      if (!generations.catalogIncomplete) read = { wallet, contractService, generations }
      return generations
    },
  }
  return task("movedAccountCatchUp", {
    needs: { wallet: needs.wallet, account: needs.account, contractService: needs.contractService },
    after: { firstBalance: true },
    every: RECHECK_MS,
    whenHidden: RECHECK_HIDDEN_MS,
    backoff: { baseMs: 10_000, maxMs: 5 * 60_000 },
    run: ({ wallet, contractService, signal }) =>
      catchUpMovedAccount(needs.session, wallet, contractService, signal, checkDeps),
  })
}

/**
 * The check and the switch. Nothing is written unless the tag's record names the two-key account
 * the session's key and one more derive; the adoption then commits, rewrites the record under the
 * new session and saves its snapshot, and the page reloads into it. A run that failed past its
 * commit left the session on the two-key account with some of those writes undone; the next run
 * finds the session there and finishes them, with no second commit.
 */
export async function catchUpMovedAccount(
  session: CatchUpSession,
  wallet: ObsidionWallet,
  contractService: ContractService,
  signal: AbortSignal,
  deps: CatchUpDeps = liveCatchUpDeps,
): Promise<void> {
  const { auth, device } = session
  const keys = await deps.sessionKeys(session, wallet)
  // Another account's sign-in reloads the page: this session's run writes nothing for it.
  if (!keys || !stillCommitted(session)) return
  const current = keys.account.getAddress().toString()
  const saved = savedRotations(rotationView(session).get())
  if (saved === "loading") throw new WalletError("wallet.notReady", "backup rotations not read")
  if (saved === "unreadable" || rerootPending(saved, current)) return
  const { credentialId } = device.get()
  if (!credentialId) return
  // The record is read at the address it names: the one before, when the run that committed the
  // move failed to rewrite it.
  const recorded = (await auth.sessionAddress()) ?? current
  const record = await auth.accountRecord(recorded)
  if (!record || record.credentialId !== credentialId || !record.prfSlot) return
  const slot = record.prfSlot
  // A rotation saved on this device since the reads began switches the account itself.
  const owns = () => {
    const now = savedRotations(rotationView(session).get())
    return (
      !signal.aborted &&
      stillCommitted(session) &&
      device.get().credentialId === credentialId &&
      typeof now !== "string" &&
      !rerootPending(now, current)
    )
  }
  const { page } = session
  const generations = await deps.generations(wallet, contractService, page)
  const bootstrap = deriveBootstrapKey(keys.secretKey).address
  const outcome = await resolveOxideIdentity(
    generations,
    bootstrap,
    recorded,
    generationAddresses(page, keys.pubkeyHex)(keys.secretKey, recorded),
  )
  if (outcome.kind === "verified") {
    if (sameAddress(recorded, current)) await finishSwitch(session, deps, keys, record, slot, owns)
    return
  }
  if (outcome.kind !== "unverified") return
  const moved = await movedAccount({
    generations,
    bootstrap,
    accounts: outcome.accounts,
    record,
    msk: keys.secretKey,
    readAuthKeys: (account) => deps.readAuthKeys(page, account),
    derive: (msk, passkeys) => deriveAddressWith(wallet, passkeys)(msk),
  })
  if (!moved) return
  // The session already holds the moved account: a run before committed it and failed to record it.
  if (sameAddress(moved.address, current)) {
    return finishSwitch(session, deps, keys, record, slot, owns, moved.passkeys)
  }
  const { held, session: committed } = await adoptRecoveredAccount(
    wallet,
    { session: { auth, device, page: session.page }, accounts: () => signedInAccount(session) },
    {
      credentialId: record.credentialId,
      pubkey: record.pubkey,
      passkeys: moved.passkeys,
      staleSet: record.passkeySet ?? [record.pubkey],
      expectedAddress: recorded,
      backup: record.backup,
      transports: record.transports,
      authProvider: auth.providerFor({
        credentialId,
        pubkeyHex: record.pubkey,
        passkeys: moved.passkeys,
      }),
    },
    keys.secretKey,
    slot,
    moved.address,
    signal,
    undefined,
    owns,
  )
  // Written only while this commit still owns the session.
  try {
    await committed.sessionLock(async () => {
      if (!held()) throw new SessionChangedError()
      await moveIdentity(session, deps, moved.address, held)
      if (!held()) throw new SessionChangedError()
    })
  } catch (err) {
    throw markCommitted(err)
  }
  markMovedAccount(moved.address)
  deps.reload(session, moved.address)
}

/** The identity row follows the account; a row naming the address already, or none, stays. */
async function moveIdentity(
  session: Pick<Session, "identity" | "page">,
  deps: Pick<CatchUpDeps, "saveIdentity">,
  address: string,
  stillOwns?: () => boolean,
): Promise<void> {
  const identity = session.identity.get().value
  if (!identity || sameAddress(identity.address, address)) return
  await deps.saveIdentity(session.page, { ...identity, address }, stillOwns)
}

/**
 * The writes of a switch to the account the session holds, each where it still names the one
 * before: the record, when `passkeys` (the set it moved to) is given, the snapshot, and the identity
 * row. Written while this session's account is the committed one, and a page whose stores loaded
 * for the one before reloads. Home says the wallet moved only when the record moved here.
 */
async function finishSwitch(
  session: CatchUpSession,
  deps: Pick<CatchUpDeps, "saveIdentity" | "reload">,
  keys: OnboardingKeys,
  record: RecoveryMetadata,
  slot: PrfSlot,
  owns: () => boolean,
  passkeys?: readonly string[],
): Promise<void> {
  const address = keys.account.getAddress().toString()
  const snapshot = accountSaved(keys.account, record.credentialId, record.pubkey)
  const stored = await session.accountRecord?.get()
  const staleSnapshot = stored !== undefined && stored.completeAddress !== snapshot.completeAddress
  const before = session.identity.get().value?.address
  const staleIdentity = before !== undefined && !sameAddress(before, address)
  if (passkeys === undefined && !staleSnapshot && !staleIdentity) return
  await session.sessionLock(async () => {
    if (!owns()) throw new SessionChangedError()
    if (passkeys) {
      await session.auth.recordRecoveryMetadata(
        recoveryRecord({ ...record, passkeys }, address, slot),
        owns,
      )
    }
    if (staleSnapshot) await signedInAccount(session).apply(snapshot)
    if (staleIdentity) await moveIdentity(session, deps, address, owns)
    if (!owns()) throw new SessionChangedError()
  })
  if (passkeys) markMovedAccount(address)
  deps.reload(session, address)
}
