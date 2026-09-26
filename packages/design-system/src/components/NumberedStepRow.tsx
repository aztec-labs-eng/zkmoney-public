import type { ReactNode } from "react"
import { Icon } from "./Icon"

export interface NumberedStepRowProps {
  /** Leading icon name; takes precedence over index. */
  icon?: string
  /** 1-based step number, shown when no icon is given. */
  index?: number
  children: ReactNode
  className?: string
}

/** "How it works" row: circled icon or step number + explanatory text. */
export function NumberedStepRow({ icon, index, children, className }: NumberedStepRowProps) {
  return (
    <div className={["zkm-step-row", className].filter(Boolean).join(" ")}>
      <span className="zkm-step-row__bullet">
        {icon ? <Icon name={icon} size={16} color="var(--purple-400)" /> : index}
      </span>
      <span className="zkm-step-row__text">{children}</span>
    </div>
  )
}
