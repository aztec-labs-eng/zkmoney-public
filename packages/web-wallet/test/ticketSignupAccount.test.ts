import { beforeEach, describe, expect, it } from "vitest"
import {
  beginTicketSignupAccount,
  completeTicketSignupAccount,
  loadTicketSignupAccount,
  loadTicketSignupAttempt,
  restartTicketSignupAccount,
  saveTicketSignupAccount,
} from "../src/features/paylink/ticketSignupAccount"

const account = { credentialId: "created-passkey", l2Address: `0x${"ab".repeat(32)}` }

describe("ticket signup creation checkpoints", () => {
  beforeEach(() => localStorage.clear())

  it("an interrupted attempt cannot be mistaken for an account or a new signup", () => {
    const attempt = beginTicketSignupAccount("rp", "link", "alice")
    expect(loadTicketSignupAttempt("rp", "link")).toEqual(attempt)
    expect(() => loadTicketSignupAccount("rp", "link")).toThrow("previous passkey attempt")
    expect(() => beginTicketSignupAccount("rp", "link", "bob")).toThrow("already has a signup")
  })

  it("completes the same attempt with its original tag and survives reopening", () => {
    const attempt = beginTicketSignupAccount("rp", "link", "alice")
    completeTicketSignupAccount("rp", "link", attempt.attemptId, account)
    expect(loadTicketSignupAccount("rp", "link")).toEqual({ ...account, tag: "alice" })
    expect(() => restartTicketSignupAccount("rp", "link", attempt.attemptId)).toThrow(
      "already has an account",
    )
  })

  it("a late completion cannot overwrite an explicitly restarted attempt", () => {
    const first = beginTicketSignupAccount("rp", "link", "alice")
    restartTicketSignupAccount("rp", "link", first.attemptId)
    const second = beginTicketSignupAccount("rp", "link", "bob")
    expect(() => completeTicketSignupAccount("rp", "link", first.attemptId, account)).toThrow(
      "no longer active",
    )
    expect(loadTicketSignupAttempt("rp", "link")).toEqual(second)
  })

  it("a tab that saw an older attempt cannot restart the one another tab began since", () => {
    const first = beginTicketSignupAccount("rp", "link", "alice")
    // Tab A restarts and opens its ceremony while tab B still shows the first attempt.
    restartTicketSignupAccount("rp", "link", first.attemptId)
    const second = beginTicketSignupAccount("rp", "link", "alice")
    expect(() => restartTicketSignupAccount("rp", "link", first.attemptId)).toThrow(
      "restarted in another tab",
    )
    expect(loadTicketSignupAttempt("rp", "link")).toEqual(second)
    completeTicketSignupAccount("rp", "link", second.attemptId, account)
    expect(loadTicketSignupAccount("rp", "link")).toEqual({ ...account, tag: "alice" })
  })

  it("an attempt restarted elsewhere cannot be restarted again before its successor is written", () => {
    const first = beginTicketSignupAccount("rp", "link", "alice")
    restartTicketSignupAccount("rp", "link", first.attemptId)
    expect(() => restartTicketSignupAccount("rp", "link", first.attemptId)).toThrow(
      "restarted in another tab",
    )
    expect(loadTicketSignupAttempt("rp", "link")).toBeNull()
  })

  it("continues to read bindings written before creation checkpoints existed", () => {
    saveTicketSignupAccount("rp", "link", account)
    expect(loadTicketSignupAccount("rp", "link")).toEqual(account)
    expect(loadTicketSignupAccount("other-rp", "link")).toBeNull()
    expect(loadTicketSignupAccount("rp", "other-link")).toBeNull()
  })
})
