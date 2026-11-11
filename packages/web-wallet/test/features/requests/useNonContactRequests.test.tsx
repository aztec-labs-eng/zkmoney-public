// Guard: a request is not offered for payment before its payments load.
import { act } from "react"
import { testPage, testCore } from "../../support/page"
import { createRoot } from "react-dom/client"
import { afterEach, describe, expect, it } from "vitest"
import type { StoredRequest } from "@obsidion/front-core"
import { useNonContactRequests } from "../../../src/features/requests/useNonContactRequests"
import { activeNamespace, closeSession, switchSession } from "../../../src/session/session"
import { openTestSession } from "../../support/session"
import { pageSessionDeps } from "../../../src/app/sessionDeps"
import { walletStorage } from "../../../src/platform/storage/walletStorage"
import { testWalletDbs } from "../../support/fakeWalletDb"

afterEach(closeSession)

const pending: StoredRequest = {
  id: "r1",
  contactTag: "mina",
  amount: 42,
  asset: "DAI",
  direction: "incoming",
  status: "pending",
  createdAt: Date.now() - 60_000,
  kind: "contact",
}

let listed: string[] = []
function Inbox() {
  listed = useNonContactRequests().requests.map((r) => r.id)
  return null
}

describe("useNonContactRequests", () => {
  it("lists nothing to pay until the requests and their payments load", async () => {
    switchSession(activeNamespace(testCore().device), pageSessionDeps(testPage()))
    await openTestSession().requests.add(pending)
    // A reload whose requests load before the transfer rows that would pay them.
    closeSession()
    await walletStorage.batch(() =>
      walletStorage.removeItem(`${activeNamespace(testCore().device).prefix}acct/meta/transfers`),
    )
    let land!: () => void
    const landed = new Promise<void>((resolve) => (land = resolve))
    testWalletDbs().onApply = async (_version, ops) => {
      if (ops.some(([key]) => key.endsWith("acct/meta/transfers"))) await landed
    }
    switchSession(activeNamespace(testCore().device), pageSessionDeps(testPage()))
    const root = createRoot(document.createElement("div"))
    await act(async () => root.render(<Inbox />))
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(listed).toEqual([])
    await act(async () => land())
    await act(async () => new Promise((r) => setTimeout(r, 0)))
    expect(listed).toEqual(["r1"])
    act(() => root.unmount())
  })
})
