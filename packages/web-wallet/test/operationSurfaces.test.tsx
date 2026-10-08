/**
 * The bell's panel lists operations straight off their records: running ones with a spinner,
 * ended ones as their outcome. Nothing is written for an operation, so a reload or an account
 * switch shows exactly what the store holds for the active account.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { walletStorage } from "../src/platform/storage/walletStorage"
import { TxStatus } from "@aztec/stdlib/tx"
import { provingProgress } from "@obsidion/proving-progress"
import {
  AppNotificationStore,
  INTERRUPTED_ERRORS,
  OPERATIONS_STORAGE_KEY,
  WithdrawalStorage,
  type OperationRecord,
} from "@obsidion/front-core"
import { clearActiveStorage, setActiveStorageId } from "../src/platform/storage/activeStorage"
import { webStorage } from "../src/platform/storage/WebStorageAdapter"
import { PAYLINK_NOT_CLAIMABLE_YET_MESSAGE } from "../src/features/paylink/claimWindow"
import { getOperationStore } from "../src/features/operations/operations"
import { operationEntry } from "../src/features/operations/operationEntries"
import { NotificationsPanel, useNotificationList } from "../src/ui/NotificationsPanel"

const legGroups = vi.hoisted(() => new Map<string, string>())
vi.mock("../src/features/withdraw/freshAddressGateway", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  groupOfOperation: (operationId: string) => legGroups.get(operationId),
}))

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
const click = (el: Element | null | undefined) => act(async () => (el as HTMLButtonElement).click())

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
    walletStorage.setItem(
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
    expect(running?.textContent).toContain("Keep this tab open until it's sent")
    expect(running?.querySelector('[role="note"]')).toBeNull()
    await act(async () => {
      provingProgress.emitTxHashSaved("op-panel", hash)
      await new Promise((r) => setTimeout(r, 0))
    })
    expect(running?.textContent).toContain("Sent · You can close this tab")
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
    expect(row).toContain(INTERRUPTED_ERRORS.send)
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

  it("shows a grouped withdrawal's running leg in place of its group's live row", async () => {
    const bell = AppNotificationStore.get(webStorage)
    const withdrawals = WithdrawalStorage.get(webStorage)
    const row = (group: string, entry: "inflight" | "remaining") => {
      const id = `bridge:withdrawal-group:${group}:${entry}`
      return bell.upsert({
        id,
        sourceId: id,
        producer: "bridge",
        domain: "bridge",
        title: "Withdrawal",
        description: `${group} ${entry}`,
        timestampMs: 1,
        systemIcon: "arrow.up.right",
        severity: "info",
        pending: entry === "inflight",
        target: { type: "bridge.txDetail", bridgeKind: "withdrawal", sourceId: group },
      })
    }
    await row("0xa1", "inflight")
    await row("0xa1", "remaining")
    await row("0xb2", "inflight")
    legGroups.set("op-leg", "0xA1")
    await begin("op-leg", "withdraw")
    await renderPanel()
    const listed = () =>
      ["0xa1 inflight", "0xa1 remaining", "0xb2 inflight", "$25 to @alice"].map(
        (text) => !!itemText(text),
      )
    expect(listed()).toEqual([false, true, true, true])
    expect(unread).toBe(2)

    // A sent leg leaves the list, so its group's live row is the one row.
    await act(async () => getOperationStore().markSent("op-leg", hash))
    expect(listed()).toEqual([true, true, true, false])
    expect(unread).toBe(3)

    // A leg an earlier page started: only its record names the group.
    legGroups.clear()
    await act(async () => {
      await withdrawals.create({
        localId: "w-leg",
        operationId: "op-earlier-leg",
        groupId: "0xA1",
        groupLeg: "funds",
        recipient: `0x${"11".repeat(20)}`,
        recipientProvenance: "saved-recipient",
        amount: "25",
        tokenSymbol: "DAI",
        phase: "submitting",
        startTime: 1,
      })
    })
    await begin("op-earlier-leg", "withdraw")
    expect(listed()).toEqual([false, true, true, true])

    await act(async () => {
      await getOperationStore().remove("op-leg")
      await getOperationStore().remove("op-earlier-leg")
      await withdrawals.clearAll()
      await bell.dismissAll()
    })
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

  it("words a thrown failure by flow, never with its raw message", () => {
    const failed = { state: "failed" as const, error: "Assertion failed: Balance too low" }
    expect(operationEntry(record(failed))).toMatchObject({
      title: "Send failed",
      description: "$25 to @alice. It didn't go through. The amount is still in your balance.",
      severity: "error",
    })
    const claim = record({ ...failed, flow: "paylink-claim", summary: "$4 paylink" })
    expect(operationEntry(claim)).toMatchObject({
      title: "Claim failed",
      description: "$4 paylink. It didn't go through.",
    })
    // A thrown failure the store also ended keeps its cause's words.
    const dropped = record({ ...failed, cause: "dropped" })
    expect(operationEntry(dropped)?.description).toBe(
      "$25 to @alice. The network turned it down. The amount is still in your balance.",
    )
  })

  it("words the cause by flow, a tab close as the activity row does", () => {
    const lost = (flow: string) =>
      operationEntry(record({ flow, state: "failed", summary: "$4 paylink", cause: "interrupted" }))
    expect(lost("send")?.description).toBe(`$4 paylink. ${INTERRUPTED_ERRORS.send}`)
    expect(lost("paylink-create")?.description).toBe(
      `$4 paylink. ${INTERRUPTED_ERRORS.paylinkCreate}`,
    )
    expect(lost("paylink-claim")?.description).toBe(
      `$4 paylink. ${INTERRUPTED_ERRORS.paylinkClaim}`,
    )
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
    await store.resolveSent({ getTxReceipt: async () => ({ status: TxStatus.DROPPED } as never) })
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
      description: "Nothing moved. You can try again.",
    })
  })
})
