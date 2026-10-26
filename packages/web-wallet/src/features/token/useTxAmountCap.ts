import { useEffect, useState } from "react"
import type { Address } from "viem"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { tableRowByToken } from "@obsidion/core/oxide"
import { getConfig } from "../../config/env"
import { getDeploymentTable, l1PublicClient } from "../../config/oxideTuple"
import { currentTxAmountCap, txAmountCap } from "./oxideToken"

/**
 * A deployment's `TX_AMOUNT_CAP()`: `deployment`'s when given, else the active one's. Undefined until it is read; a
 * failed read, or a deployment that resolves to none, stays undefined. Pass a stable `deployment`.
 */
export function useTxAmountCap(
  deployment?: () => Promise<Pick<OxideEnvTuple, "portal"> | undefined>,
): bigint | undefined {
  const [cap, setCap] = useState<bigint>()
  useEffect(() => {
    let live = true
    const read = deployment
      ? deployment().then((tuple) =>
          tuple ? txAmountCap(l1PublicClient(getConfig()), tuple.portal as Address) : undefined,
        )
      : currentTxAmountCap()
    read.then(
      (value) => live && setCap(value),
      () => {},
    )
    return () => {
      live = false
    }
  }, [deployment])
  return cap
}

/**
 * The cap of the pinned table's row for `rowToken`. Undefined until the table is read, while no row is named, and
 * for a token the table has no row for.
 */
export function useRowTxAmountCap(rowToken: string | undefined): bigint | undefined {
  const [cap, setCap] = useState<{ token: string; cap?: bigint }>()
  const token = rowToken?.toLowerCase()
  useEffect(() => {
    if (!token) return
    let live = true
    Promise.resolve()
      .then(() => getDeploymentTable(getConfig()))
      .then(
        (table) => live && setCap({ token, cap: tableRowByToken(table, token)?.txAmountCap }),
        () => {},
      )
    return () => {
      live = false
    }
  }, [token])
  return cap?.token === token ? cap?.cap : undefined
}
