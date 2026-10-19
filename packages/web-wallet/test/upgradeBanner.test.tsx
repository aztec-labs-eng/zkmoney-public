import { act } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it } from "vitest"
import { UpgradeBanner } from "../src/features/migration/UpgradeIntro"
import {
  setUpgradeOffered,
  useMigrationDialogRequest,
} from "../src/features/migration/migrationDialog"

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

describe("Home's upgrade banner", () => {
  it("shows while the upgrade is offered, and opens its dialog", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    let requests = 0
    function Requests() {
      requests = useMigrationDialogRequest()
      return null
    }
    const container = document.createElement("div")
    const root = createRoot(container)
    const banner = () =>
      container.querySelector<HTMLButtonElement>('[data-testid="upgrade-banner"]')
    await act(async () =>
      root.render(
        <>
          <UpgradeBanner />
          <Requests />
        </>,
      ),
    )
    expect(banner()).toBeNull()

    await act(async () => setUpgradeOffered(true))
    expect(banner()?.textContent).toContain("Faster zk.money available")
    const before = requests
    await act(async () => banner()!.click())
    expect(requests).toBe(before + 1)

    await act(async () => setUpgradeOffered(false))
    expect(banner()).toBeNull()
    await act(async () => root.unmount())
  })
})
