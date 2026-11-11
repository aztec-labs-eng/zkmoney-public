import { runOperation, type OperationHandle } from "../operations/operations"
import type { Session } from "../../session/session"
import { linkIdentity } from "./linkIdentity"

/** A link's burn to L1 under the link's one operation: a second burn of the link is refused. */
export function runLinkBurn<T>(
  session: Pick<Session, "operations" | "page">,
  fragment: string,
  summary: string,
  run: (op: OperationHandle) => Promise<T>,
): Promise<T> {
  const operationId = `paylink-claim-l1:${linkIdentity(fragment)}`
  return runOperation(session, { operationId, flow: "paylink-claim-l1", summary }, run)
}
