import { act } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it } from "vitest"
import { PaylinkSignupRows } from "../src/features/onboarding/steps/PaylinkSignupRows"

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean
}

describe("PaylinkSignupRows", () => {
  it("shows the speed choice just above the network fee", async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement("div")
    const root = createRoot(container)
    await act(async () =>
      root.render(
        <PaylinkSignupRows
          tokenSymbol="DAI"
          tokenDecimals={18}
          speed={<div data-testid="speed">Speed</div>}
        />,
      ),
    )
    const speed = container.querySelector('[data-testid="speed"]')!
    const fee = container.querySelector('[data-testid="paylink-signup-network-fee"]')!
    expect(speed.compareDocumentPosition(fee) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    await act(async () => root.unmount())
  })
})
