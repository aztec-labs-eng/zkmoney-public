import { useEffect, useState } from "react"
import {
  GlassCircleButton,
  GradientText,
  Icon,
  IconCircle,
  SettingsRow,
  StatusPill,
} from "@obsidion/web-ds"
import {
  MAX_PASSKEY_CANDIDATES,
  authKeyPubkeyHex,
  createOxideL1Reader,
  deriveBootstrapKey,
  envelopeSlot,
  parseKeyMetadata,
  resolveOxideIdentity,
  type ParsedKeyMetadata,
  useStore,
  serviceStatus,
} from "@obsidion/front-core"
import { isPhysicalOnly, providerNameFor } from "@obsidion/passkey-web"
import type { Address } from "viem"
import { backupPasskeySettingsEnabled } from "../config/features"
import { l1PublicClient } from "../config/oxideTuple"
import { BackupPasskeyHost } from "../features/backupPasskey/BackupPasskeyHost/BackupPasskeyHost"
import { panelCopy } from "../features/backupPasskey/backupPasskeyCopy"
import type { EntryAction } from "../features/backupPasskey/backupPasskeyEntry"
import { useBackupRotation } from "../features/backupPasskey/backupRotations"
import type { BackupKey, KeysRead } from "../features/backupPasskey/backupScreen"
import { hostSheetShows } from "../features/backupPasskey/screens/KeysScreen/keysSheet"
import { generationAddresses } from "../features/registration/generationAddresses"
import { loadOxideGenerations } from "../features/registration/oxideGenerations"
import { authenticatorFor, type AuthenticatorRecord } from "../platform/auth/WebPasskeyIdentityMap"
import { Modal } from "./Modal"
import { MAX_PASSKEY_NAME, savePasskeyName } from "./passkeyNames"
import { useSession, type Session } from "../session/session"

type KeyLabel = "Sign-up" | "Backup" | "Unknown key"

type Row = {
  pubkeyHex: string
  label: KeyLabel
  signsHere: boolean
  /** The passkey manager, where this browser recorded it at creation. */
  provider?: string
}

