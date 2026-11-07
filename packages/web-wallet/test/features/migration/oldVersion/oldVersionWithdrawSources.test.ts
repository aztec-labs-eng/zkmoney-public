import { act, createElement } from "react"
import { createRoot } from "react-dom/client"
import { describe, expect, it, vi } from "vitest"
import {
  setWithdrawableSources,
  skipUnrefundableSource,
  useWithdrawableSources,
} from "../../../../src/features/migration/oldVersionWithdraw"
const source = (portal: string) => ({ source: { portal }, savings: false, open: vi.fn() } as never)

describe("withdrawable sources", () => {
  it("skips an unrefundable portal, and only it, on a later publish", async () => {
    const sources = [source("0xA"), source("0xB")]
    setWithdrawableSources(sources)
    skipUnrefundableSource({ portal: "0xa" } as never)
    const shown = () => {
      let value: readonly { source: { portal: string } }[] = []
      const root = createRoot(document.createElement("div"))
      act(() =>
        root.render(
          createElement(() => {
            value = useWithdrawableSources()
            return null
          }),
        ),
      )
      act(() => root.unmount())
      return value
    }
    expect(shown().map((s) => s.source.portal)).toEqual(["0xB"])

    setWithdrawableSources(sources)
    expect(shown().map((s) => s.source.portal)).toEqual(["0xB"])
  })
})
