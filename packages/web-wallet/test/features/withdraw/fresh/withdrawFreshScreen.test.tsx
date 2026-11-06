/**
 * The fresh-address paste screen: the verdict card, the screener as the only gate on Continue,
 * the modal's checksummed recipient and trimmed name, and the back arrow to the method step.
 */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, useLocation } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { getAddress } from "viem"
import copy from "../../../../src/features/withdraw/WithdrawFreshScreen.copy"
import etherfiCopy from "../../../../src/features/withdraw/etherfiCheck.copy"

type ModalProps = {
  recipient: string
  walletName?: string
  recipientWarning?: { title: string; body: string }
  confirmRecipient?: () => boolean
  onClose(): void
  onDone(): void
}

const h = vi.hoisted(() => ({
  verdict: { kind: "idle" } as { kind: string },
  etherfi: "rejected",
  explorerUrl: undefined as string | undefined,
  cleared: true,
  hook: vi.fn(),
  fireEvent: vi.fn(),
  modal: vi.fn(),
}))

vi.mock("../../../../src/config/env", () => ({ getConfig: () => ({}) }))
vi.mock("../../../../src/features/withdraw/freshAddressCheck", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../src/features/withdraw/freshAddressCheck")>()),
  useFreshAddressVerdict: (address: unknown) => (h.hook(address), h.verdict),
}))
async function etherfiCheckMock(
  importOriginal: () => Promise<typeof import("../../../../src/features/withdraw/etherfiCheck")>,
) {
  return {
    ...(await importOriginal()),
    useEtherfiAddressVerdict: (address: unknown) => ({ kind: address ? h.etherfi : "idle" }),
  }
}
vi.mock("../../../../src/features/withdraw/etherfiCheck", etherfiCheckMock) // slice-check-ignore: unmigrated screen
vi.mock("../../../../src/ui/detailRows", () => ({ l1AddressUrl: () => h.explorerUrl }))
vi.mock("../../../../src/ui/screening", () => ({
  ScreeningNotice: () => <output data-screening />,
  useScreenedAddress: () => ({ verdict: null, cleared: h.cleared, rescreen: vi.fn() }),
}))
vi.mock("../../../../src/lib/analytics", () => ({ fireEvent: h.fireEvent }))
vi.mock("../../../../src/features/withdraw/WithdrawFreshModal/WithdrawFreshModal", () => ({
  WithdrawFreshModal: (props: ModalProps) => {
    h.modal(props)
    return <div data-modal />
  },
}))
vi.mock("@obsidion/web-ds", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@obsidion/web-ds")>()),
  Icon: ({ name }: { name: string }) => <i data-icon={name} />,
  PrimaryGradientButton: (p: { title: string; onClick?: () => void; isDisabled?: boolean }) => (
    <button disabled={p.isDisabled} onClick={p.onClick} children={p.title} />
  ),
}))

const { WithdrawFreshScreen } = await import(
  "../../../../src/features/withdraw/WithdrawFreshScreen"
)
const { FRESH_ADDRESS_VERDICT_COPY } = await import(
  "../../../../src/features/withdraw/freshAddressCheck"
)

const Probe = () => {
  const location = useLocation()
  return (
    <output data-location data-state={JSON.stringify(location.state ?? null)}>
      {location.pathname}
    </output>
  )
}

const LOWER = `0x${"ab".repeat(20)}`
const CHECKSUMMED = getAddress(LOWER)
const EXPLORER = `https://sepolia.etherscan.io/address/${CHECKSUMMED}`

