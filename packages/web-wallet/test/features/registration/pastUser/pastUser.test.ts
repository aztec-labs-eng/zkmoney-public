import { beforeEach, describe, expect, it } from "vitest"
import {
  createPastUser,
  pastUserReducer,
  type PastUserEvent,
  type PastUserState,
} from "../../../../src/features/registration/pastUser"
import type { WebWalletConfig } from "../../../../src/config/env"
import { tabStash } from "../../../../src/platform/storage/tabStash"
import { testAuth, testWagmi } from "../../../support/page"

const pastUserOf = () => createPastUser(tabStash, testWagmi, testAuth(), {} as WebWalletConfig)
const OLD = `0x3f${"00".repeat(17)}a91c` as const
const OWNER = "0xowner"
const run = (...events: PastUserEvent[]) =>
  events.reduce(pastUserReducer, { step: "connect" } as PastUserState)

describe("past-user check", () => {
  beforeEach(() => sessionStorage.clear())

  it("holds a failed step and moves no further", () => {
    const state = run(
      { type: "connected", account: OLD },
      { type: "failed", error: "pastUser.unsigned" },
      { type: "signed" },
    )
    expect(state).toEqual({ step: "sign", account: OLD, error: "pastUser.unsigned" })
  })

  it("ignores a step out of order, and starts over for a new wallet", () => {
    expect(run({ type: "confirmed" }).step).toBe("connect")
    expect(run({ type: "connected", account: OLD }, { type: "confirmed" }).step).toBe("sign")
    const failed = run({ type: "connected", account: OLD }, { type: "failed", error: "unknown" })
    expect(pastUserReducer(failed, { type: "connected", account: OLD })).toEqual({
      step: "sign",
      account: OLD,
    })
  })

  it("reopens its closed modal when it ends, its error a code", async () => {
    const pastUser = pastUserOf()
    pastUser.setOpen(false)
    await pastUser.check(OLD, undefined)
    expect(pastUser.state.get()).toMatchObject({ running: false, open: true })
    expect(pastUser.current(undefined)).toEqual({
      step: "sign",
      account: OLD,
      error: "pastUser.unchecked",
    })
  })

  it("ends as claimed when a grant refuses the proof as spent", () => {
    sessionStorage.setItem("zkm.pastUserVerified", JSON.stringify({ account: OLD }))
    const pastUser = pastUserOf()
    expect(pastUser.current(undefined).step).toBe("confirmed")
    pastUser.claimedAtGrant()
    expect(pastUser.state.get()).toMatchObject({ verified: undefined, open: true })
    expect(pastUser.current(undefined).step).toBe("claimed")
    expect(pastUserOf().current(undefined).step).toBe("connect")
  })

  it("recalls an account's passed check only", () => {
    sessionStorage.setItem(`zkm.pastUserCheck.${OWNER}`, JSON.stringify({ step: "check" }))
    expect(pastUserOf().recall(OWNER)).toEqual({
      step: "connect",
    })
    const passed = { step: "confirmed", account: OLD }
    sessionStorage.setItem(`zkm.pastUserCheck.${OWNER}`, JSON.stringify(passed))
    expect(pastUserOf().recall(OWNER)).toEqual(passed)
  })
})
