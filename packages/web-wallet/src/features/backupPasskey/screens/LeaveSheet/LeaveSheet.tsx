import { SheetShell } from "@obsidion/web-ds"
import { Modal } from "../../../../ui/Modal"
import copy from "./LeaveSheet.copy"

/** Asks before a saved add's sheet closes (`leave`) or drops the attempt (`cancel`). */
export function LeaveSheet({
  kind,
  onStay,
  onConfirm,
}: {
  kind: "leave" | "cancel"
  onStay: () => void
  onConfirm: () => void
}) {
  const words = copy[kind]
  return (
    <Modal variant="create" label={words.title} onClose={onStay} className="ww-feedback">
      <SheetShell
        hero="warning"
        title={words.title}
        lead={words.lead}
        primary={{ label: copy.stay, onClick: onStay, testId: "backup-stay" }}
        secondary={{ label: words.confirm, onClick: onConfirm, testId: `backup-${kind}-confirm` }}
      />
    </Modal>
  )
}
