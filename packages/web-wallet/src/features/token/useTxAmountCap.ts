import { UNREAD, useStore, type QueryEntry, type QueryState } from "@obsidion/front-core"
import type { Address } from "viem"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { tableRowByToken } from "@obsidion/core/oxide"
import { useSession } from "../../session/session"

const valueOf = <T>(state: QueryState<T>) => (state.status === "ready" ? state.value : undefined)

/**
 * A deployment's `TX_AMOUNT_CAP()`: `deployment`'s when given, else the active one's. Undefined until it is read; a
 * failed read, or a deployment that resolves to none, stays undefined.
 */
export function useTxAmountCap(
  deployment?: QueryEntry<Pick<OxideEnvTuple, "portal"> | null>,
): bigint | undefined {
  const { chain } = useSession().page
  const tuple = valueOf(useStore(deployment ?? UNREAD))
  const cap = deployment
    ? tuple
      ? chain.txAmountCap(tuple.portal as Address)
      : UNREAD
    : chain.currentTxAmountCap
  return valueOf(useStore(cap))
}

/**
 * The cap of the pinned table's row for `rowToken`. Undefined until the table is read, while no row is named, and
 * for a token the table has no row for.
 */
export function useRowTxAmountCap(rowToken: string | undefined): bigint | undefined {
  const { chain } = useSession().page
  const table = valueOf(useStore(rowToken ? chain.deploymentTable : UNREAD))
  return table && rowToken ? tableRowByToken(table, rowToken.toLowerCase())?.txAmountCap : undefined
}
