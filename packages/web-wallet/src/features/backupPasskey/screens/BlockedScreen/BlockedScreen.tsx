import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import { useStore } from "@obsidion/front-core"
import { ChecklistRow, SheetCard, SheetShell } from "@obsidion/web-ds"
import { fmt } from "../../../../lib/fmt"
import { useSession } from "../../../../session/session"
import { HIDDEN_BALANCE, usdAtomicFloor } from "../../../../ui/format"
import { lockedUntil } from "../../../migration/residualNotes"
import { formatDepositDue } from "../../../registration/depositAmounts"
import type { EntryBlock, OpenEntryBlock } from "../../backupPasskeyEntry"
import type { BackupScreenProps } from "../../backupScreen"
import copy from "./BlockedScreen.copy"

/** The first passkey and the network have sheets of their own. */
type Item =
  | Exclude<OpenEntryBlock, { id: "firstPasskey" | "route" }>
  | { id: "registered"; done: true }

/** The finished registration stays ticked; every other row is an open item. */
const shown = (block: EntryBlock): block is Item =>
  block.id === "registered" || (!block.done && block.id !== "firstPasskey" && block.id !== "route")

/** A row's words; `action` labels its link, which shows where the block has somewhere to go. */
function words(item: Item, hidden: boolean): { label: string; detail: string; action?: string } {
  if (item.done) return copy.registered.done
  // The balance and its biggest pieces are the user's own figures; the need is not.
  const own = (atomic: bigint) => (hidden ? HIDDEN_BALANCE : usdAtomicFloor(atomic))
  switch (item.id) {
    case "registered":
      return item.finishing ? copy.registered.finishing : copy.registered.pending
    case "link": {
      const { hold } = item
      const action = copy.link.action
      if (hold.kind === "expiry")
        return {
          label: copy.link.expiry.label,
          detail: fmt(copy.link.expiry.detail, { date: lockedUntil(hold.until) }),
          action,
        }
      return { ...copy.link[hold.kind], action }
    }
    case "balance":
      return {
        // Rounded up, so depositing the figure shown is always enough.
        label: fmt(copy.balance.label, { need: formatDepositDue(item.need, DEFAULT_DECIMALS) }),
        detail: fmt(copy.balance.detail, { have: own(item.have) }),
        action: copy.balance.action,
      }
    case "pieces":
      return { label: copy.pieces.label, detail: fmt(copy.pieces.detail, { send: own(item.send) }) }
    default:
      return copy[item.id]
  }
}

/** B1: every condition that holds the add, each with what clears it. */
export function BlockedScreen({ screen, actions }: BackupScreenProps<"blocked">) {
  const hidden = useStore(useSession().device, (s) => s.hideBalances)
  return (
    <SheetShell
      hero="key"
      title={copy.title}
      lead={copy.lead}
      // Never pressable here: the add's first screen replaces this sheet once nothing holds it.
      primary={{ label: copy.add, onClick: () => undefined, disabled: true }}
    >
      <SheetCard>
        {screen.blocks.filter(shown).map((item) => {
          const { label, detail, action } = words(item, hidden)
          const to = item.done ? undefined : item.action
          return (
            <ChecklistRow
              key={item.id}
              done={item.done}
              muted={item.done}
              label={label}
              detail={detail}
              {...(action &&
                to &&
                actions.act && { action: { label: action, onClick: () => actions.act?.(to) } })}
            />
          )
        })}
      </SheetCard>
    </SheetShell>
  )
}
