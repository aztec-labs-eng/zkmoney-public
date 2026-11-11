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
import type { OperationRecord } from "@obsidion/front-core"
import { useStore } from "@obsidion/front-core"
import { PayWorking, type PayWorkingBeat } from "../contacts/PayWorking"
import { LocalPasskeyHint } from "../../ui/LocalPasskeyHint"
import { flowCopy } from "./operationCopy"
import copy from "./OperationHandOff.copy"
import { useSession } from "../../session/session"
import { currentOperation } from "./operations"

export interface OperationHandOffHandle {
  /** Leave now, as the hand-off would: the bell carries the operation, which runs on. */
  leave(): void
  /** `signing` while a passkey prompt is up; `proving` once the flow's ceremonies are over. */
  beat: PayWorkingBeat
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
  /** Each beat the hand-off moves to, for a flow that draws its status elsewhere. */
  onBeat?: (beat: PayWorkingBeat) => void
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
  onBeat,
  until = "handoff",
  prepared = false,
  ref,
}: OperationHandOffProps) {
  const [beat, showBeat] = useState<PayWorkingBeat>("preparing")
  const onBeatRef = useRef(onBeat)
  onBeatRef.current = onBeat
  const setBeat = useCallback((next: PayWorkingBeat) => {
    showBeat(next)
    onBeatRef.current?.(next)
  }, [])
  const [, refresh] = useReducer((n: number) => n + 1, 0)
  const { operations, page } = useSession()
  const lastSendWait = useStore(page.prover.progress, (p) => p.waitingForLastSend)
  const rootId = useRef<string | undefined>(undefined)
  const left = useRef(false)
  const leaveRef = useRef(onLeave)
  leaveRef.current = onLeave
  const leave = useCallback(() => {
    if (left.current) return
    left.current = true
    if (rootId.current)
      void operations.apply(rootId.current, { type: "handedOff", at: Date.now() }).catch(() => {})
    leaveRef.current()
  }, [operations])
  useImperativeHandle(ref, () => ({ leave, beat }), [leave, beat])

  // The flow's operation is the root one running when this mounts, or the first to start after.
  // eslint-disable-next-line local/effect-hook -- ZKM-1806
  useEffect(() => {
    const check = () => {
      const live = operations.live.get()
      rootId.current ??= currentOperation(operations.running.get(), live)?.operationId
      const root = operations.view.get().records.find((r) => r.operationId === rootId.current)
      if (until === "prepared") {
        if (root && leftPage(root, live.has(root.operationId))) leave()
        else refresh()
        return
      }
      if (until === "sent") {
        if (root?.state === "sent" || root?.state === "settled") return leave()
        if (root?.provingStartedAt !== undefined) setBeat("proving")
        return refresh()
      }
      if (root?.provingStartedAt !== undefined) leave()
      else if (root && leftPage(root, live.has(root.operationId))) leave()
      else refresh()
    }
    check()
    const offLive = operations.live.subscribe(check)
    const offList = operations.view.subscribe(check)
    return () => {
      offLive()
      offList()
    }
  }, [leave, until, operations, setBeat])

  // eslint-disable-next-line local/effect-hook -- ZKM-1806
  useEffect(() => {
    if (until === "prepared" && prepared) leave()
  }, [leave, until, prepared])

  // eslint-disable-next-line local/effect-hook -- ZKM-1806
  useEffect(() => {
    const { progress } = page.prover
    let last = progress.get().signing
    return progress.subscribe(() => {
      const { signing } = progress.get()
      const started = signing.started !== last.started
      const ended = signing.ended !== last.ended
      last = signing
      if (started) setBeat("signing")
      else if (ended && !signing.failed) {
        if (until === "handoff") leave()
        else setBeat("proving")
      }
    })
  }, [leave, until, page, setBeat])

  const root = rootId.current
  const live = operations.live.get()
  const child = root
    ? operations.view.get().records.find((r) => r.parent === root && live.has(r.operationId))
    : undefined
  const label = lastSendWait
    ? copy.waitingForLastPayment
    : child
    ? flowCopy(child.flow).live
    : undefined
  // Up from the first beat: the browser's sheet is modal, so the line should be up before it.
  const hint = beat === "proving" ? undefined : <LocalPasskeyHint />
  return renderWorking ? (
    renderWorking(beat, label, hint)
  ) : (
    <PayWorking beat={beat} label={label} onCancel={onCancel} hint={hint} />
  )
}
