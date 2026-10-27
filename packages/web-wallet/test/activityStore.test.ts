import { afterEach, describe, expect, it } from "vitest"
import { TRANSACTIONS_STORAGE_KEY, memoryStore, derived, prefixedKv } from "@obsidion/front-core"
import { kvContract } from "../../front-core/test/engine/kvContract"
import { closeSession, openSession } from "../src/platform/session"
import {
  closeWalletStore,
  openWalletStore,
  walletStorage,
} from "../src/platform/storage/walletStorage"
import { testWalletDbs } from "./support/fakeWalletDb"

const VERSION = "kv-contract"

// The app reads walletStorage through a prefixed view, which batches its listeners.
kvContract(
  "walletStorage",
  async () => {
    await closeWalletStore()
    testWalletDbs().stored.delete(VERSION)
    await openWalletStore(VERSION, { persistent: true })
    return prefixedKv(walletStorage, "")
  },
  {
    reopen: async () => {
      await walletStorage.flush()
      await closeWalletStore()
      await openWalletStore(VERSION, { persistent: true })
      return prefixedKv(walletStorage, "")
    },
    failing: (on) => {
      testWalletDbs().onApply = on
        ? () => {
            throw new Error("disk full")
          }
        : undefined
    },
    stores: { memoryStore, derived },
  },
)

const pending = {
  id: "op-c",
  operationId: "op-c",
  action: "send",
  token: { address: "0xt", name: "USD", symbol: "USD", decimals: 6, logo: "", amount: 1, price: 1 },
  amountAtomic: "1000000",
  timestamp: 1,
  status: "pending",
  txHash: "",
}

afterEach(closeSession)

describe("the web activity store", () => {
  it("reads the account's legacy rows once", async () => {
    await walletStorage.commitItem(
      `obsidion.acct-c.${TRANSACTIONS_STORAGE_KEY}`,
      JSON.stringify([{ ...pending, id: undefined }]),
    )
    const { activity } = openSession({ id: "acct-c", prefix: "obsidion.acct-c." })
    await activity.ready
    expect(activity.latest("op-c")?.amountAtomic).toBe(1_000_000n)
  })
})
