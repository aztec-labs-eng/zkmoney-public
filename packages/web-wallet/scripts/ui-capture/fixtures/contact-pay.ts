import * as actual from "../../../src/features/contacts/contactPay"
import { parseUnits } from "viem"
import { fixtureState, inOperation, operation } from "./control"
import type { OperationHandle } from "../../../src/features/operations/operations"
import { field, TOKEN_INFO, TX_HASH, ROLLUP } from "./data"
export * from "../../../src/features/contacts/contactPay"
let sequence = 0
export const requestFromContact: typeof actual.requestFromContact = async (session, args) => {
  if (!fixtureState()) return actual.requestFromContact(session, args)
  await operation("request")
  await session.requests.add({
    id: field((++sequence + 16).toString(16)), contactTag: args.tag, direction: "outgoing", status: "pending",
    kind: "contact", amount: Number(args.amountDisplay), amountAtomic: parseUnits(args.amountDisplay, 18).toString(),
    asset: "DAI", createdAt: Date.now(), note: args.note, tokenAddress: TOKEN_INFO.address, tokenDecimals: 18, networkId: ROLLUP,
  })
}
export const runContactPay: typeof actual.runContactPay = async (args, onStage) => {
  if (!fixtureState()) return actual.runContactPay(args, onStage)
  if (args.mode !== "send") {
    await requestFromContact(args.session, { tag: args.tag, requesterTag: args.senderTag, amountDisplay: args.amountDisplay, note: args.note })
    return {}
  }
  const entry = ((await args.session.contacts?.all()) ?? []).find((entry) => entry.tag === args.tag)
  onStage("resolving")
  const send = async (op: OperationHandle) => {
    await operation("send", onStage, true, {
      operationId: op.operationId,
      session: args.session,
      onPrepared: () => op.transfer({ kind: "send", payload: {
        networkId: ROLLUP, token: { ...TOKEN_INFO, amount: Number(args.amountDisplay), price: 1, logo: "" },
        amountAtomic: parseUnits(args.amountDisplay, 18).toString(),
        to: entry?.address ?? args.tag, memo: args.note, requestId: args.request?.id,
      } }),
      onTxHash: op.sent,
    })
    return { txHash: TX_HASH }
  }
  return inOperation(args.session, "send", `$${args.amountDisplay} to @${args.tag}`, send, (r) => r.txHash)
}
