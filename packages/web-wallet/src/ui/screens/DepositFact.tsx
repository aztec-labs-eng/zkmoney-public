import type { ReactNode } from "react"

export function DepositFact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="ww-sheet__fact">
      <span>{label}</span>
      {children}
    </div>
  )
}
