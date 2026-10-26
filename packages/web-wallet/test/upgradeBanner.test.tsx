import { act } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it } from "vitest"
import { UpgradeBanner } from "../src/features/migration/UpgradeIntro"
import {
  setUpgradeStatus,
  useMigrationDialogRequest,
  type UpgradeStatus,
} from "../src/features/migration/migrationDialog"

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

describe("Home's upgrade banner", () => {
  async function banner(status: UpgradeStatus) {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    let requests = 0
    function Requests() {
      requests = useMigrationDialogRequest()
      return null
    }
    const container = document.createElement("div")
    const root = createRoot(container)
    await act(async () => setUpgradeStatus(status))
    await act(async () =>
      root.render(
        <>
          <UpgradeBanner />
          <Requests />
        </>,
      ),
    )
    const button = container.querySelector<HTMLButtonElement>('[data-testid="upgrade-banner"]')
    const text = button?.textContent ?? null
    const before = requests
    if (button) await act(async () => button.click())
    const opened = requests === before + 1
    await act(async () => root.unmount())
    return { text, opened }
  }

  it("offers the upgrade in Figma's words, and opens its dialog", async () => {
    const shown = await banner({ state: "offered", registration: true })
    expect(shown.text).toContain("Faster zk.money available")
    expect(shown.text).toContain("A better wallet with quicker transactions. Tap to upgrade.")
    expect(shown.opened).toBe(true)
  })

  it("asks to keep the tag when a deposit must fund the upgrade", async () => {
    const shown = await banner({ state: "offered", registration: true, external: true })
    expect(shown.text).toContain("Upgrade to keep your tag")
    expect(shown.text).toContain("A better wallet with quicker transactions. Tap to upgrade.")
    expect(shown.opened).toBe(true)
  })

  it("says what is left to do or where a run stands", async () => {
    expect((await banner({ state: "finishing", registration: true })).text).toBe(
      "Finish your upgrade",
    )
    expect((await banner({ state: "running", phase: "arriving", registration: false })).text).toBe(
      "Your funds are on their way",
    )
    expect(
      (await banner({ state: "stopped", phase: "needsApproval", registration: true })).text,
    ).toBe("Your upgrade needs your approval")
    const failed = await banner({ state: "failed", registration: false })
    expect(failed.text).toBe("Couldn't check your old fundsTap to try again.")
    expect(failed.opened).toBe(true)
  })

  it("hides while there is nothing to say", async () => {
    expect((await banner({ state: "checking", registration: false })).text).toBeNull()
    expect((await banner({ state: "none", registration: false })).text).toBeNull()
  })
})
