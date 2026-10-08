import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { MemoryRouter, Route, Routes } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  pay: vi.fn(),
  fireEvent: vi.fn(),
}))
vi.mock("../src/features/operations/operations", async () =>
  (await import("./support/fakeOperations")).fakeOperationsModule(),
)
vi.mock("@obsidion/front-core", () => ({
  ContactStorage: { get: () => ({ getEntries: async () => [] }) },
  useAccountContext: () => ({ obsidionAccount: {} }),
  useAssetContext: () => ({ tokenService: {} }),
  useAztecContext: () => ({ obsidionWallet: {} }),
  useContractServiceContext: () => ({ contractService: {} }),
  useBalance: () => ({ walletBalance: "100", assetsLoaded: false }),
  TxInFlightError: class TxInFlightError extends Error {},
  INTERRUPTED_ERRORS: {},
}))
vi.mock("@obsidion/web-ds", () => ({ Icon: () => null, GradientSpinner: () => null }))
vi.mock("../src/lib/analytics", () => ({
  fireEvent: m.fireEvent,
  failureCode: () => "unknown",
  lapTimer: () => () => 0,
  amountBucket: () => "<50",
  requestAmountBucket: () => "<50",
}))
vi.mock("../src/errors/errorModal", () => ({ showReportableError: vi.fn() }))
vi.mock("../src/ui/format", () => ({ parseAmount: Number, floorToCents: () => "100" }))
vi.mock("../src/ui/PayModalChrome", () => ({ PayModalChrome: () => null }))
vi.mock("../src/platform/xmtp/MessagingBanner", () => ({ MessagingBanner: () => null }))
vi.mock("../src/features/identity/walletIdentity", () => ({
  loadWalletIdentity: () => ({ handle: "me" }),
}))
vi.mock("../src/features/contacts/contactsView", () => ({ findContactEntry: () => undefined }))
vi.mock("../src/features/contacts/unsavedContact", () => ({
  lookUpUnsavedContact: async () => null,
}))
vi.mock("../src/features/contacts/contactPay", () => ({ runContactPay: m.pay }))
vi.mock("../src/features/contacts/SendScreen", () => ({ SendScreen: () => null }))
vi.mock("../src/features/contacts/ContactDetailScreen", () => ({ ContactDetailScreen: () => null }))
vi.mock("../src/features/contacts/PayAmountForm", () => ({ PayAmountForm: () => null }))
vi.mock("../src/features/contacts/PayConfirmForm", () => ({
  PayConfirmForm: ({ onConfirm }: { onConfirm: () => void }) => (
    <button onClick={onConfirm}>Send</button>
  ),
}))

import { ContactPayScreen } from "../src/features/contacts/ContactPayScreen"
import { asOperation, endSigningAndHandOff } from "./support/handOff"

let container: HTMLDivElement
let root: Root
const click = async (label: string) => {
  const button = [...container.querySelectorAll("button")].find((b) => b.textContent === label)!
  expect(button).toBeDefined()
  await act(async () => button.click())
}

beforeEach(async () => {
  vi.clearAllMocks()
  m.pay.mockReset()
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () =>
    root.render(
      <MemoryRouter
        initialEntries={[
          {
            pathname: "/contacts/alice/send",
            state: { request: { id: "request", tag: "alice", amount: 25 } },
          },
        ]}
      >
        <Routes>
          <Route path="/contacts/:idOrTag/send" element={<ContactPayScreen mode="send" />} />
          <Route path="/activity" element={<div>Activity</div>} />
        </Routes>
      </MemoryRouter>,
    ),
  )
})
afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

describe("send outcome tracking", () => {
  it.each([true, false])(
    "does not report cancellation on a normal send exit (signing: %s)",
    async (signing) => {
      let settle!: (result: { txHash: string }) => void
      m.pay.mockImplementation(
        asOperation((_args: unknown, onStage: (stage: string) => void) => {
          onStage("proving")
          return new Promise<{ txHash: string }>((resolve) => {
            settle = resolve
          })
        }),
      )
      await click("Send")
      if (signing) {
        await endSigningAndHandOff()
        expect(container.textContent).toBe("Activity")
      }
      await act(async () => settle({ txHash: "0xsend" }))
      expect(container.textContent).toBe("Activity")
      expect(m.fireEvent).toHaveBeenCalledWith("send_submitted", expect.anything())
      expect(m.fireEvent).not.toHaveBeenCalledWith("proving_cancelled", expect.anything())
    },
  )

  it("reports an accepted pre-prove cancellation exactly once", async () => {
    let continueSend!: () => void
    m.pay.mockImplementation(async (_args, onStage) => {
      await new Promise<void>((resolve) => {
        continueSend = resolve
      })
      onStage("proving")
      return { txHash: "0xsend" }
    })
    await click("Send")
    await click("Cancel")
    await act(async () => continueSend())
    await act(async () => root.render(null))
    expect(m.fireEvent.mock.calls.filter(([name]) => name === "proving_cancelled")).toEqual([
      ["proving_cancelled", { flow: "send", stage: "resolving" }],
    ])
  })

  it("reports a failed attempt without also reporting cancellation on exit", async () => {
    m.pay.mockRejectedValue(new Error("Failed"))
    await click("Send")
    await act(async () => root.render(null))
    expect(m.fireEvent).toHaveBeenCalledWith("action_failed", expect.anything())
    expect(m.fireEvent).not.toHaveBeenCalledWith("proving_cancelled", expect.anything())
  })
  it("preserves a failure after a Cancel click that was too late to abort", async () => {
    let advance!: (stage: string) => void
    let rejectSend!: (error: Error) => void
    m.pay.mockImplementation((_args, onStage) => {
      advance = onStage
      return new Promise((_, reject) => {
        rejectSend = reject
      })
    })
    await click("Send")
    const cancel = [...container.querySelectorAll("button")].find(
      (b) => b.textContent === "Cancel",
    )!
    expect(cancel.disabled).toBe(false)
    await act(async () => {
      advance("proving")
      // React has not yet removed the Cancel handler for the new stage.
      cancel.click()
      rejectSend(new Error("Send failed"))
    })
    expect(m.fireEvent).toHaveBeenCalledWith("action_failed", expect.anything())
    await act(async () => root.render(null))
    expect(m.fireEvent).not.toHaveBeenCalledWith("proving_cancelled", expect.anything())
  })
})
