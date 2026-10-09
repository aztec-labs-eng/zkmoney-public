/**
 * Requests from people outside the contact book stay out of the Activity feed (and so Home), and an
 * open request sheet closes while its row is hidden.
 */
import { act, type ComponentProps } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, useLocation } from "react-router-dom"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { ContactRow, PaymentRequest } from "@obsidion/front-core"

const directory = vi.hoisted(() => ({ hydrated: true, failed: false }))

const ada: ContactRow = {
  id: "ada",
  name: "Ada",
  tag: "ada",
  address: `0x${"0a".repeat(32)}`,
  addressKind: "aztec-l2",
}
// Added from an incoming transfer, not by the user.
const jo: ContactRow = {
  id: "jo",
  name: "Jo",
  tag: "jo",
  address: `0x${"0b".repeat(32)}`,
  addressKind: "aztec-l2",
  autoAdded: true,
}
const request = (id: string, contactTag: string): PaymentRequest => ({
  id,
  contactTag,
  amount: 12,
  asset: "DAI",
  direction: "incoming",
  status: "pending",
  createdAt: Date.now() - 60_000,
  kind: "contact",
})

vi.mock("../src/config/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/config/env")>()),
  getConfig: () => ({ l1ChainId: 11155111, network: "testnet", nodeUrl: "http://node.invalid" }),
}))
vi.mock("@obsidion/front-core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/front-core")>()),
  useAztecContext: () => ({}),
  useAssetContext: () => ({}),
  useContactsDirectory: () => {
    const contacts = directory.hydrated ? [ada, jo] : []
    return {
      ...directory,
      contacts,
      lookup: (tag: string) => contacts.find((c) => c.tag === tag),
    }
  },
  useSyncCatchingUp: () => false,
  RequestStorage: {
    get: () => ({
      list: async () => [
        request("from-contact", "ada"),
        request("from-stranger", "mina"),
        request("from-auto-added", "jo"),
      ],
      subscribe: () => () => {},
    }),
  },
}))
vi.mock("@obsidion/web-ds", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/web-ds")>()),
  ActivityListRow: (p: ComponentProps<typeof import("@obsidion/web-ds").ActivityListRow>) => (
    <button data-testid="row" onClick={p.onClick}>
      {p.counterparty}
    </button>
  ),
  TopNavIconButton: () => null,
}))
vi.mock("../src/features/paylink/usePaylinkDeps", () => ({ usePaylinkDeps: () => undefined }))
vi.mock("../src/features/paylink/chainTime", () => ({ usePolledChainSeconds: () => undefined }))
vi.mock("../src/features/onboarding/useRegistrationDepositEntry", () => ({
  registrationTagForSipa: () => undefined,
  registrationTagForDeposit: () => undefined,
  useRegistrationDepositEntry: () => null,
}))

const { useActivityEntries } = await import("../src/ui/screens/useActivityEntries")

function Feed() {
  const { entries, hydrated, requestsUnavailable, detailModals } = useActivityEntries()
  return (
    <>
      <output>{String(hydrated)}</output>
      <data>{String(requestsUnavailable)}</data>
      <var>{useLocation().pathname}</var>
      {detailModals}
      {entries.map((e) => (
        <div key={e.id}>{e.node}</div>
      ))}
    </>
  )
}

let container: HTMLDivElement
let root: Root
const render = () =>
  act(async () =>
    root.render(
      <MemoryRouter>
        <Feed />
      </MemoryRouter>,
    ),
  )
const rows = () => [...container.querySelectorAll('[data-testid="row"]')].map((e) => e.textContent)
const hydrated = () => container.querySelector("output")!.textContent
const unavailable = () => container.querySelector("data")!.textContent
const path = () => container.querySelector("var")!.textContent
const sheet = () => document.querySelector('[role="dialog"][aria-label="Payment request"]')
const click = (element: Element) => act(async () => (element as HTMLElement).click())
const openAdaRequest = () => click(container.querySelector('[data-testid="row"]')!)
const send = () =>
  click([...document.querySelectorAll("button")].find((b) => b.textContent === "Send")!)

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  Object.assign(directory, { hydrated: true, failed: false })
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

it("lists a contact's request and leaves a non-contact's, or an auto-added sender's, to its inbox", async () => {
  await render()
  expect(rows()).toEqual(["Ada"])
})

it("is not hydrated until the contacts load", async () => {
  directory.hydrated = false
  await render()
  expect(hydrated()).toBe("false")

  directory.hydrated = true
  await render()
  expect(hydrated()).toBe("true")
  expect(rows()).toEqual(["Ada"])
})

it("reports a failed contacts read instead of an empty request list, until a read lands", async () => {
  directory.hydrated = false
  await render()
  expect(unavailable()).toBe("false")

  directory.failed = true
  await render()
  expect([hydrated(), unavailable()]).toEqual(["true", "true"])
  expect(rows()).toEqual([])

  Object.assign(directory, { hydrated: true, failed: false })
  await render()
  expect(unavailable()).toBe("false")
  expect(rows()).toEqual(["Ada"])
})

it("hides incoming requests and reports unavailable when a read fails after the contacts loaded", async () => {
  await render()
  expect(rows()).toEqual(["Ada"])

  directory.failed = true
  await render()
  expect([hydrated(), unavailable()]).toEqual(["true", "true"])
  expect(rows()).toEqual([])

  directory.failed = false
  await render()
  expect(unavailable()).toBe("false")
  expect(rows()).toEqual(["Ada"])
})

it("pays from an open request sheet", async () => {
  await render()
  await openAdaRequest()
  await send()
  expect([path(), sheet()]).toEqual(["/contacts/ada/send", null])
})

it("closes an open request sheet when a failed contacts read hides its row, and keeps it closed", async () => {
  await render()
  await openAdaRequest()
  expect(sheet()).not.toBeNull()

  directory.failed = true
  await render()
  expect([rows(), unavailable(), sheet()]).toEqual([[], "true", null])

  directory.failed = false
  await render()
  expect([rows(), unavailable(), sheet()]).toEqual([["Ada"], "false", null])

  await openAdaRequest()
  await send()
  expect([path(), sheet()]).toEqual(["/contacts/ada/send", null])
})
