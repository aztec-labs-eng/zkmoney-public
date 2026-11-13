import { FactBox, InfoBox, KeyStatusRow, SheetCard, SheetShell } from "@obsidion/web-ds"
import { usdFromCents } from "../../../../ui/format"
import { addCost } from "../../backupCost"
import { failureLine } from "../../backupFailure"
import { relandingCopy } from "../../backupPasskeyCopy"
import type { BackupKey, BackupSaved, BackupScreenProps } from "../../backupScreen"
import copy from "./DoneScreen.copy"

const ROLE = { "sign-up": copy.signUp, "backup": copy.backup, "unknown": copy.other } as const

const keyDetail = ({ name, provider }: Pick<BackupKey, "name" | "provider">) =>
  [name, provider].filter(Boolean).join(copy.separator) || copy.unnamed

const savedDetail = (saved?: BackupSaved) =>
  !saved ? copy.added : "securityKey" in saved ? copy.securityKey : saved.manager

/** A7: the backup is added. Done reads the keys again and ends the attempt. */
export function DoneScreen({ screen, actions }: BackupScreenProps<"done">) {
  const { keys, unlisted, paid, failure, relanding } = screen
  return (
    <SheetShell
      hero="success"
      title={copy.title}
      lead={copy.lead}
      primary={{ label: copy.done, onClick: actions.finish, testId: "backup-done" }}
    >
      <SheetCard label={copy.keys}>
        {keys.length === 0 && (
          <KeyStatusRow name={copy.signUp} detail={copy.first} status="added" />
        )}
        {keys.map((key) => (
          <KeyStatusRow
            key={key.pubkeyHex}
            name={ROLE[key.role]}
            detail={keyDetail(key)}
            status="added"
          />
        ))}
        {unlisted && (
          <KeyStatusRow name={copy.backup} detail={savedDetail(unlisted.savedIn)} status="added" />
        )}
      </SheetCard>
      {paid !== undefined && (
        <FactBox facts={[{ label: copy.cost, value: usdFromCents(addCost(paid).fee) }]} />
      )}
      {relanding && <InfoBox title={relandingCopy.title}>{relandingCopy.line}</InfoBox>}
      {failure && (
        <p className="zkm-field__error" role="alert" style={{ margin: 0 }}>
          {failureLine(failure)}
        </p>
      )}
    </SheetShell>
  )
}
