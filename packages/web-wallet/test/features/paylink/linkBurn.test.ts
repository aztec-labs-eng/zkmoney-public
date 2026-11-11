// @vitest-environment node
// The link codec's byte checks need one realm, which jsdom splits.
/** A link has one burn to L1: a cash-out and an L1 claim of it share one operation. */
import { afterEach, expect, it } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { Grumpkin } from "@aztec-labs/foundation/crypto/grumpkin"
import { DEFAULT_CONTRACTS } from "@obsidion/core/constants"
import { encodePaylinkInline } from "@obsidion/sdk"
import { loadRecords } from "@obsidion/front-core"
import { activeNamespace, closeSession, switchSession } from "../../../src/session/session"
import { pageSessionDeps } from "../../../src/app/sessionDeps"
import { runLinkBurn } from "../../../src/features/paylink/linkBurn"
import type { OperationHandle } from "../../../src/features/operations/operations"
import { testCore, testPage } from "../../support/page"

const fragment = encodePaylinkInline({
  secret: new Fr(7n),
  paylinkType: DEFAULT_CONTRACTS.paylinkDirect,
  classId: new Fr(2n),
  chainId: 31337,
  fallbackKeyHash: new Fr(3n),
  rollupVersion: 1,
  escrowTagSecret: Grumpkin.generator,
})
const hash = `0x${"ab".repeat(32)}`
const opened = () => switchSession(activeNamespace(testCore().device), pageSessionDeps(testPage()))

/** A burn that proves until `release`, then sends `hash` and leaves the record to the chain. */
function burn() {
  let release!: () => void
  const proving = new Promise<void>((resolve) => (release = resolve))
  const sends: string[] = []
  const run = async (op: OperationHandle) => {
    await proving
    sends.push(hash)
    await op.sent(hash)
    op.leaveToChain(hash)
    return hash
  }
  return { run, release, sends }
}

afterEach(closeSession)

it("refuses an L1 claim of a link while its cash-out burns", async () => {
  const session = opened()
  const first = burn()
  const second = burn()
  const cashOut = runLinkBurn(session, fragment, "Cash-out to Ethereum", first.run)
  await expect(
    runLinkBurn(session, fragment, "Paylink to Ethereum", second.run),
  ).rejects.toMatchObject({ code: "operation.running" })
  first.release()
  await expect(cashOut).resolves.toBe(hash)
  expect(first.sends).toEqual([hash])
  expect(second.sends).toEqual([])
})

it("refuses a burn of a link whose hash was saved, after the stores reopen", async () => {
  const first = burn()
  first.release()
  await runLinkBurn(opened(), fragment, "Cash-out to Ethereum", first.run)
  closeSession()
  const session = opened()
  const [held] = await loadRecords(session.operations.view)
  const retry = burn()
  retry.release()
  await expect(
    runLinkBurn(session, fragment, "Paylink to Ethereum", retry.run),
  ).rejects.toMatchObject({
    code: "operation.sent",
  })
  expect(retry.sends).toEqual([])
  expect(await loadRecords(session.operations.view)).toEqual([held])
  expect(held).toMatchObject({ state: "sent", txHash: hash, summary: "Cash-out to Ethereum" })
})
