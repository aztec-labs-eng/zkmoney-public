import * as actual from "../../../src/features/deposit/fundDeposit"
import { formatUnits } from "viem"
import { DEMO_DEPOSIT_FEE } from "../../../src/dev/fakeL1Rpc"
import { fixtureState, operation, pause } from "./control"
import { SIPA, TX_HASH } from "./data"
import { desktopState, sendUnresolved } from "./desktop"
import { DesktopSendUnresolvedError } from "../../../src/platform/desktopBridge"
export * from "../../../src/features/deposit/fundDeposit"

const address = { address: SIPA, name: "demo.sandbox.oxide" }
/** The helper's submission id for a send to `target`: 32 hex characters, the same for every approval of that send. */
const submissionFor = (target: string) => target.slice(2, 34).toLowerCase()

export const fundDeposit: typeof actual.fundDeposit = async (params, deps) => {
  if (!fixtureState()) return actual.fundDeposit(params, deps)
  if (desktopState()) {
    // The helper approved the send, then no hash arrived: the browser wallet may still send it.
    const feeDisplay = formatUnits(DEMO_DEPOSIT_FEE, 18)
    await params.preflight({ feeDisplay })
    params.onStage?.("awaiting-browser")
    await pause()
    // The helper page's recheck, then its approval, in the real bridge's order.
    await params.preflight({ feeDisplay })
    await params.beforeApprove?.(submissionFor(params.target.address))
    sendUnresolved(params.target.address)
    throw new DesktopSendUnresolvedError(new Error("Capture: approved without a hash"))
  }
  params.onStage?.("connecting")
  await operation("deposit")
  params.onStage?.("sending")
  await pause()
  params.onSubmitted?.(TX_HASH as `0x${string}`)
  params.onStage?.("confirming")
  await pause(2000)
  return { ...address, txHash: TX_HASH as `0x${string}` }
}
