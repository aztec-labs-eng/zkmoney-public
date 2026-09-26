import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

type Person = { name: string; tag: string; address: string; addressKind: "aztec-l2" }
const person = (tag: string, byte: string): Person => ({
  name: tag,
  tag,
  address: `0x${byte.repeat(32)}`,
  addressKind: "aztec-l2",
})
const ADA = person("ada", "aa")
const NEWFRIEND = person("newfriend", "bb")
const BOB = person("bob", "cc")

const m = vi.hoisted(() => ({
  entries: [] as unknown[],
  lookUp: vi.fn(),
  save: vi.fn(),
}))
vi.mock("@obsidion/front-core", () => ({
  ContactStorage: { get: () => ({ getEntries: async () => m.entries }) },
  TransactionStorage: { get: () => ({ getTransactions: async () => [] }) },
  RequestStorage: { get: () => ({ list: async () => [], subscribe: () => () => {} }) },
  getActiveNetworkId: () => "net",
  globalEventEmitter: { onTransactionsUpdated: () => {}, offTransactionsUpdated: () => {} },
  contactRowFromEntry: (e: Person) => ({ id: e.tag, name: e.name, tag: e.tag }),
  isPaymentContactEntry: () => true,
  isUserLabel: () => false,
  normalizeTag: (s: string) => s.trim().replace(/^@/, "").toLowerCase() || null,
  shortenAddressSm: (a: string) => a.slice(0, 6),
  resolveAssetConstants: () => ({ DAI: { decimals: 18, symbol: "DAI" } }),
  updateSavedL1WalletContact: vi.fn(),
  useAssetContext: () => ({ tokenService: undefined }),
  useContactsDirectory: () => ({ contacts: [], refresh: async () => {} }),
}))
vi.mock("@obsidion/web-ds", () => ({
  GlassCircleButton: ({
    ariaLabel,
    onClick,
    children,
  }: {
    ariaLabel: string
    onClick: () => void
    children?: React.ReactNode
  }) => (
    <button aria-label={ariaLabel} onClick={onClick}>
      {children}
    </button>
  ),
  GradientInitialAvatar: () => null,
  GradientText: ({ children }: { children: React.ReactNode }) => (
    <span data-gradient>{children}</span>
  ),
  Icon: () => null,
  PrimaryGradientButton: ({ title, onClick }: { title: string; onClick?: () => void }) => (
    <button onClick={onClick}>{title}</button>
  ),
  Spinner: () => null,
  TextField: () => null,
  TwoPartyAmountCard: () => null,
  avatarColors: () => [],
}))
vi.mock("../src/config/env", () => ({ getConfig: () => ({ network: "sandbox" }) }))
vi.mock("../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
vi.mock("../src/ui/format", () => ({ decimalInput: (s: string) => s, parseAmount: Number }))
vi.mock("../src/ui/hooks", () => ({ useBack: () => () => {} }))
vi.mock("../src/ui/usePhoneLayout", () => ({ usePhoneLayout: () => false }))
vi.mock("../src/ui/screens/activityView", () => ({
  buildActivityRows: () => [],
  txNoteFor: () => undefined,
}))
vi.mock("../src/ui/screens/DepositDetailModal", () => ({ DepositDetailModal: () => null }))
vi.mock("../src/ui/screens/TxDetailModal", () => ({ TxDetailModal: () => null }))
vi.mock("../src/ui/screens/WithdrawalDetailModal", () => ({ WithdrawalDetailModal: () => null }))
vi.mock("../src/features/deposit/sipaGateway", () => ({
  getSipaDepositGateway: () => ({ records: () => [], subscribe: () => () => {} }),
}))
vi.mock("../src/features/withdraw/withdrawGateway", () => ({
  getWithdrawalStore: () => ({
    load: async () => {},
    list: () => [],
    onListChanged: () => () => {},
  }),
}))
vi.mock("../src/features/identity/walletIdentity", () => ({
  loadWalletIdentity: () => ({ handle: "me" }),
}))
vi.mock("../src/platform/storage/WebStorageAdapter", () => ({ webStorage: {} }))
vi.mock("../src/platform/xmtp/MessagingBanner", () => ({ MessagingBanner: () => null }))
vi.mock("../src/platform/xmtp/xmtpLifecycle", () => ({
  getRequestBroadcaster: () => undefined,
  getXmtpInboxState: () => "idle",
  subscribeXmtpInboxState: () => () => {},
}))
vi.mock("../src/features/contacts/ChatBubble", () => ({ ChatBubble: () => null }))
vi.mock("../src/features/contacts/contactChat", () => ({
  buildContactChat: () => [],
  chatMessageSource: () => undefined,
  selectedContactOf: (e: Person) => ({ addressKind: e.addressKind, address: e.address }),
}))
vi.mock("../src/features/contacts/requestActions", () => ({
  declineRequestById: vi.fn(),
  remindRequestById: vi.fn(),
  resolveXmtpAddress: vi.fn(),
}))
vi.mock("../src/features/contacts/requestFlow", () => ({
  announceOutgoingRequest: vi.fn(),
  newOutgoingRequest: vi.fn(),
}))
vi.mock("../src/features/contacts/RequestDetailModal", () => ({ RequestDetailModal: () => null }))
vi.mock("../src/features/contacts/unsavedContact", () => ({
  lookUpUnsavedContact: m.lookUp,
  saveUnsavedContact: m.save,
}))

import { ContactDetailScreen } from "../src/features/contacts/ContactDetailScreen"

type SaveResult = "added" | "changed"
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
type PendingSave = ReturnType<typeof deferred<SaveResult>>

let navigate: (to: string) => void
function Probe() {
  navigate = useNavigate()
  return null
}

let container: HTMLDivElement
let root: Root
const title = () => container.querySelector(".ww-chat__who [data-gradient]")?.textContent
const unsavedStrip = () => container.querySelector(".ww-chat__unsaved")
const alertText = () => container.querySelector("[role=alert]")?.textContent
const addButton = () =>
  container.querySelector<HTMLButtonElement>(".ww-chat__unsaved-add") ?? undefined
const deleteButton = () => container.querySelector('[aria-label="Delete contact"]')
const clickAdd = async () => {
  const button = addButton()!
  expect(button.textContent).toBe("Add contact")
  await act(async () => button.click())
}
const goTo = async (tag: string) => act(async () => navigate(`/contacts/${tag}`))
const unsaved = new Map([
  [NEWFRIEND.tag, NEWFRIEND],
  [BOB.tag, BOB],
])

beforeEach(async () => {
  vi.clearAllMocks()
  vi.spyOn(console, "warn").mockImplementation(() => {})
  m.entries = [ADA]
  m.lookUp.mockImplementation(async (idOrTag: string) => unsaved.get(idOrTag) ?? null)
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <MemoryRouter initialEntries={["/contacts/newfriend"]}>
        <Routes>
          <Route
            path="/contacts/:idOrTag"
            element={
              <>
                <Probe />
                <ContactDetailScreen />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    ),
  )
  expect(title()).toBe("@newfriend")
  expect(unsavedStrip()).not.toBeNull()
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

describe("Add contact on the person page", () => {
  it("saves the person and shows them as saved", async () => {
    const save = deferred<SaveResult>()
    m.save.mockReturnValue(save.promise)
    await clickAdd()
    expect(addButton()!.textContent).toBe("Adding…")
    expect(addButton()!.disabled).toBe(true)
    m.entries = [ADA, NEWFRIEND]
    await act(async () => save.resolve("added"))
    expect(m.save).toHaveBeenCalledWith(NEWFRIEND)
    expect(title()).toBe("@newfriend")
    expect(unsavedStrip()).toBeNull()
    expect(deleteButton()).not.toBeNull()
  })

  it("keeps the error and the retry on the page that started the save", async () => {
    m.save.mockResolvedValueOnce("changed")
    await clickAdd()
    expect(alertText()).toBe("This tag's details changed. Search for it again to add it.")
    expect(addButton()!.disabled).toBe(false)

    m.save.mockRejectedValueOnce(new Error("registry down"))
    await clickAdd()
    expect(alertText()).toBe("Couldn't add this contact. Try again.")
    expect(addButton()!.disabled).toBe(false)

    m.save.mockResolvedValueOnce("added")
    m.entries = [ADA, NEWFRIEND]
    await clickAdd()
    expect(alertText()).toBeUndefined()
    expect(unsavedStrip()).toBeNull()
    expect(deleteButton()).not.toBeNull()
  })

  it("does not let a late save result change the person opened next", async () => {
    const save = deferred<SaveResult>()
    m.save.mockReturnValue(save.promise)
    await clickAdd()
    await goTo("ada")
    expect(title()).toBe("@ada")
    expect(unsavedStrip()).toBeNull()

    m.entries = [ADA, NEWFRIEND]
    await act(async () => save.resolve("added"))
    expect(title()).toBe("@ada")
    expect(unsavedStrip()).toBeNull()
    expect(alertText()).toBeUndefined()
    expect(deleteButton()).not.toBeNull()
    expect(container.textContent).not.toContain("Adding…")
  })

  it.each([
    ["fails", (save: PendingSave) => save.reject(new Error("registry down"))],
    ["reports a changed tag", (save: PendingSave) => save.resolve("changed")],
  ])("does not show the next unsaved person a save that %s", async (_, settle) => {
    const save = deferred<SaveResult>()
    m.save.mockReturnValueOnce(save.promise)
    await clickAdd()
    await goTo("bob")
    expect(title()).toBe("@bob")
    expect(addButton()!.textContent).toBe("Add contact")
    expect(addButton()!.disabled).toBe(false)

    await act(async () => settle(save))
    expect(title()).toBe("@bob")
    expect(alertText()).toBeUndefined()
    expect(addButton()!.disabled).toBe(false)

    m.save.mockResolvedValueOnce("added")
    m.entries = [ADA, BOB]
    await clickAdd()
    expect(m.save).toHaveBeenLastCalledWith(BOB)
    expect(unsavedStrip()).toBeNull()
    expect(deleteButton()).not.toBeNull()
  })

  it("does not apply an earlier visit's save result after a return to the same person", async () => {
    const save = deferred<SaveResult>()
    m.save.mockReturnValueOnce(save.promise)
    await clickAdd()
    await goTo("ada")
    await goTo("newfriend")
    expect(title()).toBe("@newfriend")
    expect(addButton()!.textContent).toBe("Add contact")
    expect(addButton()!.disabled).toBe(false)

    await act(async () => save.resolve("added"))
    expect(unsavedStrip()).not.toBeNull()
    expect(deleteButton()).toBeNull()

    m.save.mockResolvedValueOnce("added")
    m.entries = [ADA, NEWFRIEND]
    await clickAdd()
    expect(m.save).toHaveBeenCalledTimes(2)
    expect(unsavedStrip()).toBeNull()
    expect(deleteButton()).not.toBeNull()
  })
})
