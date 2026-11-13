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
  UNREAD,
  useStore,
  serviceStatus,
  type QueryEntry,
  type QueryState,
} from "@obsidion/front-core"
import { backupPasskeySettingsEnabled } from "../config/features"
import type { AccountKeys, Row } from "../features/backupPasskey/accountKeys"
import { BackupPasskeyHost } from "../features/backupPasskey/BackupPasskeyHost/BackupPasskeyHost"
import { panelCopy } from "../features/backupPasskey/backupPasskeyCopy"
import type { EntryAction } from "../features/backupPasskey/backupPasskeyEntry"
import { useBackupRotation } from "../features/backupPasskey/backupRotations"
import {
  pendingRecord,
  selectSheetClose,
  type BackupKey,
  type KeysRead,
} from "../features/backupPasskey/backupScreen"
import { useRotationDrive } from "../features/backupPasskey/rotationDrive"
import { LeaveSheet } from "../features/backupPasskey/screens/LeaveSheet/LeaveSheet"
import { hostSheetShows } from "../features/backupPasskey/screens/KeysScreen/keysSheet"
import { Modal } from "./Modal"
import { MAX_PASSKEY_NAME, savePasskeyName } from "./passkeyNames"
import copy from "./PasskeysModal.copy"
import { fmt } from "../lib/fmt"
import { useSession } from "../session/session"

type KeysState = QueryState<AccountKeys | "unverified">

const failedAt = (entry?: QueryEntry<AccountKeys | "unverified">): KeysState | undefined => {
  const at = entry?.get()
  return at?.status === "failed" ? at : undefined
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
  const address = useStore(identity, (s) => s.value?.address)
  const entry =
    contracts === "ready" && walletBuilt && address ? session.accountKeys(address) : undefined
  const state: KeysState = useStore(entry ?? UNREAD)
  const names = useStore(device, (s) => s.passkeyNames)
  // The state a retry, or showing an entry whose read failed, waits to see replaced.
  const [waiting, setWaiting] = useState(() => ({ entry, state: failedAt(entry) }))
  if (waiting.entry !== entry) setWaiting({ entry, state: failedAt(entry) })
  const readAgain = () => {
    if (!entry) return
    entry.refresh()
    setWaiting({ entry, state: entry.get() })
  }
  // Keys whose last re-read failed stay hidden until the next read lands.
  const settled =
    state !== waiting.state &&
    !(state.status === "ready" && state.error !== undefined && state.refreshing)
  const keys: AccountKeys | "unreadable" | "unverified" | undefined = !entry
    ? "unreadable"
    : !settled || state.status === "pending"
    ? undefined
    : state.status === "failed" || state.error !== undefined
    ? "unreadable"
    : state.value
  const refreshing = settled && state.status === "ready" && state.refreshing

  // The record the host reads.
  const saved = useBackupRotation(typeof keys === "object" ? keys.owner : undefined)
  // eslint-disable-next-line local/effect-hook -- debt
  useEffect(() => {
    if (
      state.status === "ready" &&
      !state.refreshing &&
      state.error === undefined &&
      typeof state.value === "object" &&
      state.value.authKeyCount > 1
    )
      page.backupReminder.seenOnChain.set(true)
  }, [page, state])

  const read: KeysRead =
    typeof keys === "object"
      ? {
          keys: keys.rows.map((row) => backupKey(row, names[row.pubkeyHex])),
          count: keys.authKeyCount,
        }
      : keys
  const list =
    (keys === "unverified" || typeof keys === "object") &&
    !hostSheetShows(keys === "unverified" ? 0 : keys.rows.length, saved)
  // The modal's title stays over its own list and its key-read lines. With the flag on, the
  // backup's own sheet says the keys did not read.
  const unreadLine = keys === "unreadable" && !backupPasskeySettingsEnabled
  const own = list || keys === undefined || unreadLine
  const record = pendingRecord(read, saved)
  const drive = useRotationDrive(record?.owner ?? "")
  const closing = selectSheetClose(record, drive)
  const [leaving, setLeaving] = useState(false)
  if (leaving && closing !== "asks") setLeaving(false)

  return (
    <>
      <Modal
        variant="create"
        label={copy.title}
        onClose={closing === "asks" ? () => setLeaving(true) : onClose}
        closeOnBackdrop={closing === "closes"}
        className="ww-feedback"
      >
        {own && (
          <div className="ww-passkeys__head">
            <span className="ww-deposit__connect-icon">
              <Icon name="key" size={24} color="#fff" />
            </span>
            <GradientText gradient="title" size={24} weight={700} style={{ textAlign: "center" }}>
              {copy.title}
            </GradientText>
          </div>
        )}
        {/* A sheet of the host's scrolls with the modal, not in a box of its own. */}
        <div className={own ? "ww-addresses ww-passkeys" : "ww-passkeys__host"}>
          {keys === undefined && <p className="ww-sheet__note">{copy.loading}</p>}
          {unreadLine && (
            <p className="ww-sheet__note">
              {copy.unreadable}{" "}
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
          {keys === "unverified" && list && <p className="ww-sheet__note">{copy.unregistered}</p>}
          {typeof keys === "object" && list && (
            <section className="ww-contacts__section">
              <span className="ww-contacts__label">{copy.keysOnAccount}</span>
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
                  {fmt(copy.moreKeys, { count: keys.authKeyCount, shown: keys.rows.length })}
                </p>
              )}
            </section>
          )}
          <BackupPasskeyHost
            keys={read}
            {...(typeof keys === "object" && { owner: keys.owner })}
            {...(refreshing && { refreshing })}
            {...(onAction && { onAction })}
            onReadKeys={readAgain}
            onClose={onClose}
          />
        </div>
      </Modal>
      {/* A sibling: nested, it would be copied open into this sheet's closing animation. */}
      {leaving && <LeaveSheet kind="leave" onStay={() => setLeaving(false)} onConfirm={onClose} />}
    </>
  )
}
