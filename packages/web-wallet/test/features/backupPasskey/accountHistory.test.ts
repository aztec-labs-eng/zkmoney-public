// @vitest-environment node
/**
 * Settings → Account history as the session's previous-account state reads: whether there is an
 * event, where its check stands, and what a find offers.
 */
import { describe, expect, it } from "vitest"
import type { BackupRotationPhase, BackupRotationRecord } from "@obsidion/front-core"
import {
  selectAccountHistory,
  selectHeldTotal,
  selectHistoryRow,
} from "../../../src/features/backupPasskey/accountHistory"
import type {
  PreviousAccountState,
  PreviousHolding,
} from "../../../src/features/backupPasskey/previousAccountWatcher"

const CENT = 10n ** 16n
const PREVIOUS = `0x${"0a".repeat(32)}`
const ELSEWHERE = `0x${"0b".repeat(32)}`
const main = (amount: bigint): PreviousHolding => ({ kind: "main", amount, dust: CENT })
const savings = (amount: bigint, value?: bigint): PreviousHolding => ({
  kind: "savings",
  amount,
  dust: CENT,
  ...(value === undefined ? {} : { value }),
})
const rotation = (phase: BackupRotationPhase, source = PREVIOUS) =>
  ({
    owner: "0x01",
    phase,
    rotation: { builtOver: { l2Address: source } },
  } as unknown as BackupRotationRecord)

const FOUND: PreviousAccountState = {
  address: PREVIOUS,
  holdings: [main(1234n * CENT)],
  signs: true,
  checking: false,
  moving: false,
  refusals: 0,
}
const NOTHING: PreviousAccountState = { signs: false, checking: false, moving: false, refusals: 0 }
const status = (state: Partial<PreviousAccountState>, rotations: unknown = []) => {
  const history = selectAccountHistory({ ...FOUND, ...state }, undefined, rotations as never)
  if (history.kind !== "rotation") throw new Error("expected the rotation's event")
  return history.status
}

describe("selectAccountHistory", () => {
  it("has no event while neither this session nor an earlier one found a previous account", () => {
    expect(selectAccountHistory(NOTHING, undefined, [])).toEqual({ kind: "none" })
  })

  it("lists the saved earlier address before this session finds it, unchecked", () => {
    expect(selectAccountHistory(NOTHING, PREVIOUS, [])).toEqual({
      kind: "rotation",
      earlier: PREVIOUS,
      status: { kind: "unchecked" },
    })
  })

  it("shows a running move, then a running check, over what the last check found", () => {
    expect(status({ moving: true, checking: true })).toEqual({ kind: "moving" })
    expect(status({ checking: true })).toEqual({ kind: "checking" })
  })

  it("calls the address empty only once a check read it and claimed all, leaving out dust", () => {
    expect(status({ holdings: [main(CENT - 1n), savings(0n, 0n)] })).toEqual({ kind: "empty" })
    expect(status({ holdings: [], checkFailed: true })).toEqual({ kind: "incomplete" })
    expect(status({ holdings: [], claimsIncomplete: true })).toEqual({ kind: "incomplete" })
    expect(selectAccountHistory(NOTHING, PREVIOUS, [])).toMatchObject({
      status: { kind: "unchecked" },
    })
  })

  it("says funds may wait on a backup session whose check found nothing but couldn't claim", () => {
    const unclaimed = { holdings: [main(0n)], claimsIncomplete: true, signs: false }
    expect(status(unclaimed)).toEqual({ kind: "unclaimed" })
    expect(status({ ...unclaimed, checkFailed: true })).toEqual({ kind: "incomplete" })
  })

  it("keeps funds a failed or short check found, and offers to move them", () => {
    const found = { kind: "found", held: [main(1234n * CENT)], action: "move" }
    expect(status({ checkFailed: true })).toEqual(found)
    expect(status({ claimsIncomplete: true })).toEqual(found)
  })

  it("offers no move on a session signed with the backup passkey", () => {
    expect(status({ signs: false })).toMatchObject({ note: "backupSession" })
    expect(status({ signs: false })).not.toHaveProperty("action")
  })

  it("offers no move while this device's rotations are loading or unreadable", () => {
    expect(status({}, "loading")).toMatchObject({ note: "rotationsUnread" })
    expect(status({}, "unreadable")).not.toHaveProperty("action")
  })

  it("leaves the move to an unfinished rotation of this account, and to none of another's", () => {
    expect(status({}, [rotation("rerooted")])).toMatchObject({ note: "resume" })
    expect(status({}, [rotation("done"), rotation("rerooted", ELSEWHERE)])).toMatchObject({
      action: "move",
    })
  })

  it("stops offering a move after three spend refusals, or once the cap leaves no chunk", () => {
    expect(status({ refusals: 3 })).toMatchObject({ note: "stuck" })
    expect(status({ refusals: 1, cap: 0n })).toMatchObject({ note: "stuck" })
  })

  it("offers to try again after a refused or failed move, and to move again after a stop", () => {
    const spend = { kind: "refused" as const, reason: "spend" as const, amount: CENT }
    const destination = { ...spend, reason: "destination" as const }
    expect(status({ lastResult: spend, refusals: 1 })).toMatchObject({
      note: "refused",
      action: "retry",
    })
    expect(status({ lastResult: destination })).toMatchObject({ note: "failed", action: "retry" })
    expect(status({ lastResult: { kind: "failed", error: new Error("x") } })).toMatchObject({
      note: "failed",
    })
    expect(status({ lastResult: { kind: "stopped" } })).toMatchObject({ action: "move" })
  })
})

describe("selectHistoryRow", () => {
  it("names no event, one, or one whose check found funds", () => {
    expect(selectHistoryRow(selectAccountHistory(NOTHING, undefined, []))).toBe("none")
    expect(selectHistoryRow(selectAccountHistory(NOTHING, PREVIOUS, []))).toBe("one")
    expect(selectHistoryRow(selectAccountHistory(FOUND, undefined, []))).toBe("found")
  })
})

describe("selectHeldTotal", () => {
  it("adds Main's amount to Savings' value, and has none while the shares have no price", () => {
    expect(selectHeldTotal([main(2n * CENT), savings(5n, 3n * CENT)])).toBe(5n * CENT)
    expect(selectHeldTotal([main(2n * CENT), savings(5n)])).toBeUndefined()
  })
})
