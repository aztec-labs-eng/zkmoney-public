import { getActiveStorageId } from "../../src/platform/storage/activeStorage"
import { getOperationStore } from "../../src/features/operations/operations"

/** A `local` operation this page runs, as a flow's `runOperation` holds it; resolves to its end. */
export async function startTabBoundOperation(
  operationId = "op-test",
  flow = "withdraw",
): Promise<() => Promise<void>> {
  const store = getOperationStore()
  await store.begin({ operationId, flow, summary: "$25 to Ethereum", scope: getActiveStorageId() })
  return () => store.remove(operationId)
}
