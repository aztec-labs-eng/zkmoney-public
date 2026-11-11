// @vitest-environment node
/** The wallet picker's flow: it waits on the wallet's account dialog, and a refusal stays put. */
import { describe, expect, it, vi } from "vitest"
import { openChangeWalletFlow } from "../../../src/features/deposit/ChangeWalletPicker/changeWalletFlow"

function world(switched: boolean) {
  let answer: (ok: boolean) => void = () => {}
  const l1 = {
    switchAccount: vi.fn(() => new Promise<boolean>((resolve) => (answer = resolve))),
    openPicker: vi.fn(async () => {}),
    pickerShown: () => true,
  }
  const connectAnother = vi.fn(async () => undefined)
  const onPicked = vi.fn()
  const flow = openChangeWalletFlow({ l1Wallet: { connectAnother } }, () => ({ l1, onPicked }))
  const shown = new AbortController()
  flow.start(shown.signal)
  return { flow, l1, connectAnother, onPicked, shown, answer: () => answer(switched) }
}

describe("the wallet picker", () => {
  it("waits while the wallet's account dialog is up, and closes once it answers", async () => {
    const w = world(true)
    const asking = w.flow.switchAccount()
    expect(w.flow.state.get().waiting).toBe(true)
    w.answer()
    await asking
    expect(w.flow.state.get().waiting).toBe(false)
    expect(w.onPicked).toHaveBeenCalledWith(true)
  })

  it("stays open on a refusal", async () => {
    const w = world(false)
    const asking = w.flow.switchAccount()
    w.answer()
    await asking
    expect(w.flow.state.get().waiting).toBe(false)
    expect(w.onPicked).not.toHaveBeenCalled()
  })

  it("asks the page's wallet for another through the latest picker opener", () => {
    const w = world(true)
    w.flow.connectAnother()
    expect(w.connectAnother).toHaveBeenCalledWith(w.l1.openPicker, w.l1.pickerShown)
    expect(w.onPicked).toHaveBeenCalledWith(true)
  })
})
