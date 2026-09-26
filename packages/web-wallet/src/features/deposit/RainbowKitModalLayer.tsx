import { useEffect, type ReactNode } from "react"
import { useAccountModal, useChainModal, useConnectModal } from "@rainbow-me/rainbowkit"
import { ModalSuspension } from "../../ui/Modal"

/** RainbowKit portals to body, outside the native dialog top layer used by our sheets. */
export function RainbowKitModalLayer({ children }: { children: ReactNode }) {
  const { connectModalOpen } = useConnectModal()
  const { accountModalOpen } = useAccountModal()
  const { chainModalOpen } = useChainModal()
  const open = connectModalOpen || accountModalOpen || chainModalOpen
  useEffect(() => {
    if (!open) return
    // RainbowKit handles Escape itself. Prevent its default action from cancelling the native
    // sheet restored by that same key event, without stopping RainbowKit's keydown listener.
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") event.preventDefault() }
    document.addEventListener("keydown", onKeyDown, true)
    return () => document.removeEventListener("keydown", onKeyDown, true)
  }, [open])
  return <ModalSuspension suspended={open}>
    {children}
  </ModalSuspension>
}
