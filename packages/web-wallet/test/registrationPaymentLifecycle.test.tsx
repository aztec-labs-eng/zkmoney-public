import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { beforeEach, afterEach, expect, it, vi } from "vitest"
const h = vi.hoisted(() => ({
  writeContract: vi.fn(),
  receipt: vi.fn(),
  cleared: true,
  report: vi.fn(),
}))
vi.mock("../src/features/deposit/l1Wallet", () => ({
  useL1Wallet: () => ({
    account: "0x00000000000000000000000000000000000000aa",
    walletName: "Rainbow",
    disconnect: vi.fn(),
    connect: vi.fn(),
  }),
  getL1Clients: async () => ({
    walletClient: { writeContract: h.writeContract },
    account: "0x00000000000000000000000000000000000000aa",
    chain: { id: 11155111 },
  }),
}))
vi.mock("../src/ui/screening", () => ({
  useScreenedAddress: () => ({ cleared: h.cleared, verdict: null, rescreen: vi.fn() }),
  ScreeningNotice: () => null,
}))
vi.mock("../src/errors/errorModal", () => ({ showReportableError: h.report }))
vi.mock("../src/ui/hooks", () => ({ useCopy: () => ({ copied: false, copy: vi.fn() }) }))
vi.mock("../src/features/onboarding/registrationFunnel", () => ({
  reportRegistrationDepositShown: vi.fn(),
}))
vi.mock("@obsidion/web-ds", () => ({ Icon: () => null }))
vi.mock("../src/config/env", () => ({ getConfig: () => ({ l1ChainId: 11155111 }) }))
vi.mock("../src/config/oxideTuple", () => ({
  l1PublicClient: () => ({ waitForTransactionReceipt: h.receipt }),
}))
import { DepositPayBlock } from "../src/features/onboarding/steps/DepositAddress"
let root: Root
let el: HTMLDivElement
let sequence = 0
const target: Parameters<typeof DepositPayBlock>[0] = {
  address: "0x00000000000000000000000000000000000000cc",
  token: "0x00000000000000000000000000000000000000dd",
  chainId: 11155111,
  total: 11n,
}
beforeEach(() => {
  h.writeContract.mockReset().mockResolvedValue(`0x${"11".repeat(32)}`)
  h.receipt.mockReset().mockResolvedValue({ status: "success" })
  h.report.mockReset()
  target.address = `0x${(++sequence).toString(16).padStart(40, "0")}`
  h.cleared = true
  el = document.createElement("div")
  document.body.appendChild(el)
  root = createRoot(el)
  act(() => root.render(<DepositPayBlock {...target} />))
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
})
const pay = async () => {
  await act(async () => {
    el.querySelector<HTMLButtonElement>(".ww-deposit__connect")!.click()
  })
}
const button = () => el.querySelector<HTMLButtonElement>(".ww-deposit__connect")!
const reopen = () => {
  act(() => root.render(null))
  act(() => root.render(<DepositPayBlock {...target} />))
}
it("keeps the signing lock when the sheet is reopened", async () => {
  let broadcast!: (hash: string) => void
  h.writeContract.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        broadcast = resolve
      }),
  )
  await pay()
  reopen()
  expect(button().disabled).toBe(true)
  await pay()
  expect(h.writeContract).toHaveBeenCalledTimes(1)
  await act(async () => {
    broadcast(`0x${"11".repeat(32)}`)
  })
  expect(el.textContent).toContain("Payment sent")
})
it("keeps the broadcast lock until confirmation, including after reopening", async () => {
  let confirm!: (receipt: unknown) => void
  h.receipt.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        confirm = resolve
      }),
  )
  await pay()
  expect(el.textContent).toContain("Confirming payment")
  expect(el.textContent).not.toContain("Payment sent")
  reopen()
  await pay()
  expect(h.writeContract).toHaveBeenCalledTimes(1)
  await act(async () => {
    confirm({ status: "success" })
  })
  expect(el.textContent).toContain("Payment sent")
})
it("allows retry after a reverted receipt", async () => {
  h.receipt.mockResolvedValueOnce({ status: "reverted" })
  await pay()
  expect(h.report).toHaveBeenCalledTimes(1)
  expect(button().disabled).toBe(false)
  await pay()
  expect(h.writeContract).toHaveBeenCalledTimes(2)
  expect(el.textContent).toContain("Payment sent")
})
it.each(["cancelled", "replaced"])("allows retry after a %s transaction", async (reason) => {
  h.receipt.mockImplementationOnce(async ({ onReplaced }) => {
    onReplaced({ reason, transaction: { hash: `0x${"22".repeat(32)}` } })
    return { status: "success" }
  })
  await pay()
  expect(h.report).toHaveBeenCalledTimes(1)
  expect(button().disabled).toBe(false)
  await pay()
  expect(h.writeContract).toHaveBeenCalledTimes(2)
})
it("accepts a successful repriced transaction", async () => {
  h.receipt.mockImplementationOnce(async ({ onReplaced }) => {
    onReplaced({ reason: "repriced", transaction: { hash: `0x${"22".repeat(32)}` } })
    return { status: "success" }
  })
  await pay()
  expect(h.report).not.toHaveBeenCalled()
  expect(el.textContent).toContain("Payment sent")
})
it("rechecks the same hash after an RPC failure instead of resending", async () => {
  h.receipt.mockRejectedValueOnce(new Error("RPC timeout"))
  await pay()
  reopen()
  expect(el.textContent).toContain("Check payment status")
  await pay()
  expect(h.writeContract).toHaveBeenCalledTimes(1)
  expect(h.receipt.mock.calls[1][0].hash).toBe(h.receipt.mock.calls[0][0].hash)
  expect(el.textContent).toContain("Payment sent")
})
it("allows retry after a rejected wallet prompt", async () => {
  h.writeContract.mockRejectedValueOnce(new Error("Rejected"))
  await pay()
  expect(button().disabled).toBe(false)
  expect(h.receipt).not.toHaveBeenCalled()
  await pay()
  expect(el.textContent).toContain("Payment sent")
})
it("blocks payment until the sending account is cleared", async () => {
  h.cleared = false
  act(() => root.render(<DepositPayBlock {...target} />))
  await pay()
  expect(h.writeContract).not.toHaveBeenCalled()
})
