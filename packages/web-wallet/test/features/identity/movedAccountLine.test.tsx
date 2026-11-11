/** Home's one-time line after a reload into the account a backup add elsewhere moved the wallet to. */
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { MovedAccountLine } from "../../../src/features/identity/MovedAccountLine/MovedAccountLine"
import { markMovedAccount, movedAccountMark } from "../../../src/features/identity/movedAccount"
import copy from "../../../src/features/identity/MovedAccountLine/MovedAccountLine.copy"
import { setIdentity } from "../../support/identity"
import { seedDeviceKeys } from "../../support/page"
import { openTestSession } from "../../support/session"

const ADDRESS = `0x${"bb".repeat(32)}`

describe("MovedAccountLine", () => {
  let root: Root | undefined
  let container: HTMLDivElement

  async function show() {
    container = document.createElement("div")
    document.body.appendChild(container)
    root = createRoot(container)
    await act(async () => root!.render(<MovedAccountLine />))
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)))
  }

  const line = () => container.querySelector('[data-testid="moved-account-line"]')

  beforeEach(async () => {
    sessionStorage.clear()
    await seedDeviceKeys({ storageId: "acct", credentialId: "cred" })
    openTestSession()
    await setIdentity({ address: ADDRESS, handle: "alice" })
  })

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
  })

  it("shows the copy once for the session's account and clears the mark", async () => {
    markMovedAccount(ADDRESS.toUpperCase())
    await show()
    expect(line()?.textContent).toContain(copy.body)
    expect(movedAccountMark()).toBeUndefined()
  })

  it("renders nothing without a mark", async () => {
    await show()
    expect(line()).toBeNull()
  })

  it("renders nothing for a mark naming another account, and clears it", async () => {
    markMovedAccount(`0x${"cc".repeat(32)}`)
    await show()
    expect(line()).toBeNull()
    expect(movedAccountMark()).toBeUndefined()
  })

  it("OK hides the line", async () => {
    markMovedAccount(ADDRESS)
    await show()
    const button = container.querySelector<HTMLButtonElement>(
      '[data-testid="moved-account-dismiss"]',
    )
    await act(async () => button!.click())
    expect(line()).toBeNull()
  })
})
