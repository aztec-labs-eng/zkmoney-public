import { DEFAULT_DECIMALS } from "@obsidion/core/constants"
import { useStore } from "@obsidion/front-core"
import { SheetShell } from "@obsidion/web-ds"
import { fmt } from "../../../../lib/fmt"
import { useSession } from "../../../../session/session"
import { HIDDEN_BALANCE, usdAtomicFloor } from "../../../../ui/format"
import { formatDepositDue } from "../../../registration/depositAmounts"
import { reportBlockAction } from "../../backupFunnel"
import type { BackupScreenProps } from "../../backupScreen"
import copy from "./LowBalanceScreen.copy"

/** B1 when a short balance is all that holds the add: what the add takes, and where to deposit. */
export function LowBalanceScreen({ screen, actions }: BackupScreenProps<"lowBalance">) {
  const hidden = useStore(useSession().device, (s) => s.hideBalances)
  const have = hidden ? HIDDEN_BALANCE : usdAtomicFloor(screen.have)
  return (
    <SheetShell
      hero="warning"
      title={copy.title}
      lead={fmt(copy.lead, { need: formatDepositDue(screen.need, DEFAULT_DECIMALS), have })}
      {...(actions.act && {
        primary: {
          label: copy.deposit,
          onClick: () => {
            reportBlockAction("balance", "deposit")
            actions.act?.("deposit")
          },
          testId: "backup-deposit",
        },
      })}
      // Never pressable: the add's first screen replaces this sheet once the balance covers it.
      secondary={{ label: copy.add, onClick: () => undefined, disabled: true }}
    />
  )
}
