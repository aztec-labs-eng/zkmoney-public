/**
 * The bell's panel lists operations straight off their records: running ones with a spinner,
 * ended ones as their outcome. Nothing is written for an operation, so a reload or an account
 * switch shows exactly what the store holds for the active account.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { TxStatus } from "@aztec/stdlib/tx"
import { OPERATIONS_STORAGE_KEY, type OperationRecord } from "@obsidion/front-core"
import { clearActiveStorage, setActiveStorageId } from "../src/platform/storage/activeStorage"
import { PAYLINK_NOT_CLAIMABLE_YET_MESSAGE } from "../src/features/paylink/claimWindow"
import { getOperationStore } from "../src/features/operations/operations"
import { operationEntry } from "../src/features/operations/operationEntries"
import { NotificationsPanel, useNotificationList } from "../src/ui/NotificationsPanel"

const hash = `0x${"ab".repeat(32)}`

let container: HTMLDivElement
let root: Root
let unread = -1

beforeEach(async () => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  clearActiveStorage()
  // Every test starts from an empty panel for the visitor scope.
  await getOperationStore().dismissEnded(null)
})

async function begin(operationId: string, flow = "send", scope: string | null = null) {
  await act(async () => {
    await getOperationStore().begin({ operationId, flow, summary: "$25 to @alice", scope })
  })
}

function Unread() {
  unread = useNotificationList().unreadCount
  return null
}

const renderPanel = () =>
  act(async () =>
    root.render(
      <MemoryRouter>
        <Unread />
        <NotificationsPanel onClose={() => {}} />
      </MemoryRouter>,
    ),
  )
const items = () => [...container.querySelectorAll(".ww-notifications__item")]
const itemText = (text: string) => items().find((i) => i.textContent?.includes(text))
const click = (el: Element | null | undefined) =>
  act(async () => (el as HTMLButtonElement).click())

describe("the panel", () => {
  // First, before anything loads the store: the records an earlier page left behind.
  it("after a reload, lists an operation that ended on the earlier page, unread", async () => {
    const ended: OperationRecord = {
      operationId: "op-earlier",
      flow: "send",
      summary: "$9 to @bob",
      scope: null,
      state: "settled",
      startedAt: 1,
      endedAt: 2,
      txHash: hash,
    }
    localStorage.setItem(
      `obsidion.${OPERATIONS_STORAGE_KEY}`,
      JSON.stringify({ [ended.operationId]: ended }),
    )
    await renderPanel()
    expect(itemText("$9 to @bob")?.textContent).toContain("Sent")
    expect(itemText("$9 to @bob")?.querySelector('[aria-label="Unread"]')).not.toBeNull()
    expect(unread).toBeGreaterThanOrEqual(1)
  })

  it("lists a running operation with a spinner and no note, then its outcome", async () => {
    await begin("op-panel", "paylink-claim")
    await renderPanel()
    const running = container.querySelector('.ww-notifications__item[role="status"]')
    expect(running?.textContent).toContain("Receiving")
    expect(running?.querySelector('[role="note"]')).toBeNull()
    await act(async () => getOperationStore().settle("op-panel", hash))
    expect(container.querySelector('.ww-notifications__item[role="status"]')).toBeNull()
    expect(itemText("$25 to @alice")?.textContent).toContain("Received")
  })

  it("shows a boot-sweep failure with its cause", async () => {
    const store = getOperationStore()
    const lost = { operationId: "op-lost", flow: "send", summary: "$3 to @bob", scope: null }
    await store.begin(lost, 1)
    await store.markProving("op-lost", 1)
    store.release("op-lost")
    await renderPanel()
    await act(async () => store.failInterrupted(2))
    const row = itemText("$3 to @bob")?.textContent
    expect(row).toContain("Send failed")
    expect(row).toContain("The tab closed before it was sent. The amount is still in your balance.")
  })

  it("hides an ended operation once dismissed, and marks it read once opened", async () => {
    await begin("op-dismiss")
    await act(async () => getOperationStore().settle("op-dismiss", hash))
    await renderPanel()
    await click(itemText("$25 to @alice")?.querySelector('[aria-label="Dismiss"]'))
    expect(itemText("$25 to @alice")).toBeUndefined()
    expect(getOperationStore().get("op-dismiss")?.dismissedAt).toBeDefined()

    await begin("op-open")
    await act(async () => getOperationStore().settle("op-open", hash))
    await click(itemText("$25 to @alice")?.querySelector(".ww-notifications__row"))
    expect(getOperationStore().get("op-open")?.readAt).toBeDefined()
  })

  it("clears ended operations and keeps running ones", async () => {
    await begin("op-cleared")
    await act(async () => getOperationStore().settle("op-cleared", hash))
    await begin("op-still-running")
    await renderPanel()
    const buttons = [...container.querySelectorAll("button")]
    const clear = buttons.find((b) => b.textContent === "Clear all")
    await click(clear)
    expect(getOperationStore().get("op-cleared")?.dismissedAt).toBeDefined()
    expect(container.querySelector('.ww-notifications__item[role="status"]')).not.toBeNull()
    await act(async () => getOperationStore().remove("op-still-running"))
  })

  it("never lists another account's operations", async () => {
    setActiveStorageId("acct-b")
    await begin("op-of-a", "send", "acct-a")
    await act(async () => getOperationStore().settle("op-of-a", hash))
    await begin("op-a-running", "send", "acct-a")
    await renderPanel()
    expect(items()).toHaveLength(0)
    await act(async () => setActiveStorageId("acct-a"))
    expect(items()).toHaveLength(2)
    await act(async () => getOperationStore().remove("op-a-running"))
    await getOperationStore().dismissEnded("acct-a")
  })

  it("shows no ended row for a flow whose own record reports its ending", async () => {
    await begin("op-burn", "withdraw")
    await renderPanel()
    expect(container.querySelector('.ww-notifications__item[role="status"]')).not.toBeNull()
    // A sent withdrawal is already its record's live row.
    await act(async () => getOperationStore().markSent("op-burn", hash))
    expect(items()).toHaveLength(0)
    await act(async () => getOperationStore().fail("op-burn", "boom"))
    expect(items()).toHaveLength(0)
  })
})

describe("an ended operation's entry", () => {
  const record = (patch: Partial<OperationRecord>): OperationRecord => ({
    operationId: "op",
    flow: "send",
    summary: "$25 to @alice",
    scope: null,
    state: "settled",
    startedAt: 1,
    endedAt: 2,
    ...patch,
  })

  it("opens a settled send's transaction, and is read once the panel showed it", () => {
    expect(operationEntry(record({ txHash: hash }))).toMatchObject({
      title: "Sent",
      description: "$25 to @alice",
      severity: "success",
      target: { type: "transfer.txDetail", txHash: hash },
      read: false,
    })
    expect(operationEntry(record({ readAt: 3 }))?.read).toBe(true)
    expect(operationEntry(record({ state: "local", endedAt: undefined }))).toBeNull()
  })

  it("carries the flow's message, else the cause worded by flow", () => {
    const claim = { flow: "paylink-claim", state: "failed" as const }
    expect(operationEntry(record({ ...claim, error: "Note already spent" }))).toMatchObject({
      title: "Claim failed",
      description: "Note already spent",
      severity: "error",
    })
    const lost = record({ ...claim, summary: "$4 paylink", cause: "interrupted" })
    expect(operationEntry(lost)?.description).toBe("$4 paylink. The tab closed before it was sent.")
    const dropped = record({ flow: "paylink-reclaim", state: "failed", cause: "dropped" })
    expect(operationEntry(dropped)).toMatchObject({
      title: "Recovery failed",
      description: "$25 to @alice. The network turned it down.",
    })
  })

  it("tells a claimer a link is not claimable yet, not the revert", () => {
    const failed = record({
      flow: "paylink-claim",
      state: "failed",
      error: "Assertion failed: window not open",
      cause: "dropped",
    })
    expect(operationEntry(failed)?.description).toBe(PAYLINK_NOT_CLAIMABLE_YET_MESSAGE)
  })

  it("reads a dropped transaction off the store's resolver", async () => {
    const store = getOperationStore()
    await begin("op-dropped", "paylink-reclaim")
    // A field element, as a tx hash is.
    await store.markSent("op-dropped", `0x${"0a".repeat(32)}`)
    store.release("op-dropped")
    await store.resolveSent({ getTxReceipt: async () => ({ status: TxStatus.DROPPED }) as never })
    expect(operationEntry(store.get("op-dropped")!)).toMatchObject({
      title: "Recovery failed",
      description: "$25 to @alice. The network turned it down.",
    })
  })

  // The publish runs before the burn: one the store ended moved nothing, and the move comes back.
  it("lists nothing for an arrival publish the store ended, and the flow's own failure", () => {
    const arrival = { flow: "migration-arrival", state: "failed" as const, summary: "$85.00" }
    expect(operationEntry(record({ ...arrival, cause: "interrupted" }))).toBeNull()
    expect(operationEntry(record({ ...arrival, cause: "dropped" }))).toBeNull()
    expect(operationEntry(record({ ...arrival, error: "node down" }))).toMatchObject({
      title: "Couldn't publish your new address",
      description: "node down",
    })
  })
})
