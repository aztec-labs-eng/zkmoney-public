import { InfoBox, KeyStatusRow, SheetCard, SheetShell } from "@obsidion/web-ds"
import { panelCopy } from "../../backupPasskeyCopy"
import type { BackupKey, BackupScreenProps } from "../../backupScreen"
import copy from "./KeysScreen.copy"
import styles from "./KeysScreen.module.css"
import { keysSheetShows } from "./keysSheet"

/**
 * The user's name for the key and its manager. Signing this session doesn't place a key on this
 * device: a phone over QR signs it too.
 */
const keyDetail = (key: BackupKey): string =>
  [key.name, key.provider].filter(Boolean).join(" · ") ||
  (key.signsHere ? copy.current : copy.added)

/** A1: the account's keys with the backup missing, and the button that starts the add. */
export function KeysScreen({ screen, actions }: BackupScreenProps<"keys">) {
  const { keys, add, busy } = screen
  // The modal lists these keys itself.
  if (!keysSheetShows(keys.length))
    return screen.cancelled ? (
      <p className="ww-sheet__note" data-testid="backup-cancelled">
        {`${panelCopy.cancelled} ${panelCopy.leftoverPasskey}`}
      </p>
    ) : null
  return (
    <SheetShell
      hero="warning"
      title={copy.title}
      lead={copy.lead}
      {...(add.kind !== "none" && {
        primary: {
          label: copy.add,
          onClick: () => actions.start("intro"),
          loading: add.kind === "checking" || busy,
          testId: "backup-start",
        },
      })}
    >
      {screen.cancelled && <InfoBox title={copy.cancelled}>{panelCopy.leftoverPasskey}</InfoBox>}
      {keys.length === 0 ? (
        // An account not registered yet: its keys aren't on the chain to list.
        <p className={`ww-sheet__note ${styles.note}`}>{copy.unregistered}</p>
      ) : (
        <SheetCard label={copy.onAccount}>
          {keys.map((key) => (
            <KeyStatusRow
              key={key.pubkeyHex}
              name={copy.roles[key.role]}
              detail={keyDetail(key)}
              status="added"
            />
          ))}
          <KeyStatusRow name={copy.roles.backup} detail={copy.notAdded} status="missing" />
        </SheetCard>
      )}
    </SheetShell>
  )
}
