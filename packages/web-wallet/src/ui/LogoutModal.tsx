import { Modal } from "./Modal"
import { GradientText, Icon, PrimaryGradientButton, TopNavIconButton } from "@obsidion/web-ds"
import { useLeavingLosesTransaction } from "../features/operations/operations"

export function LogoutModal({
  onClose,
  onConfirm,
}: {
  onClose: () => void
  onConfirm: () => void
}) {
  // Read live: the warning clears by itself if the transaction settles while the sheet is open.
  const losesTransaction = useLeavingLosesTransaction()
  return (
    <Modal variant="bare" label="Log out" className="ww-modal--create ww-logout" onClose={onClose}>
      <div className="ww-modal__close">
        <TopNavIconButton icon="x" ariaLabel="Close" onClick={onClose} />
      </div>
      <div className="ww-logout__icon">
        <Icon name="logout" size={32} color="#fff" />
      </div>
      <GradientText gradient="title" size={24} weight={700} style={{ textAlign: "center" }}>
        {losesTransaction ? "A transaction is still being sent" : "Log out of zk.money?"}
      </GradientText>
      {losesTransaction && (
        <p className="ww-logout__body">
          Logging out now loses it. Wait for it to finish, then log out.
        </p>
      )}
      <div className="ww-logout__actions">
        <PrimaryGradientButton
          title={losesTransaction ? "Wait" : "Cancel"}
          buttonStyle="dark"
          onClick={onClose}
        />
        <PrimaryGradientButton
          title={losesTransaction ? "Log out anyway" : "Log out"}
          buttonStyle="dark"
          onClick={onConfirm}
        />
      </div>
    </Modal>
  )
}
