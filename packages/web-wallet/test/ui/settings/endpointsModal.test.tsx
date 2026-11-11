/**
 * Two guards the Endpoints sheet's view decides: no save, which reloads, while a transaction is
 * being sent, and no node API key sent to a node it was not saved for.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { startTabBoundOperation } from "../../support/operations"

type Kind = "node" | "l1Rpc" | "enclave"

const { EndpointsModal } = await import("../../../src/ui/EndpointsModal")
const { readEndpointOverrides } = await import("../../../src/config/endpointOverrides")

/** The booted config: each endpoint is the default unless the record holds one. */
function config() {
  const stored = readEndpointOverrides()
  const provenance = (custom?: string) => ({
    source: custom ? "settings" : "default",
    isDefault: !custom,
  })
  return {
    nodeUrl: stored.node ?? "https://node.default.example/rpc",
    l1RpcUrl: stored.l1Rpc ?? "https://rpc.default.example",
    enclaveUrl: stored.enclave ?? "",
    endpoints: {
      node: provenance(stored.node),
      l1Rpc: provenance(stored.l1Rpc),
      enclave: provenance(stored.enclave),
    },
  } as never
}

const RECORD = "webwallet.endpoints"
let root: Root
let container: HTMLDivElement
let endOperation: (() => Promise<void>) | undefined
const onClose = vi.fn()
const reload = vi.fn()

async function mount() {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root.render(<EndpointsModal config={config()} onClose={onClose} reload={reload} />),
  )
}

const store = (record: Record<string, string>) =>
  localStorage.setItem(RECORD, JSON.stringify(record))
const stored = () => JSON.parse(localStorage.getItem(RECORD) ?? "null")
const input = (kind: Kind | "nodeApiKey") =>
  container.querySelector<HTMLInputElement>(`#endpoint-${kind}`)!
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((el) => el.textContent === label)
const useDefault = (kind: Kind) =>
  [...input(kind).closest(".ww-endpoints__field")!.querySelectorAll("button")].find(
    (el) => el.textContent === "Use default",
  )

function fill(kind: Kind | "nodeApiKey", value: string) {
  const el = input(kind)
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
}
const save = () => act(async () => button("Save & reload")!.click())

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  localStorage.clear()
})

afterEach(async () => {
  await act(async () => endOperation?.())
  endOperation = undefined
  await act(async () => root.unmount())
  container.remove()
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

it("while a transaction is being sent, saving is blocked: the reload would lose it", async () => {
  await act(async () => void (endOperation = await startTabBoundOperation()))
  await mount()
  fill("node", "https://node.example")
  expect(container.querySelector('[data-testid="endpoints-busy"]')).not.toBeNull()
  expect(button("Save & reload")!.disabled).toBe(true)
  await save()
  expect(stored()).toBeNull()
  expect(reload).not.toHaveBeenCalled()
})

describe("the node API key", () => {
  it("does not follow the node URL to another node", async () => {
    store({ node: "https://a.example", nodeApiKey: "k-a" })
    await mount()
    const withheld = () => container.querySelector('[data-testid="endpoints-key-withheld"]')
    expect(withheld()).toBeNull()
    fill("node", "https://b.example")
    expect(input("nodeApiKey").value).toBe("")
    expect(withheld()).not.toBeNull()
    await save()
    expect(stored()).toEqual({ node: "https://b.example" })
  })

  it("comes back when the URL returns to its node, and a key typed for a new node is kept", async () => {
    store({ node: "https://a.example", nodeApiKey: "k-a" })
    await mount()
    fill("node", "https://b.example")
    fill("node", "https://a.example")
    expect(input("nodeApiKey").value).toBe("k-a")
    fill("node", "https://b.example")
    fill("nodeApiKey", "k-b")
    await save()
    expect(stored()).toEqual({ node: "https://b.example", nodeApiKey: "k-b" })
  })

  it("Use default on the node clears its key too", async () => {
    store({ node: "https://node.example", nodeApiKey: "k" })
    await mount()
    await act(async () => useDefault("node")!.click())
    expect(input("node").value).toBe("")
    expect(input("nodeApiKey").value).toBe("")
    await save()
    expect(stored()).toBeNull()
  })
})
