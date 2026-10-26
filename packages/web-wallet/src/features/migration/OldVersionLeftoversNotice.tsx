import { Icon } from "@obsidion/web-ds"
import { usdAtomicFloor } from "../../ui/format"
import type { OldVersionLeftovers } from "./oldVersionLeftovers"
import { useWithdrawableSources } from "./oldVersionWithdraw"

/** Names what an old version still holds that Home's balances leave out, and what can move it. */
export function OldVersionLeftoversNotice({ left }: { left: OldVersionLeftovers }) {
  const withdrawable = useWithdrawableSources().some(
    (source) => left.deposited[source.savings ? "savings" : "main"],
  )
  if (!left.savings && !left.links) return null
  const parts = [
    left.savings && `${usdAtomicFloor(left.savings)} from a Savings move that didn't finish`,
    left.links &&
      `${usdAtomicFloor(left.links)} in ${
        left.linkCount === 1 ? "an unclaimed paylink" : `${left.linkCount} unclaimed paylinks`
      }`,
  ].filter(Boolean)
  return (
    <p className="ww-requests-unavailable" role="status">
      <Icon name="information-line" size={16} />
      {`Still on the old version: ${parts.join(" and ")}. `}
      {withdrawable
        ? "Withdraw sends the Savings move's funds to an Ethereum address."
        : "They are safe there, but this version can't move them yet."}
    </p>
  )
}
