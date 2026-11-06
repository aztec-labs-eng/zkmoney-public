import { showErrorModal } from "../../errors/errorModal"
import { useStore } from "@obsidion/front-core"
import { useSession } from "../../session/session"
import { balanceMovingCopy } from "./backupPasskeyCopy"
import { useBalanceMoving } from "./backupRotationStore"

/**
 * Runs a press that spends through the sponsor, or shows why it waits while a backup passkey
 * rotation moves the balance. For presses outside the action gate, such as a payment link refund.
 */
export function useBalanceMovingPause(): (run: () => void) => void {
  const moving = useBalanceMoving(useStore(useSession().identity, (s) => s.value?.address))
  return (run) => (moving ? showErrorModal(balanceMovingCopy) : run())
}
