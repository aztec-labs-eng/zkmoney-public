import { UNREAD, useStore } from "@obsidion/front-core"
import type { OxideEnvTuple } from "@obsidion/core/types"
import { useSession } from "../../session/session"

/** The manifest tuple: `undefined` while pending or disabled, `null` when it cannot be read. */
export function useOxideTuple(enabled = true): OxideEnvTuple | null | undefined {
  const { chain } = useSession().page
  const state = useStore(enabled ? chain.oxideTuple : UNREAD)
  return state.status === "ready" ? state.value : state.status === "failed" ? null : undefined
}
