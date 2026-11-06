import { describe, expect, it } from "vitest"
import {
  entryBlock,
  type EntryConditions,
} from "../../../src/features/backupPasskey/backupPasskeyEntry"

const DAI = 10n ** 18n
const amount = (atomic: bigint) => `${atomic / DAI} DAI`

const ready: EntryConditions = {
  sessionIsRoot: true,
  verified: true,
  routeLive: true,
  registered: true,
  savingsMoving: false,
  withdrawalInFlight: false,
  historicBalance: false,
  balance: 10n * DAI,
  fundingAmount: 2n * DAI,
  chunk: { kind: "fits" },
  plan: true,
  usesLeft: true,
}

const date = (sec: number) => `day ${sec}`

const block = (over: Partial<EntryConditions>) => entryBlock({ ...ready, ...over }, amount, date)

describe("the add entry's conditions", () => {
  it("names each unmet condition", () => {
    expect(block({ sessionIsRoot: false })?.line).toBe("Use your first passkey to add a backup")
    expect(block({ verified: false })?.line).toBe("This account is not registered yet")
    expect(block({ routeLive: false })?.line).toBe("Not available on this network yet")
    expect(block({ registered: false })).toEqual({
      line: "Sponsored transactions are not set up",
      action: "sponsorship",
    })
    expect(block({ savingsMoving: true })).toEqual({
      line: "Finish your Savings move first",
      action: "savings",
    })
    expect(block({ withdrawalInFlight: true })).toEqual({
      line: "Finish your withdrawal first",
      action: "activity",
    })
    expect(block({ linkHold: { kind: "creating" } })).toEqual({
      line: "Finish creating your paylink first",
      action: "activity",
    })
    expect(block({ linkHold: { kind: "token" } })).toEqual({
      line: "Cancel your paylinks from before the upgrade first",
      action: "activity",
    })
    expect(block({ linkHold: { kind: "cancel" } })).toEqual({
      line: "Cancel your paylink in Activity first",
      action: "activity",
    })
    expect(block({ linkHold: { kind: "expiry", until: 2000 } })).toEqual({
      line: "A paylink you made can't be cancelled until it expires on day 2000. Try again then.",
    })
    expect(block({ historicBalance: true })).toEqual({
      line: "Finish your migration first",
      action: "migration",
    })
    expect(block({ balance: DAI })?.line).toBe("You need at least 2 DAI to add a backup")
    expect(block({ chunk: { kind: "short", chunk: 3n * DAI } })?.line).toBe(
      "Your balance is in too many small pieces to fund this. Send yourself 3 DAI first.",
    )
    expect(block({ plan: false })?.line).toBe(
      "Part of your balance is still syncing. Try again in a moment.",
    )
    expect(block({ usesLeft: false })?.line).toBe(
      "Not enough sponsored transactions left this period",
    )
  })

  it("names a Savings move's burn as the move, not as a withdrawal", () => {
    expect(block({ savingsMoving: true, withdrawalInFlight: true })?.line).toBe(
      "Finish your Savings move first",
    )
  })

  it("a balance exactly at the funding amount is enough", () => {
    expect(block({ balance: 2n * DAI })).toBeUndefined()
  })
})
