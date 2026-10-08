import React, { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type Kind = "node" | "l1Rpc" | "enclave"
type Overrides = Partial<Record<Kind | "nodeApiKey", string>>
type Values = Record<Kind, string> & { nodeApiKey?: string }
type WriteResult =
  | { ok: true }
  | { ok: false; reason: "invalid"; kind: Kind | "nodeApiKey" }
  | { ok: false; reason: "changed" }
  | { ok: false; reason: "storage" }

const h = vi.hoisted(() => ({
  overrides: {} as Partial<Record<"node" | "l1Rpc" | "enclave" | "nodeApiKey", string>>,
  isDefault: { node: true, l1Rpc: true, enclave: true },
  losesTransaction: false,
  write:
    vi.fn<
      (
        next: Record<"node" | "l1Rpc" | "enclave", string> & { nodeApiKey?: string },
        seen: Partial<Record<"node" | "l1Rpc" | "enclave" | "nodeApiKey", string>>,
      ) => WriteResult
    >(),
}))

vi.mock("@obsidion/web-ds", () => ({
  Icon: () => null,
  GradientText: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  PrimaryGradientButton: ({
    title,
    onClick,
    isDisabled,
    isLoading,
  }: {
    title: string
    onClick: () => void
    isDisabled?: boolean
    isLoading?: boolean
  }) => (
    <button disabled={isDisabled || isLoading} onClick={onClick}>
      {title}
    </button>
  ),
  TopNavIconButton: ({ onClick }: { onClick: () => void }) => (
    <button aria-label="Close" onClick={onClick} />
  ),
}))
vi.mock("../src/config/env", () => ({
  getConfig: () => ({
    nodeUrl: h.overrides.node ?? "https://node.default.example/rpc",
    l1RpcUrl: h.overrides.l1Rpc ?? "https://rpc.default.example",
    enclaveUrl: h.overrides.enclave ?? "",
    endpoints: {
      node: { source: h.overrides.node ? "settings" : "default", isDefault: h.isDefault.node },
      l1Rpc: { source: h.overrides.l1Rpc ? "settings" : "default", isDefault: h.isDefault.l1Rpc },
      enclave: {
        source: h.overrides.enclave ? "settings" : "default",
        isDefault: h.isDefault.enclave,
      },
    },
  }),
}))
vi.mock("../src/features/operations/operations", () => ({
  useLeavingLosesTransaction: () => h.losesTransaction,
}))
vi.mock("../src/config/endpointOverrides", async (original) => ({
  ...(await original<typeof import("../src/config/endpointOverrides")>()),
  readEndpointOverrides: () => h.overrides,
  writeEndpointOverrides: (next: Values, seen: Overrides) => h.write(next, seen),
}))

const { EndpointsModal } = await import("../src/ui/EndpointsModal")

const WARNING =
  "The node's operator sees your IP address and can tell which transactions your wallet sends and receives, but not what is in them."
const COST =
  "Switching starts a fresh sync of your history for this node. Your history on the default node is kept."
const LABELS: Record<Kind, string> = {
  node: "Aztec node URL",
  l1Rpc: "Ethereum RPC URL",
  enclave: "Enclave URL",
}

let root: Root
let container: HTMLDivElement
const onClose = vi.fn()
const reload = vi.fn()

async function mount() {
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<EndpointsModal onClose={onClose} reload={reload} />))
}

const input = (kind: Kind | "nodeApiKey") =>
  container.querySelector<HTMLInputElement>(`#endpoint-${kind}`)!
const field = (kind: Kind | "nodeApiKey") => input(kind).closest(".ww-endpoints__field")!
const fieldError = (kind: Kind | "nodeApiKey") =>
  field(kind).querySelector('[role="alert"]')?.textContent
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((el) => el.textContent === label)
const useDefault = (kind: Kind) =>
  [...field(kind).querySelectorAll("button")].find((el) => el.textContent === "Use default")
const saveError = () => container.querySelector('[data-testid="endpoints-save-error"]')?.textContent

