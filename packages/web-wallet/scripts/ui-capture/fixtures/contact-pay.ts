import * as actual from "../../../src/features/contacts/contactPay"
import { ContactStorage, RequestStorage, TransactionStorage } from "@obsidion/front-core"
import { parseUnits } from "viem"
import { webStorage } from "../../../src/platform/storage/WebStorageAdapter"
import { fixtureState, inOperation, operation } from "./control"
import { field, TOKEN_INFO, TX_HASH, ROLLUP } from "./data"
export * from "../../../src/features/contacts/contactPay"
let sequence = 0
export const requestFromContact: typeof actual.requestFromContact = async (deps, args) => {
  if (!fixtureState()) return actual.requestFromContact(deps, args)
  await operation("request")
  await RequestStorage.get().add({
    id: field((++sequence + 16).toString(16)), contactTag: args.tag, direction: "outgoing", status: "pending",
    kind: "contact", amount: Number(args.amountDisplay), amountAtomic: parseUnits(args.amountDisplay, 18).toString(),
    asset: "DAI", createdAt: Date.now(), note: args.note, tokenAddress: TOKEN_INFO.address, tokenDecimals: 18, networkId: ROLLUP,
  })
}
export const runContactPay: typeof actual.runContactPay = async (args, onStage) => {
  if (!fixtureState()) return actual.runContactPay(args, onStage)
  if (args.mode !== "send") {
    await requestFromContact(args.deps, { tag: args.tag, requesterTag: args.senderTag, amountDisplay: args.amountDisplay, note: args.note })
    return {}
  }
  const store = TransactionStorage.get(webStorage)
  const entry = (await ContactStorage.get().getEntries()).find((entry) => entry.tag === args.tag)
  const id = `capture-send-${++sequence}`
  let rowCreated = false
  onStage("resolving")
  const send = async () => {
    try {
      await operation("send", onStage, true, {
        operationId: id,
        onPrepared: async () => {
          await store.addTokenTransaction("send", { ...TOKEN_INFO, amount: Number(args.amountDisplay), price: 1, logo: "" }, "pending", undefined, entry?.address ?? args.tag, id, undefined, args.note)
          rowCreated = true
        },
      })
      await store.updateTransaction((tx) => tx.queueId === id, (tx) => { tx.status = "success"; tx.txHash = TX_HASH })
      if (args.request) await RequestStorage.get().applyStatus(args.request.id, "fulfilled")
      return { txHash: TX_HASH }
    } catch (error) {
      if (rowCreated) await store.updateTransaction((tx) => tx.queueId === id, (tx) => { tx.status = "failed"; tx.error = String(error) })
      throw error
    }
  }
  return inOperation("send", `$${args.amountDisplay} to @${args.tag}`, send, (r) => r.txHash)
}
