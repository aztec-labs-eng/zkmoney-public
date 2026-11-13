// @vitest-environment node
import { describe, expect, it } from "vitest"
import {
  MOVE_SCAN_MARGIN,
  MOVE_SCAN_SPAN,
  scannedTo,
  moveScanRange,
  scanRange,
} from "../../src/engine/moveScanCursor"

describe("moveScanRange", () => {
  it("starts at scanFrom with no cursor, and past the cursor with one", () => {
    expect(moveScanRange({ scanFrom: 100n }, 150n)).toEqual({ from: 100n, to: 150n })
    expect(moveScanRange({ scanFrom: 100n, scannedTo: 120n }, 150n)).toEqual({
      from: 121n,
      to: 150n,
    })
    expect(moveScanRange({ scanFrom: 100n, scannedTo: 150n }, 150n)).toBeUndefined()
  })
})

describe("scanRange", () => {
  it("covers one span from the cursor, cut at the head", () => {
    expect(scanRange(100n, 1_000_000n)).toEqual({ from: 100n, to: 100n + MOVE_SCAN_SPAN - 1n })
    expect(scanRange(100n, 150n)).toEqual({ from: 100n, to: 150n })
    expect(scanRange(150n, 150n)).toEqual({ from: 150n, to: 150n })
  })

  it("searches nothing while the cursor is past the head", () => {
    expect(scanRange(151n, 150n)).toBeUndefined()
  })
})

describe("scannedTo", () => {
  it("keeps the whole range when the search stopped short of the head", () => {
    expect(scannedTo(100n, 500n, 1_000n)).toBe(500n)
  })

  it("leaves the margin to search again when the span cut lands inside it", () => {
    const head = MOVE_SCAN_SPAN + 50n
    const { to } = scanRange(0n, head)!
    expect(scannedTo(0n, to, head)).toBe(head - MOVE_SCAN_MARGIN)
  })

  it("records nothing while the search has not passed the move's first block", () => {
    expect(scannedTo(100n, 100n + MOVE_SCAN_MARGIN - 1n, 100n + MOVE_SCAN_MARGIN - 1n)).toBe(
      undefined,
    )
    expect(scannedTo(100n, 100n + MOVE_SCAN_MARGIN, 100n + MOVE_SCAN_MARGIN)).toBe(100n)
  })
})
