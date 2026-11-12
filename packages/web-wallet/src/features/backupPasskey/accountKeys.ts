import { WalletError } from "@obsidion/core/errors"
import {
  MAX_PASSKEY_CANDIDATES,
  authKeyPubkeyHex,
  createOxideL1Reader,
  deriveBootstrapKey,
  envelopeSlot,
  parseKeyMetadata,
  resolveOxideIdentity,
  type BackupRotationRecord,
  type ParsedKeyMetadata,
  type Query,
  type QueryFactory,
  type ReadonlyStore,
  type RecordSet,
} from "@obsidion/front-core"
import { isPhysicalOnly, providerNameFor } from "@obsidion/passkey-web"
import type { Address } from "viem"
import { l1PublicClient } from "../../config/oxideTuple"
import {
  authenticatorFor,
  type AuthenticatorRecord,
} from "../../platform/auth/WebPasskeyIdentityMap"
import type { Session } from "../../session/session"
import { generationAddresses } from "../registration/generationAddresses"
import { loadOxideGenerations } from "../registration/oxideGenerations"

export type KeyLabel = "Sign-up" | "Backup" | "Unknown key"

export type Row = {
  pubkeyHex: string
  label: KeyLabel
  signsHere: boolean
  /** The passkey manager, where this browser recorded it at creation. */
  provider?: string
}

export type AccountKeys = {
  rows: Row[]
  authKeyCount: number
  /** The L1 account the keys are installed on. */
  owner: Address
  /** The key signing this session, hex. */
  session: string
}

type AccountKeysParts = Pick<Session, "page" | "auth" | "device" | "wallet" | "contractService">

/** The sign-up passkey keeps its raw credential id; a backup passkey carries an envelope the opener accepts. */
export function keyLabel(parsed: ParsedKeyMetadata): KeyLabel {
  if (parsed.kind === "credential-id") return "Sign-up"
  if (parsed.kind !== "envelope-prefixed") return "Unknown key"
  try {
    envelopeSlot(parsed.envelope)
    return "Backup"
  } catch {
    return "Unknown key"
  }
}

async function readAccountKeys(
  own: AccountKeysParts,
  address: string,
  signal: AbortSignal,
): Promise<AccountKeys | "unverified"> {
  const { page, auth, device } = own
  const keys = await auth.sessionKeys()
  if (!keys) throw new WalletError("account.locked", "wallet locked")
  const [wallet, contractService] = await Promise.all([
    own.wallet.ready(signal),
    own.contractService.ready(signal),
  ])
  const generations = await loadOxideGenerations(wallet, contractService, page)
  const bootstrap = deriveBootstrapKey(keys.secretKey).address
  const session = (await keys.authProvider.getPubkeys())
    .map((part) => part.toString("hex"))
    .join("")
  const identity = await resolveOxideIdentity(
    generations,
    bootstrap,
    address,
    generationAddresses(page, `0x${session}`)(keys.secretKey, address),
  )
  // An account the catalog shows and does not verify, or none at all, is not registered; a read
  // that could not conclude is a failed read, so it gets a retry rather than that verdict.
  if (identity.kind === "unverified" || identity.kind === "none") return "unverified"
  if (identity.kind !== "verified") throw new WalletError("unknown", `identity ${identity.kind}`)
  const { entries, authKeyCount } = await createOxideL1Reader(
    l1PublicClient(page.config),
  ).readAuthKeysCounted(identity.identity.account, MAX_PASSKEY_CANDIDATES)
  const rows = entries.map((entry): Row => {
    const pubkeyHex = authKeyPubkeyHex(entry) ?? `${entry.key.qx.slice(2)}${entry.key.qy.slice(2)}`
    return {
      pubkeyHex,
      label: keyLabel(parseKeyMetadata(entry.metadata)),
      signsHere: pubkeyHex === session,
      provider: providerFor(authenticatorFor(device.get().passkeyMap, pubkeyHex)),
    }
  })
  return { rows, authKeyCount, owner: identity.identity.account, session }
}

/** The manager this browser recorded for a key; a hardware key no table names is called what it is. */
function providerFor(record: AuthenticatorRecord | undefined): string | undefined {
  if (!record) return undefined
  const named = providerNameFor(record.prfAaguid)
  if (named) return named
  const securityKey =
    record.securityKey ||
    record.authenticatorType === "security-key" ||
    Boolean(record.inferredTransports) ||
    isPhysicalOnly(record.transports)
  return securityKey ? "Security key" : undefined
}

/**
 * The passkeys installed on the account at an L2 address, read from L1. Every subscribe reads
 * again while the last read stays on screen.
 */
export const accountKeys = (
  query: QueryFactory,
  own: AccountKeysParts,
): Query<[address: string], AccountKeys | "unverified"> =>
  query<[address: string], AccountKeys | "unverified">("accountKeys", {
    load: (address, signal) => readAccountKeys(own, address, signal),
    stale: 0,
  })

/**
 * Reads the account's keys again when a backup rotation is done: its key was installed well
 * before, so the read lists the backup. Returns the stop.
 */
export function readKeysOnDone(
  keys: ReturnType<typeof accountKeys>,
  rotations: ReadonlyStore<RecordSet<BackupRotationRecord>>,
  identity: Session["identity"],
): () => void {
  const count = () => rotations.get().records.filter((record) => record.phase === "done").length
  let done = count()
  return rotations.subscribe(() => {
    const before = done
    done = count()
    const address = identity.get().value?.address
    if (done > before && address) keys(address).refresh()
  })
}
