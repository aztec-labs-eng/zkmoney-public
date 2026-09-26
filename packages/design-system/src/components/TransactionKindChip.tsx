import { LiquidGlassPill } from "./LiquidGlassPill"

export type TransactionKind =
  | "received"
  | "sent"
  | "deposit"
  | "withdraw"
  | "incomingRequest"
  | "outgoingRequest"
  | "outgoingLink"

const GOLD = "#EED04E"

const KIND_CONFIG: Record<
  TransactionKind,
  { label: string; icon: string; iconLeading: boolean; gold: boolean }
> = {
  received: { label: "Received", icon: "reply", iconLeading: true, gold: false },
  sent: { label: "You sent", icon: "forward", iconLeading: false, gold: false },
  deposit: { label: "Deposit", icon: "tray-deposit", iconLeading: false, gold: false },
  withdraw: { label: "Withdrawal", icon: "tray-withdraw", iconLeading: false, gold: false },
  incomingRequest: { label: "You owe", icon: "clock", iconLeading: false, gold: true },
  outgoingRequest: { label: "Owes you", icon: "clock", iconLeading: false, gold: true },
  outgoingLink: { label: "You send", icon: "forward", iconLeading: false, gold: true },
}

export interface TransactionKindChipProps {
  kind: TransactionKind
  className?: string
}

/** Tiny liquid-glass capsule identifying transaction direction/kind. Request kinds tint gold. */
export function TransactionKindChip({ kind, className }: TransactionKindChipProps) {
  const c = KIND_CONFIG[kind]
  return (
    <LiquidGlassPill
      className={className}
      label={c.label}
      icon={c.icon}
      iconLeading={c.iconLeading}
      foreground={c.gold ? GOLD : "#fff"}
      tint={c.gold ? GOLD : undefined}
      tintOpacity={c.gold ? 0.18 : 0}
      fallbackFill={c.gold ? "rgba(238,208,78,0.08)" : "rgba(255,255,255,0.03)"}
    />
  )
}
