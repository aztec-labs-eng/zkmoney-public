import { useState } from "react"
import { useNavigate } from "react-router-dom"
import { WalletAboutLimitsSheet } from "../../features/limits/AboutLimitsSheet"
import { openMigrationDialog } from "../../features/migration/migrationDialog"
import { PasskeysModal } from "../PasskeysModal"

/** The Passkeys sheet with the links a blocked add offers, each opening what clears the block. */
export function PasskeysSheet({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const [allowance, setAllowance] = useState(false)
  if (allowance) {
    return <WalletAboutLimitsSheet topic="sponsorship" capacity={false} onClose={onClose} />
  }
  return (
    <PasskeysModal
      onClose={onClose}
      onAction={(action) => {
        if (action === "sponsorship") {
          setAllowance(true)
          return
        }
        onClose()
        if (action === "activity" || action === "savings") void navigate(`/${action}`)
        else openMigrationDialog()
      }}
    />
  )
}