type AccountKeys = {
  rows: Row[]
  authKeyCount: number
  /** The L1 account the keys are installed on. */
  owner: Address
  /** The key signing this session, hex. */
  session: string
}

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
  own: Pick<Session, "page" | "auth" | "device" | "wallet" | "contractService">,
  address: string | undefined,
): Promise<AccountKeys | "unverified"> {
  const { page, auth, device } = own
  const keys = await auth.sessionKeys()
  if (!keys || !address) throw new Error("wallet locked")
  const [wallet, contractService] = await Promise.all([
    own.wallet.ready(),
    own.contractService.ready(),
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
  if (identity.kind !== "verified") throw new Error(`identity ${identity.kind}`)
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

/** A key's name from the user, else its manager. */
const keyName = (row: Row, name?: string) => name || row.provider

const ROLES = { "Sign-up": "sign-up", "Backup": "backup", "Unknown key": "unknown" } as const

const backupKey = (row: Row, name?: string): BackupKey => ({
  pubkeyHex: row.pubkeyHex,
  role: ROLES[row.label],
  signsHere: row.signsHere,
  ...(name && { name }),
  ...(row.provider && { provider: row.provider }),
})

/**
 * One installed passkey: named by the user, else by its manager, else by its role, which then
 * sits under the name. The pencil edits the name in place; Enter or the check saves it.
 */
function KeyRow({
  row,
  name,
  onRename,
}: {
  row: Row
  name?: string
  onRename: (name: string) => void
}) {
  const [draft, setDraft] = useState<string>()
  const icon = row.label === "Backup" ? "shield-check" : "key"
  const named = keyName(row, name)
  const description = named ? row.label : undefined
  if (draft !== undefined) {
    const save = () => {
      onRename(draft)
      setDraft(undefined)
    }
    return (
      <div
        className={`zkm-settings-row ww-passkeys__row${
          description ? " zkm-settings-row--described" : ""
        }`}
      >
        <span className="zkm-settings-row__leading">
          <IconCircle name={icon} />
        </span>
        <input
          className="zkm-settings-row__label ww-passkeys__name"
          aria-label="Passkey name"
          value={draft}
          maxLength={MAX_PASSKEY_NAME}
          placeholder={row.provider ?? row.label}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save()
            if (e.key === "Escape") setDraft(undefined)
          }}
          data-testid="passkey-name"
        />
        {description ? (
          <span className="zkm-settings-row__description">{description}</span>
        ) : (
          <span className="zkm-row-spacer" />
        )}
        <span className="zkm-settings-row__trailing">
          <GlassCircleButton
            size={32}
            ariaLabel="Save name"
            onClick={save}
            testId="passkey-name-save"
          >
            <Icon name="check" size={14} color="var(--ink)" />
          </GlassCircleButton>
        </span>
      </div>
    )
  }
  return (
    <SettingsRow
      className="ww-passkeys__row"
      leading={<IconCircle name={icon} />}
      label={named ?? row.label}
      description={description}
      trailing={
        <span className="ww-passkeys__trailing">
          {row.signsHere && <StatusPill label="Signed in with" icon="check" />}
          <GlassCircleButton
            size={32}
            ariaLabel="Rename"
            onClick={() => setDraft(name ?? "")}
            testId="passkey-rename"
          >
            <Icon name="pencil" size={14} color="var(--ink)" />
          </GlassCircleButton>
        </span>
      }
    />
  )
}

/** The passkeys installed on the account, read from L1, with the one signing this session marked. */
export function PasskeysModal({
  onClose,
  onAction,
}: {
  onClose: () => void
  /** Where an entry condition sends the user. */
  onAction?: (action: EntryAction) => void
}) {
  const session = useSession()
  const contracts = useStore(session.contractService, serviceStatus)
  const { database, device, identity, page } = session
  const walletBuilt = useStore(session.wallet, serviceStatus) === "ready"
  const [keys, setKeys] = useState<AccountKeys | "unreadable" | "unverified">()
  const names = useStore(device, (s) => s.passkeyNames)
  const [reads, setReads] = useState(0)
  const readAgain = () => {
    setKeys(undefined)
    setReads((n) => n + 1)
  }

  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (contracts !== "ready" || !walletBuilt) {
      setKeys("unreadable")
      return
    }
    let cancelled = false
    readAccountKeys(session, identity.get().value?.address).then(
      (read) => {
        if (cancelled) return
        setKeys(read)
        if (typeof read === "object" && read.authKeyCount > 1)
          page.backupReminder.seenOnChain.set(true)
      },
      () => {
        if (!cancelled) setKeys("unreadable")
      },
    )
    return () => {
      cancelled = true
    }
  }, [session, page, identity, contracts, walletBuilt, reads])

  const read: KeysRead =
    typeof keys === "object"
      ? {
          keys: keys.rows.map((row) => backupKey(row, names[row.pubkeyHex])),
          count: keys.authKeyCount,
        }
      : keys
  // The record the host reads.
  const saved = useBackupRotation(typeof keys === "object" ? keys.owner : undefined)
  const list =
    (keys === "unverified" || typeof keys === "object") &&
    !hostSheetShows(keys === "unverified" ? 0 : keys.rows.length, saved)
  // The modal's title stays over its own list and its key-read lines. With the flag on, the
  // backup's own sheet says the keys did not read.
  const unreadLine = keys === "unreadable" && !backupPasskeySettingsEnabled
  const own = list || keys === undefined || unreadLine

  return (
    <Modal variant="create" label="Passkeys" onClose={onClose} className="ww-feedback">
      {own && (
        <div className="ww-passkeys__head">
          <span className="ww-deposit__connect-icon">
            <Icon name="key" size={24} color="#fff" />
          </span>
          <GradientText gradient="title" size={24} weight={700} style={{ textAlign: "center" }}>
            Passkeys
          </GradientText>
        </div>
      )}
      {/* A sheet of the host's scrolls with the modal, not in a box of its own. */}
      <div className={own ? "ww-addresses ww-passkeys" : "ww-passkeys__host"}>
        {keys === undefined && <p className="ww-sheet__note">Loading…</p>}
        {unreadLine && (
          <p className="ww-sheet__note">
            Couldn't read the account's keys.{" "}
            <button
              type="button"
              className="zkm-btn-reset ww-deposit__link"
              onClick={readAgain}
              data-testid="keys-retry"
            >
              {panelCopy.tryAgain}
            </button>
          </p>
        )}
        {keys === "unverified" && list && (
          <p className="ww-sheet__note">Keys appear once the account is registered.</p>
        )}
        {typeof keys === "object" && list && (
          <section className="ww-contacts__section">
            <span className="ww-contacts__label">Keys on the account</span>
            <div className="ww-contacts__group">
              {keys.rows.map((row) => (
                <KeyRow
                  key={row.pubkeyHex}
                  row={row}
                  name={names[row.pubkeyHex]}
                  onRename={(name) => savePasskeyName(database, row.pubkeyHex, name)}
                />
              ))}
            </div>
            {keys.authKeyCount > keys.rows.length && (
              <p className="ww-sheet__note">
                The account has {keys.authKeyCount} keys; this version shows {keys.rows.length}.
              </p>
            )}
          </section>
        )}
        <BackupPasskeyHost
          keys={read}
          {...(typeof keys === "object" && { owner: keys.owner })}
          {...(onAction && { onAction })}
          onReadKeys={readAgain}
          onClose={onClose}
        />
      </div>
    </Modal>
  )
}