function fill(kind: Kind | "nodeApiKey", value: string) {
  const el = input(kind)
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
  })
}
const save = () => act(async () => button("Save & reload")!.click())

beforeEach(() => {
  h.overrides = {}
  h.isDefault = { node: true, l1Rpc: true, enclave: true }
  h.losesTransaction = false
  // The fake writes through to the reader's store, so a read-back after a save sees the write.
  h.write.mockImplementation((next) => {
    h.overrides = {}
    for (const kind of ["node", "l1Rpc", "enclave", "nodeApiKey"] as const) {
      const value = next[kind]?.trim() ?? ""
      if (value !== "") h.overrides[kind] = value
    }
    return { ok: true }
  })
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

describe("EndpointsModal", () => {
  it("shows the warning, the cost, the three fields and their current values", async () => {
    h.overrides = { node: "https://node.example" }
    h.isDefault.node = false
    await mount()
    expect(container.textContent).toContain(WARNING)
    expect(container.textContent).toContain(COST)
    for (const kind of ["node", "l1Rpc", "enclave"] as const) {
      expect(container.querySelector(`label[for="endpoint-${kind}"]`)?.textContent).toBe(
        LABELS[kind],
      )
    }
    expect(input("node").value).toBe("https://node.example")
    expect(input("l1Rpc").value).toBe("")
    expect(input("enclave").value).toBe("")
    expect(container.textContent).toContain(
      "How the wallet reads the Aztec Network and sends transactions. Any node serving the same network works.",
    )
    expect(container.textContent).toContain(
      "How the wallet reads Ethereum. Any provider's endpoint works, including one you pay for.",
    )
    expect(container.textContent).toContain(
      "The Oxide enclave that co-signs your sends and withdrawals. Any registered enclave works.",
    )
    expect(container.textContent).toContain("Leave a field empty to use the default.")
    expect(container.textContent).not.toContain("shows your balance")
    // The privacy and trust warning is the node's alone.
    expect(field("l1Rpc").textContent).not.toContain("trust")
  })

  it("puts the default host in the placeholder while the default is in use", async () => {
    await mount()
    expect(input("node").placeholder).toBe("Default: node.default.example")
    expect(input("l1Rpc").placeholder).toBe("Default: rpc.default.example")
    expect(input("enclave").placeholder).toBe(
      "Leave blank to use the address in zk.money's configuration",
    )
  })

  it("hides a default a custom URL replaced", async () => {
    h.overrides = { node: "https://node.example" }
    h.isDefault.node = false
    await mount()
    expect(input("node").placeholder).toBe("Leave blank to use the address built into the app")
  })

  it("saves a node URL, leaves the other fields alone and reloads", async () => {
    await mount()
    expect(button("Save & reload")!.disabled).toBe(true)
    fill("node", "https://node.example")
    await save()
    expect(h.write).toHaveBeenCalledTimes(1)
    expect(h.write).toHaveBeenCalledWith(
      { node: "https://node.example", l1Rpc: "", enclave: "", nodeApiKey: "" },
      {},
    )
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["l1Rpc", "https://rpc.example"],
    ["enclave", "https://enclave.example"],
  ] as const)("saves only the %s field and reloads", async (kind, url) => {
    await mount()
    fill(kind, url)
    await save()
    expect(h.write).toHaveBeenCalledTimes(1)
    expect(h.write).toHaveBeenCalledWith(expect.objectContaining({ [kind]: url }), {})
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it.each([
    ["node", "ftp://x"],
    ["l1Rpc", "https://u:p@node.example"],
    ["enclave", "not a url"],
  ] as const)("refuses %s = %s inline and stores nothing", async (kind, url) => {
    await mount()
    fill(kind, url)
    expect(fieldError(kind)).toBe("Enter a full http(s) URL, with no username or password.")
    expect(input(kind).getAttribute("aria-invalid")).toBe("true")
    expect(button("Save & reload")!.disabled).toBe(true)
    await save()
    expect(h.write).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  it("a refused write stores nothing, says so and keeps the edits", async () => {
    h.overrides = { node: "https://old-node.example" }
    h.isDefault = { node: false, l1Rpc: true, enclave: true }
    h.write.mockImplementation(() => ({ ok: false, reason: "storage" }))
    await mount()
    fill("node", "https://node.example")
    fill("l1Rpc", "https://rpc.example")
    await save()
    expect(h.write).toHaveBeenCalledTimes(1)
    expect(saveError()).toBe("Couldn't save: this browser refused the write.")
    expect(reload).not.toHaveBeenCalled()
    // Storage holds what the wallet booted on; the editor still holds the typed values.
    expect(h.overrides).toEqual({ node: "https://old-node.example" })
    expect(input("node").value).toBe("https://node.example")
    expect(button("Save & reload")!.disabled).toBe(false)
    fill("node", "https://node2.example")
    expect(saveError()).toBeUndefined()
  })

  it.each([
    ["a query", "https://enclave.example/?x"],
    ["a fragment", "https://enclave.example/#x"],
    ["the /rpc path", "https://enclave.example/rpc"],
  ])("an enclave URL with %s cannot be saved", async (_label, url) => {
    await mount()
    fill("enclave", url)
    expect(fieldError("enclave")).toBe(
      "Enter the enclave's origin only: no query, fragment or /rpc.",
    )
    expect(button("Save & reload")!.disabled).toBe(true)
    await save()
    expect(h.write).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  it("clears an override through Use default on save", async () => {
    h.overrides = { node: "https://node.example", enclave: "https://enclave.example" }
    h.isDefault = { node: false, l1Rpc: true, enclave: false }
    await mount()
    expect(useDefault("l1Rpc")).toBeUndefined()
    await act(async () => useDefault("node")!.click())
    expect(input("node").value).toBe("")
    expect(useDefault("node")).toBeUndefined()
    await save()
    expect(h.write).toHaveBeenCalledTimes(1)
    // The record the editor opened with rides along, so a save another tab outran is refused.
    expect(h.write).toHaveBeenCalledWith(
      { node: "", l1Rpc: "", enclave: "https://enclave.example", nodeApiKey: "" },
      { node: "https://node.example", enclave: "https://enclave.example" },
    )
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("a save another tab outran is refused, with the edits kept", async () => {
    h.write.mockImplementation(() => ({ ok: false, reason: "changed" }))
    await mount()
    fill("node", "https://node.example")
    await save()
    expect(saveError()).toBe(
      "Another tab changed the endpoints. Close this and open it again to edit them.",
    )
    expect(input("node").value).toBe("https://node.example")
    expect(reload).not.toHaveBeenCalled()
  })

  it("while a transaction is being sent, saving is blocked: the reload would lose it", async () => {
    h.losesTransaction = true
    await mount()
    fill("node", "https://node.example")
    expect(container.querySelector('[data-testid="endpoints-busy"]')?.textContent).toBe(
      "A transaction is still being sent, and saving reloads the wallet. Wait for it to finish.",
    )
    expect(button("Save & reload")!.disabled).toBe(true)
    await save()
    expect(h.write).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  it("offers Use default only where an override exists", async () => {
    await mount()
    for (const kind of ["node", "l1Rpc", "enclave"] as const) {
      expect(useDefault(kind)).toBeUndefined()
    }
  })

  it("cancels without writing", async () => {
    await mount()
    fill("node", "https://node.example")
    await act(async () => button("Cancel")!.click())
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(h.write).not.toHaveBeenCalled()
    expect(reload).not.toHaveBeenCalled()
  })

  describe("the node API key", () => {
    it("is masked, holds the saved key, and shows nowhere else", async () => {
      h.overrides = { node: "https://node.example", nodeApiKey: "secret-key-1" }
      h.isDefault.node = false
      await mount()
      expect(input("nodeApiKey").type).toBe("text")
      expect(input("nodeApiKey").classList).toContain("ww-endpoints__input--secret")
      expect(input("nodeApiKey").getAttribute("autocomplete")).toBe("off")
      expect(input("nodeApiKey").hasAttribute("data-1p-ignore")).toBe(true)
      expect(input("nodeApiKey").getAttribute("data-lpignore")).toBe("true")
      expect(input("nodeApiKey").getAttribute("data-bwignore")).toBe("true")
      expect(input("nodeApiKey").value).toBe("secret-key-1")
      expect(input("nodeApiKey").placeholder).toBe("Leave blank if your node needs no key")
      expect(container.querySelector('label[for="endpoint-nodeApiKey"]')?.textContent).toBe(
        "Aztec node API key",
      )
      expect(container.textContent).not.toContain("secret-key-1")
      expect(container.textContent).toContain("Only needed if the node above asks for one.")
    })

    it("saves with its node and reloads", async () => {
      await mount()
      fill("node", "https://node.example")
      fill("nodeApiKey", "k-1")
      await save()
      expect(h.write).toHaveBeenCalledWith(
        { node: "https://node.example", l1Rpc: "", enclave: "", nodeApiKey: "k-1" },
        {},
      )
      expect(reload).toHaveBeenCalledTimes(1)
    })

    it("a changed key alone is a change worth saving", async () => {
      h.overrides = { node: "https://node.example", nodeApiKey: "old" }
      h.isDefault.node = false
      await mount()
      expect(button("Save & reload")!.disabled).toBe(true)
      fill("nodeApiKey", "new")
      await save()
      expect(h.write).toHaveBeenCalledWith(
        { node: "https://node.example", l1Rpc: "", enclave: "", nodeApiKey: "new" },
        { node: "https://node.example", nodeApiKey: "old" },
      )
    })

    it.each([
      ["without a node URL", "", "k", "Enter the node URL this key is for."],
      [
        "with a space",
        "https://node.example",
        "a b",
        "Enter the key as issued: no spaces, at most 512 characters.",
      ],
    ])("cannot be saved %s", async (_label, node, key, message) => {
      await mount()
      if (node) fill("node", node)
      fill("nodeApiKey", key)
      expect(fieldError("nodeApiKey")).toBe(message)
      expect(input("nodeApiKey").getAttribute("aria-invalid")).toBe("true")
      expect(button("Save & reload")!.disabled).toBe(true)
      await save()
      expect(h.write).not.toHaveBeenCalled()
    })

    it("does not follow the node URL to another node", async () => {
      h.overrides = { node: "https://a.example", nodeApiKey: "k-a" }
      h.isDefault.node = false
      await mount()
      const withheld = () => container.querySelector('[data-testid="endpoints-key-withheld"]')
      expect(withheld()).toBeNull()
      fill("node", "https://b.example")
      expect(input("nodeApiKey").value).toBe("")
      expect(withheld()).not.toBeNull()
      await save()
      expect(h.write).toHaveBeenCalledWith(
        { node: "https://b.example", l1Rpc: "", enclave: "", nodeApiKey: "" },
        { node: "https://a.example", nodeApiKey: "k-a" },
      )
    })

    it("comes back when the URL returns to its node, and a key typed for a new node is kept", async () => {
      h.overrides = { node: "https://a.example", nodeApiKey: "k-a" }
      h.isDefault.node = false
      await mount()
      fill("node", "https://b.example")
      fill("node", "https://a.example")
      expect(input("nodeApiKey").value).toBe("k-a")
      fill("node", "https://b.example")
      fill("nodeApiKey", "k-b")
      await save()
      expect(h.write).toHaveBeenCalledWith(
        { node: "https://b.example", l1Rpc: "", enclave: "", nodeApiKey: "k-b" },
        { node: "https://a.example", nodeApiKey: "k-a" },
      )
    })

    it("Use default on the node clears its key too", async () => {
      h.overrides = { node: "https://node.example", nodeApiKey: "k" }
      h.isDefault.node = false
      await mount()
      await act(async () => useDefault("node")!.click())
      expect(input("node").value).toBe("")
      expect(input("nodeApiKey").value).toBe("")
      expect(fieldError("nodeApiKey")).toBeUndefined()
      await save()
      expect(h.write).toHaveBeenCalledWith(
        { node: "", l1Rpc: "", enclave: "", nodeApiKey: "" },
        { node: "https://node.example", nodeApiKey: "k" },
      )
    })
  })
})
