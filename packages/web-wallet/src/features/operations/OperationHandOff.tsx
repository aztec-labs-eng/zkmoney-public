/**
 * A flow's working phase: the working beat until the user's part is over, then it leaves at once
 * and the bell carries the operation. The user's part ends when the passkey ceremony does, when the
 * flow's operation starts proving (a flow with no ceremony), or when the operation leaves this
 * page. A flow that fails, or a ceremony that fails, stays so its screen can say why.
 */
import {
  useCallback,
  useEffect,
  useImperativeHandle,
  useReducer,
  useRef,
  useState,
  type ReactNode,
  type Ref,
} from "react"
import { provingProgress } from "@obsidion/proving-progress"
import type { OperationRecord } from "@obsidion/front-core"
import { PayWorking, type PayWorkingBeat } from "../contacts/PayWorking"
import { LocalPasskeyHint } from "../../ui/LocalPasskeyHint"
import { flowCopy } from "./operationCopy"
import { currentOperation, getOperationStore } from "./operations"

export interface OperationHandOffHandle {
  /** Leave now, as the hand-off would: the bell carries the operation, which runs on. */
  leave(): void
}

export interface OperationHandOffProps {
  /** Leave the flow's surface. Called at most once. */
  onLeave: () => void
  /** For a surface whose own close leaves the same way. */
  ref?: Ref<OperationHandOffHandle>
  /** Offered on the working beat while the flow can still honour it. */
  onCancel?: () => void
  /**
   * The working beat, for a flow that draws its own; `PayWorking` otherwise. `label` names a child
   * operation the root runs, in place of the preparing text. `hint` is the passkey advice to place
   * under the stage; absent once the prompt is over.
   */
  renderWorking?: (beat: PayWorkingBeat, label?: string, hint?: ReactNode) => ReactNode
  /**
   * `sent` holds the beat through the proof, for a flow whose next screen would compete with it:
   * it leaves once the operation is sent. `prepared` holds it through every ceremony and proof the
   * flow asks for, until `prepared` is set.
   */
  until?: "handoff" | "sent" | "prepared"
  prepared?: boolean
}

/** Settled, or `sent` and released: the chain has it, and nothing is left for this page to show. */
function leftPage(root: OperationRecord, live: boolean): boolean {
  return !live && (root.state === "settled" || root.state === "sent")
}

export function OperationHandOff({
  onLeave,
  onCancel,
  renderWorking,
  until = "handoff",
  prepared = false,
  ref,
}: OperationHandOffProps) {
  const [beat, setBeat] = useState<PayWorkingBeat>("preparing")
  const [, refresh] = useReducer((n: number) => n + 1, 0)
  const rootId = useRef<string | undefined>(undefined)
  const left = useRef(false)
  const leaveRef = useRef(onLeave)
  leaveRef.current = onLeave
  const leave = useCallback(() => {
    if (left.current) return
    left.current = true
    const store = getOperationStore()
    if (rootId.current) void store.markHandedOff(rootId.current).catch(() => {})
    leaveRef.current()
  }, [])
  useImperativeHandle(ref, () => ({ leave }), [leave])

  // The flow's operation is the root one running when this mounts, or the first to start after.
  useEffect(() => {
    const store = getOperationStore()
    const check = () => {
      rootId.current ??= currentOperation(store.list())?.operationId
      const root = rootId.current ? store.get(rootId.current) : null
      if (until === "prepared") {
        if (root && leftPage(root, store.isLive(root.operationId))) leave()
        else refresh()
        return
      }
      if (until === "sent") {
        if (root?.state === "sent" || root?.state === "settled") return leave()
        if (root?.provingStartedAt !== undefined) setBeat("proving")
        return refresh()
      }
      if (root?.provingStartedAt !== undefined) leave()
      else if (root && leftPage(root, store.isLive(root.operationId))) leave()
      else refresh()
    }
    check()
    const offLive = store.onLiveChanged(check)
    const offList = store.onListChanged(check)
    return () => {
      offLive()
      offList()
    }
  }, [leave, until])

  useEffect(() => {
    if (until === "prepared" && prepared) leave()
  }, [leave, until, prepared])

  useEffect(() => {
    const onStart = () => setBeat("signing")
    const onEnd = (e: { failed?: boolean }) => {
      if (e.failed) return
      if (until === "handoff") leave()
      else setBeat("proving")
    }
    provingProgress.on("signing-start", onStart)
    provingProgress.on("signing-end", onEnd)
    return () => {
      provingProgress.off("signing-start", onStart)
      provingProgress.off("signing-end", onEnd)
    }
  }, [leave, until])

  const store = getOperationStore()
  const root = rootId.current
  const child = root
    ? store.list().find((r) => r.parent === root && store.isLive(r.operationId))
    : undefined
  const label = child ? flowCopy(child.flow).live : undefined
  // Up from the first beat: the browser's sheet is modal, so the line should be up before it.
  const hint = beat === "proving" ? undefined : <LocalPasskeyHint />
  return renderWorking ? (
    renderWorking(beat, label, hint)
  ) : (
    <PayWorking beat={beat} label={label} onCancel={onCancel} hint={hint} />
  )
}
