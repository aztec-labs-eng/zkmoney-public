// @vitest-environment node
import { createElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { describe, expect, it, vi } from "vitest"
import {
  spottedStage,
  type DepositSpottedProblem,
} from "../../../src/features/deposit/DepositAddressSheet/DepositAddressSheet"

const view = (problem?: DepositSpottedProblem) => ({ amount: "500 USDC", problem })
const html = (node: ReactNode) => renderToStaticMarkup(createElement(MemoryRouter, null, node))
const arrivedNote = (stage: ReturnType<typeof spottedStage>) =>
  html(stage.blocks.find((b) => b.key === "arrived")!.note)

describe("spotted stage", () => {
  it.each<[DepositSpottedProblem | undefined, string, string]>([
    [undefined, "arriving", "arriving"],
    ["capacity", "arriving", "capacity"],
    ["limit", "failed", "limit"],
  ])("shows %s on the %s ring with its own block", (problem, ring, active) => {
    const stage = spottedStage(view(problem), { onClose: () => {} })
    expect(stage.ring).toBe(ring)
    expect(stage.active).toBe(active)
    expect(stage.blocks.map((b) => b.key)).toContain(active)
  })

  it("never stacks an arriving block under an amount over the limit", () => {
    const stage = spottedStage(view("limit"), { onClose: () => {} })
    expect(stage.blocks.map((b) => b.key)).toEqual(["limit"])
  })

  it.each([
    ["Activity when it can open", true],
    ["a close without it", false],
  ])("sends an over-limit amount to %s", (_, canOpen) => {
    const onClose = vi.fn()
    const onOpenActivity = vi.fn()
    const stage = spottedStage(view("limit"), {
      onClose,
      onOpenActivity: canOpen ? onOpenActivity : undefined,
    })
    stage.blocks[0].button!.onClick()
    expect(onOpenActivity).toHaveBeenCalledTimes(canOpen ? 1 : 0)
    expect(onClose).toHaveBeenCalledTimes(canOpen ? 0 : 1)
  })

  it.each<DepositSpottedProblem | undefined>([undefined, "capacity"])(
    "shows funds in the private funds on the arrived ring once claimed, over %s",
    (problem) => {
      const stage = spottedStage(
        { ...view(problem), arrived: "499.75 USDC" },
        { onClose: () => {} },
      )
      expect(stage.ring).toBe("arrived")
      expect(stage.active).toBe("arrived")
      expect(stage.blocks.map((b) => b.key)).toEqual(["arriving", "capacity", "arrived"])
      expect(arrivedNote(stage)).toContain('href="/activity"')
    },
  )

  it("reserves the arrived block without a link while the funds are still arriving", () => {
    const stage = spottedStage(view(), { onClose: () => {} })
    expect(stage.active).toBe("arriving")
    expect(arrivedNote(stage)).not.toContain("<a")
  })

  it("keeps an amount over the limit on the failed ring even with an arrived figure", () => {
    const stage = spottedStage({ ...view("limit"), arrived: "499.75 USDC" }, { onClose: () => {} })
    expect(stage.ring).toBe("failed")
    expect(stage.blocks.map((b) => b.key)).toEqual(["limit"])
  })
})
