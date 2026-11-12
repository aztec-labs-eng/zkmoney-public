// @vitest-environment node
/** Which step and line each stage of a backup add picks, and the figures its lines carry. */
import { describe, expect, it } from "vitest"
import {
  approveCopy,
  fundCopy,
  moveCopy,
  stepDetail,
  stepIndex,
} from "../../../src/features/backupPasskey/backupPasskeyCopy"
import type { BackupProgress, BackupStage } from "../../../src/features/backupPasskey/backupScreen"

/** The figures a line shows, in order. */
const figures = (line: string | undefined) => line?.match(/\d+/g) ?? []

const at = (stage: BackupStage, over: Partial<BackupProgress> = {}): BackupProgress => ({
  step: 2,
  stage,
  ...over,
})
const refunds = (landed: number, total: number) => ({ refunds: { landed, total } })
const moved = (included: number, total: number) => ({ moved: { included, total } })

describe("stepIndex", () => {
  it("puts each stage on its step, paying on Fund and a funding that may land on the wait", () => {
    expect(stepIndex(at("sign"))).toBe(1)
    for (const stage of ["publish", "pay"] as const) expect(stepIndex(at(stage))).toBe(2)
    for (const stage of ["landing", "funded", "final"] as const)
      expect(stepIndex(at(stage))).toBe(3)
    for (const stage of ["installing", "moving"] as const) expect(stepIndex(at(stage))).toBe(4)
  })
})

describe("stepDetail", () => {
  it("has no line before the signature, or for a payment nothing has reached yet", () => {
    expect(stepDetail(at("sign"))).toBeUndefined()
    expect(stepDetail(at("pay"))).toBeUndefined()
  })

  it("gives the publish, landing, funded and final stages lines of their own, none naming a wait", () => {
    const lines = [at("publish"), at("landing"), at("funded"), at("final")].map(stepDetail)
    expect(new Set(lines).size).toBe(4)
    for (const line of lines) expect(line).not.toMatch(/minute|finaliz/i)
  })

  it("counts the refunds while one has yet to land, ahead of the move", () => {
    expect(figures(stepDetail(at("moving", { ...refunds(1, 2), ...moved(0, 3) })))).toEqual([
      "1",
      "2",
    ])
  })

  it("counts a move still sending, and says the same as no move once every chunk is in", () => {
    const noMove = stepDetail(at("moving"))
    expect(figures(stepDetail(at("moving", moved(1, 3))))).toEqual(["1", "3"])
    expect(stepDetail(at("moving", moved(3, 3)))).toBe(noMove)
  })

  it("says the network is confirming the backup again while the sweep re-lands, on any step", () => {
    for (const stage of ["final", "installing", "moving"] as const) {
      const line = stepDetail(at(stage, { relanding: true }))
      expect(line).toBeDefined()
      expect(line).not.toBe(stepDetail(at(stage)))
    }
    expect(stepDetail(at("moving", { relanding: true, ...moved(1, 3) }))).toBe(
      stepDetail(at("final", { relanding: true })),
    )
  })

  it("names the install apart from the move", () => {
    const install = stepDetail(at("installing"))
    expect(install).toBeDefined()
    expect(install).not.toBe(stepDetail(at("moving")))
  })
})

describe("approveCopy", () => {
  it("sets the approving passkey's name apart, and leaves the slots empty without one", () => {
    for (const line of [approveCopy.detail, approveCopy.declined]) {
      expect(line("Laptop")[1]).toBe("Laptop")
      expect(line()[1]).toBe("")
      expect(line()[2]).toBe("")
    }
    expect(approveCopy.detail("Laptop")).not.toEqual(approveCopy.declined("Laptop"))
    expect(approveCopy.detail()).not.toEqual(approveCopy.declined())
  })
})

describe("moveCopy.line", () => {
  it("counts the next refund from one, and has no count for a single link", () => {
    expect(figures(moveCopy.line(at("moving", refunds(0, 2))))).toEqual(["1", "2"])
    expect(figures(moveCopy.line(at("moving", refunds(0, 1))))).toEqual([])
  })

  it("counts the next part of a move in parts, and asks for the whole balance otherwise", () => {
    const whole = moveCopy.line(at("moving"))
    expect(figures(moveCopy.line(at("moving", moved(1, 3))))).toEqual(["2", "3"])
    expect(moveCopy.line(at("moving", moved(0, 1)))).toBe(whole)
    expect(whole).not.toBe(moveCopy.line(at("moving", refunds(0, 1))))
  })
})

describe("fundCopy.approvalsValue", () => {
  it("counts the approvals now and the moves, and the refunds between them when there are any", () => {
    expect(fundCopy.approvalsValue(1, 2)).toBe(fundCopy.approvalsValue(1, 2, 0))
    expect(figures(fundCopy.approvalsValue(1, 2))).toEqual(["1", "2"])
    expect(figures(fundCopy.approvalsValue(1, 2, 3))).toEqual(["1", "3", "2"])
  })

  it("names one link apart from several", () => {
    const shape = (refunds: number) => fundCopy.approvalsValue(1, 2, refunds).replace(/\d+/g, "#")
    expect(shape(1)).not.toBe(shape(2))
    expect(shape(2)).toBe(shape(3))
  })
})
