// @vitest-environment node
// The link codec's byte checks need one realm, which jsdom splits.
import { describe, expect, it } from "vitest"
import { Fr } from "@aztec-labs/aztec.js/fields"
import { DEFAULT_CONTRACTS } from "@obsidion/core/constants"
import { memoryBackend, openDatabase } from "@obsidion/front-core"
import { encodePaylinkInline } from "@obsidion/sdk"
import { deviceState } from "../../../../src/platform/storage/deviceKeys"
import {
  beginTicketSignupAccount,
  boundToTicketSignup,
  completeTicketSignupAccount,
  loadTicketSignupAccount,
  loadTicketSignupAttempt,
  restartTicketSignupAccount,
  saveTicketSignupAccount,
} from "../../../../src/features/paylink/ticketSignupAccount"
import { rememberTicketSpent, ticketKnownSpent } from "../../../../src/features/paylink/ticketSpent"

const account = { credentialId: "created-passkey", l2Address: `0x${"ab".repeat(32)}` }

async function page(seeded: [string, string][] = []) {
  const backend = memoryBackend(new Map(seeded))
  const database = openDatabase(backend)
  const device = deviceState(database)
  await device.load()
  return { backend, own: { database, device } }
}

describe("ticket signup creation checkpoints", () => {
  it("an interrupted attempt cannot be mistaken for an account or a new signup", async () => {
    const { own } = await page()
    const attempt = await beginTicketSignupAccount(own, "rp", "link", "alice")
    expect(loadTicketSignupAttempt(own, "rp", "link")).toEqual(attempt)
    expect(() => loadTicketSignupAccount(own, "rp", "link")).toThrow()
    await expect(beginTicketSignupAccount(own, "rp", "link", "bob")).rejects.toThrow()
  })

  it("begins again only once the restart has landed", async () => {
    const { own } = await page()
    const first = await beginTicketSignupAccount(own, "rp", "link", "alice")
    const restarting = restartTicketSignupAccount(own, "rp", "link", first.attemptId)
    const second = beginTicketSignupAccount(own, "rp", "link", "bob")
    await restarting
    const begun = await second
    await expect(
      completeTicketSignupAccount(own, "rp", "link", first.attemptId, account),
    ).rejects.toThrow()
    expect(loadTicketSignupAttempt(own, "rp", "link")).toEqual(begun)
  })

  it("restarts only the attempt the caller saw, and binds the one that follows", async () => {
    const { own } = await page()
    const first = await beginTicketSignupAccount(own, "rp", "link", "alice")
    await restartTicketSignupAccount(own, "rp", "link", first.attemptId)
    const second = await beginTicketSignupAccount(own, "rp", "link", "alice")
    await expect(restartTicketSignupAccount(own, "rp", "link", first.attemptId)).rejects.toThrow()
    await completeTicketSignupAccount(own, "rp", "link", second.attemptId, account)
    expect(loadTicketSignupAccount(own, "rp", "link")).toEqual({ ...account, tag: "alice" })
    await expect(restartTicketSignupAccount(own, "rp", "link", second.attemptId)).rejects.toThrow()
  })

  it("leaves the slot as it was when the save fails", async () => {
    const { backend, own } = await page()
    backend.failing.commits = true
    await expect(beginTicketSignupAccount(own, "rp", "link", "alice")).rejects.toThrow()
    await expect(saveTicketSignupAccount(own, "rp", "link", account)).rejects.toThrow()
    backend.failing.commits = false
    expect(loadTicketSignupAttempt(own, "rp", "link")).toBeNull()
  })

  it("is unknown until the device keys load, and then reads what was saved", async () => {
    const backend = memoryBackend(
      new Map([["obsidion.ticket-signup.account:rp:link", JSON.stringify(account)]]),
    )
    const database = openDatabase(backend)
    const own = { database, device: deviceState(database) }
    expect(() => loadTicketSignupAttempt(own, "rp", "link")).toThrow()
    expect(() => boundToTicketSignup(own, "rp", account.credentialId)).toThrow()
    await own.device.load()
    expect(loadTicketSignupAccount(own, "rp", "link")).toEqual(account)
  })
})

describe("boundToTicketSignup", () => {
  it("names only a completed binding's passkey on its own rpId", async () => {
    const { own } = await page()
    const attempt = await beginTicketSignupAccount(own, "rp", "link", "alice")
    expect(boundToTicketSignup(own, "rp", account.credentialId)).toBe(false)
    await completeTicketSignupAccount(own, "rp", "link", attempt.attemptId, account)
    expect(boundToTicketSignup(own, "rp", account.credentialId)).toBe(true)
    expect(boundToTicketSignup(own, "rp", "another-passkey")).toBe(false)
    expect(boundToTicketSignup(own, "other-rp", account.credentialId)).toBe(false)
  })
})

describe("ticketKnownSpent", () => {
  const link = (n: bigint) =>
    encodePaylinkInline({
      secret: new Fr(n),
      paylinkType: DEFAULT_CONTRACTS.paylinkDirect,
      fallbackKeyHash: new Fr(1n),
      classId: new Fr(2n),
      chainId: 1,
      rollupVersion: 1,
    })

  it("knows a refused link's ticket as spent, by identity alone, and no other link's", async () => {
    const { backend, own } = await page()
    expect(ticketKnownSpent(own.device.get(), link(7n))).toBe(false)
    await rememberTicketSpent(own, link(7n))
    await rememberTicketSpent(own, "undecodable")
    expect(ticketKnownSpent(own.device.get(), link(7n))).toBe(true)
    expect(ticketKnownSpent(own.device.get(), link(8n))).toBe(false)
    expect(ticketKnownSpent(own.device.get(), "undecodable")).toBe(false)
    expect(backend.entries.get("obsidion.ticket-spent")).not.toContain(link(7n))
  })
})