describe("WithdrawFreshScreen", () => {
  let container: HTMLDivElement
  let root: Root

  const inputs = () => Array.from(container.querySelectorAll("input")) as HTMLInputElement[]
  const addressInput = () => inputs()[0]
  const nameInput = () => inputs()[1]
  const continueButton = () =>
    Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Continue")!
  const card = () => container.querySelector<HTMLElement>("[role=status]")
  const modal = () => container.querySelector("[data-modal]")
  const modalProps = () => h.modal.mock.lastCall?.[0] as ModalProps
  const click = (el: Element) => act(async () => (el as HTMLElement).click())
  const type = (input: HTMLInputElement, value: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value)
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
  const render = () =>
    act(async () => {
      root.render(
        <MemoryRouter initialEntries={["/withdraw/fresh"]}>
          <Probe />
          <WithdrawFreshScreen />
        </MemoryRouter>,
      )
    })

  beforeEach(() => {
    h.verdict = { kind: "idle" }
    h.etherfi = "rejected"
    h.cleared = true
    vi.clearAllMocks()
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it("contract verdict: error card, Continue open", async () => {
    h.verdict = { kind: "contract" }
    h.explorerUrl = EXPLORER
    await render()
    await type(addressInput(), LOWER)
    const el = card()!
    expect(el.dataset.tone).toBe("error")
    expect(el.textContent).toContain(FRESH_ADDRESS_VERDICT_COPY.contract.title)
    expect(el.querySelector("a")?.getAttribute("href")).toBe(EXPLORER)
    expect(el.querySelector("a")?.getAttribute("rel")).toBe("noreferrer")
    expect(continueButton().disabled).toBe(false)
  })

  it("keeps Continue disabled while the screener blocks the address", async () => {
    h.verdict = { kind: "fresh" }
    h.cleared = false
    await render()
    await type(addressInput(), LOWER)
    expect(card()).not.toBeNull()
    expect(container.querySelector("[data-screening]")).not.toBeNull()
    expect(continueButton().disabled).toBe(true)
  })

  it("opens the modal with the checksummed recipient and the trimmed name, and goes home once it is away", async () => {
    h.verdict = { kind: "fresh" }
    await render()
    await type(addressInput(), LOWER)
    await type(nameInput(), "   ")
    await click(continueButton())
    expect(h.hook).toHaveBeenLastCalledWith(CHECKSUMMED)
    expect(modalProps()).toMatchObject({ recipient: CHECKSUMMED, walletName: undefined })
    await act(async () => modalProps().onClose())
    expect(modal()).toBeNull()
    expect([addressInput().value, nameInput().value]).toEqual([LOWER, "   "])
    await type(nameInput(), "  Ghost in mempool  ")
    await click(continueButton())
    expect(modalProps().walletName).toBe("Ghost in mempool")
    await act(async () => modalProps().onDone())
    expect(container.querySelector("[data-location]")?.textContent).toBe("/")
  })

  it("holds Continue while ether.fi's factory is still answering", async () => {
    h.verdict = { kind: "fresh" }
    h.etherfi = "checking"
    await render()
    await type(addressInput(), LOWER)
    expect(continueButton().disabled).toBe(true)
    expect(card()).toBeNull()
  })

  it.each([
    [false, false],
    [true, true],
  ] as const)("screening cleared %s: the history status shows %s", async (cleared, shown) => {
    h.verdict = { kind: "checking" }
    h.cleared = cleared
    await render()
    await type(addressInput(), LOWER)
    expect(container.textContent?.includes(copy.checking)).toBe(shown)
    expect(!!container.querySelector("[data-screening]")).toBe(!cleared)
  })

  it.each([
    ["unknown", true],
    ["rejected", false],
  ] as const)("ether.fi %s: the could-not-check warning shows %s", async (kind, shown) => {
    h.verdict = { kind: "fresh" }
    h.etherfi = kind
    await render()
    await type(addressInput(), LOWER)
    expect(container.textContent?.includes(etherfiCopy.unknown.title)).toBe(shown)
    await click(continueButton())
    expect(modalProps().recipientWarning).toEqual(shown ? etherfiCopy.unknown : undefined)
  })

  it.each(["confirmed", "account"])(
    "turns an ether.fi Cash address (%s) away to the ether.fi route, address carried over",
    async (kind) => {
      h.verdict = { kind: "fresh" }
      h.etherfi = kind
      await render()
      await type(addressInput(), LOWER)
      expect(card()?.textContent).toContain(copy.etherfi.title)
      expect(continueButton()).toBeUndefined()
      const route = Array.from(container.querySelectorAll("button")).find(
        (b) => b.textContent === copy.etherfi.action,
      )!
      await click(route)
      const probe = container.querySelector<HTMLElement>("[data-location]")!
      expect(probe.textContent).toBe("/withdraw/etherfi")
      expect(JSON.parse(probe.dataset.state!)).toEqual({ recipient: CHECKSUMMED })
    },
  )

  it("stops the submit and turns away an address ether.fi confirms while the sheet is open", async () => {
    h.verdict = { kind: "fresh" }
    await render()
    await type(addressInput(), LOWER)
    await click(continueButton())
    expect(modalProps().confirmRecipient!()).toBe(true)
    h.etherfi = "account"
    await render()
    let going = true
    await act(async () => void (going = modalProps().confirmRecipient!()))
    expect(going).toBe(false)
    const probe = container.querySelector<HTMLElement>("[data-location]")!
    expect(probe.textContent).toBe("/withdraw/etherfi")
    expect(JSON.parse(probe.dataset.state!)).toEqual({ recipient: CHECKSUMMED })
  })
})
