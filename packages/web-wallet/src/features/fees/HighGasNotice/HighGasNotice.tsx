import { serviceStatus, useStore, type QueryState } from "@obsidion/front-core"
import { formatGwei, parseGwei } from "viem"
import { fmt } from "../../../lib/fmt"
import { Warning } from "../../../ui/Warning"
import { useSession } from "../../../session/session"
import { UNREAD } from "../highFees"
import copy from "./HighGasNotice.copy"

const HIGH_GAS = parseGwei("1")

const answer = <T,>(s: QueryState<T>) => (s.status === "ready" ? s.value : undefined)

/** Warns while L1 gas is high, since deposits, withdrawals and L2 fees all pay for it. */
export function HighGasNotice() {
  const gasPrice = useStore(useSession().page.highFees.gasPrice, answer)
  if (gasPrice === undefined || gasPrice <= HIGH_GAS) return null
  return (
    <Warning
      title={fmt(copy.gas.title, { gwei: Number(formatGwei(gasPrice)).toFixed(1) })}
      style={{ marginTop: -16, marginBottom: -16 }}
    >
      {copy.gas.body}
    </Warning>
  )
}

/** Says the app is unavailable while Aztec fees are above what the ClaimFPC sponsors. */
export function HighL2FeeNotice() {
  const { page, wallet } = useSession()
  const built = useStore(wallet, serviceStatus) === "ready"
  const above = useStore(built ? page.highFees.aboveCap : UNREAD, answer)
  if (!above) return null
  return (
    <Warning tone="error" title={copy.l2Fees.title} style={{ marginTop: -16, marginBottom: 24 }}>
      {copy.l2Fees.body}
    </Warning>
  )
}
