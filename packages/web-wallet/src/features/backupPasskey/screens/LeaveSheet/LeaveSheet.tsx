import type { BackupRotationPhase } from "@obsidion/front-core"
import { SheetShell } from "@obsidion/web-ds"
import { Modal } from "../../../../ui/Modal"
import { reportLeavePrompted } from "../../backupFunnel"
import copy from "./LeaveSheet.copy"

/** Asks before a saved add's sheet closes (`leave`) or drops the attempt (`cancel`). */
export function LeaveSheet({
  kind,
  phase,
  onStay,
  onConfirm,
}: {
  kind: "leave" | "cancel"
  /** The saved attempt's phase, which the answer is reported with. */
  phase: BackupRotationPhase | undefined
  onStay: () => void
  onConfirm: () => void
}) {
  const words = copy[kind]
  const stay = () => {
    reportLeavePrompted(kind, "stay", phase)
    onStay()
  }
  const confirm = () => {
    reportLeavePrompted(kind, "confirm", phase)
    onConfirm()
  }
  return (
    <Modal variant="create" label={words.title} onClose={stay} className="ww-feedback">
      <SheetShell
        hero="warning"
        title={words.title}
        lead={words.lead}
        primary={{ label: copy.stay, onClick: stay, testId: "backup-stay" }}
        secondary={{ label: words.confirm, onClick: confirm, testId: `backup-${kind}-confirm` }}
      />
    </Modal>
  )
}
