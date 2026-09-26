import { Modal } from "./Modal"
import { GradientText, Icon, PrimaryGradientButton, TopNavIconButton } from "@obsidion/web-ds"

/**
 * Shown to a logout while the tag is still registering. OK keeps the session; the small link
 * under it logs out all the same, for someone who has weighed that.
 */
export function LogoutBlockedModal({
  onClose,
  onConfirm,
}: {
  onClose: () => void
  onConfirm: () => void
}) {
  return (
    <Modal
      variant="bare"
      label="Registration in progress"
      className="ww-modal--create ww-logout"
      onClose={onClose}
    >
      <div className="ww-modal__close">
        <TopNavIconButton icon="x" ariaLabel="Close" onClick={onClose} />
      </div>
      <div className="ww-logout__icon">
        <Icon name="logout" size={32} color="#fff" />
      </div>
      <GradientText gradient="title" size={24} weight={700} style={{ textAlign: "center" }}>
        Don't log out yet
      </GradientText>
      <p className="ww-logout__body">
        Your tag isn't registered yet. Logging out now can make it harder to get back into your
        account. Once registration is complete, you can log out.
      </p>
      <div className="ww-logout__actions">
        <PrimaryGradientButton title="OK" buttonStyle="dark" onClick={onClose} />
      </div>
      <button type="button" className="zkm-btn-reset ww-logout__anyway" onClick={onConfirm}>
        Log out anyway
      </button>
    </Modal>
  )
}
