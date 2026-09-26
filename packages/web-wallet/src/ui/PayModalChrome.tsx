import type { ReactNode } from "react"
import { GradientInitialAvatar, TopNavIconButton, avatarColors } from "@obsidion/web-ds"

/** Close + avatar header shared by the pay modal and the activity tx detail sheet. */
export function PayModalChrome({
  title,
  subtitle,
  onClose,
  avatar,
  name,
}: {
  title: string
  subtitle: ReactNode
  onClose: () => void
  avatar?: ReactNode
  name?: string
}) {
  return (
    <>
      <div className="ww-pay__close">
        <TopNavIconButton icon="x" ariaLabel="Close" onClick={onClose} />
      </div>
      <div className="ww-pay__head">
        {avatar ??
          (name ? (
            <GradientInitialAvatar name={name} colors={avatarColors(name)} size={52} />
          ) : null)}
        <span className="ww-pay__title">{title}</span>
        <span className="ww-pay__handle">{subtitle}</span>
      </div>
    </>
  )
}
