/** A burn writes its withdrawal to the session it was handed, whichever session is current. */
import { afterEach, expect, it } from "vitest"
import type { WithdrawalRecord } from "@obsidion/front-core"
import { runOperation } from "../../../src/features/operations/operations"
import { runBurn } from "../../../src/features/withdraw/withdrawGateway"
import { writeDeviceKeys } from "../../../src/platform/storage/deviceKeys"
import { closeSession, handOffAccount } from "../../../src/session/session"
import { testPage } from "../../support/page"
import { openTestSession } from "../../support/session"

const L2_TX = `0x${"2a".repeat(32)}`
const seed: Omit<WithdrawalRecord, "localId" | "operationId"> = {
  recipient: "0x00000000000000000000000000000000000000ee",
  recipientProvenance: "saved-recipient",
  amount: "25",
  rawAmount: (25n * 10n ** 18n).toString(),
  relayerTip: "1",
  tokenSymbol: "DAI",
  tokenDecimals: 18,
  phase: "submitting",
  startTime: 1_700_000_000_000,
}

afterEach(closeSession)

it("keeps a visitor's burn in the visitor's session after a sign-in makes another current", async () => {
  const visitor = openTestSession({ auth: {}, wallet: { networkId: "0xnet", node: {} } })
  await writeDeviceKeys(testPage().database, { storageId: "account-a" })
  const account = handOffAccount(visitor, {} as never)
  let mine!: () => void
  const burning = runOperation(
    visitor,
    { operationId: "op-burn", flow: "withdraw", summary: "25 DAI" },
    (op) =>
      runBurn({
        op,
        session: visitor,
        record: seed,
        burn: async (_record, onTxHash) => {
          await onTxHash(L2_TX)
          await new Promise<void>((resolve) => (mine = resolve))
          return { txHash: L2_TX, blockNumber: 42 }
        },
      }),
  )
  await expect.poll(() => mine).toBeDefined()
  mine()
  const { record } = await burning

  expect(account.namespace.id).toBe("account-a")
  expect(await visitor.withdrawals.get(record.localId)).toMatchObject({
    l2TxHash: L2_TX,
    blockNumber: 42,
  })
  expect(await account.withdrawals.get(record.localId)).toBeUndefined()
})
