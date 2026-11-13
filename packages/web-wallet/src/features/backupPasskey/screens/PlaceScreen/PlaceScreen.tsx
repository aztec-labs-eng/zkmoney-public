import { useId } from "react"
import {
  BACKUP_ADD_SHEET_COPY,
  windowsHelloBackupWarning,
  type BackupAddOption,
} from "@obsidion/passkey-web"
import { ChoiceCard, SheetLink, SheetShell } from "@obsidion/web-ds"
import { PASSKEYS_DOCS_URL } from "../../../../lib/links"
import { KeyWarningLine, StepsNote } from "../../../identity/PhoneSteps"
import type { BackupScreenProps } from "../../backupScreen"
import copy from "./PlaceScreen.copy"
import styles from "./PlaceScreen.module.css"

const picker = BACKUP_ADD_SHEET_COPY

/** In an option's card, if it has any: the managers on the help page, and what a key keeps. */
function optionHelp({ managersLink, keyWarning }: BackupAddOption) {
  if (!managersLink && !keyWarning) return null
  return (
    <>
      {managersLink && (
        <SheetLink
          label={managersLink.label}
          href={`${PASSKEYS_DOCS_URL}#${managersLink.anchor}`}
        />
      )}
      {keyWarning && <KeyWarningLine warning={keyWarning} testId="backup-add-key-warning" link />}
    </>
  )
}

/** A3: where the backup lives, another device first, and the button that creates it there. */
export function PlaceScreen({ screen, actions }: BackupScreenProps<"place">) {
  const { place, device, busy } = screen
  const group = useId()
  const option = place.options.find((o) => o.id === place.selected)
  // Windows Hello on Windows 10 gives no key, so this computer can't hold the backup there.
  const windows10 = option?.id === "computer" && device && windowsHelloBackupWarning(device)
  const advice = [...(option?.advice ?? []), ...(windows10 ? [windows10] : [])]
  return (
    <SheetShell
      hero="key"
      title={picker.pickerLabel}
      lead={device?.osFamily === "macos" ? picker.pickerLead.mac : picker.pickerLead.computer}
      primary={{
        label: copy.add,
        onClick: () => actions.add(place.selected),
        loading: busy,
        testId: "backup-add",
      }}
    >
      <div role="radiogroup" aria-label={picker.pickerLabel} className={styles.choices}>
        {place.options.map((o) => (
          <ChoiceCard
            key={o.id}
            name={group}
            value={o.id}
            checked={o.id === place.selected}
            onChange={() => actions.pick(o.id)}
            label={o.label}
            description={o.description}
            {...(o.badge && { badge: picker[o.badge] })}
            disabled={busy}
          >
            {optionHelp(o)}
          </ChoiceCard>
        ))}
      </div>
      {advice.length > 0 && (
        <div className="ww-phone-steps__advice" data-testid="backup-add-advice">
          {advice.map((text) => (
            <StepsNote key={text}>{text}</StepsNote>
          ))}
        </div>
      )}
    </SheetShell>
  )
}
